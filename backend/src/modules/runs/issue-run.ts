import type { Agent, Issue, Run } from '../../db/schema';
import { storage } from '../../storage/layout';
import { listComments } from '../issues/comments.service';
import { getProviderCredentials } from '../providers/providers.service';
import { resolveApiModel, type ApiProtocol } from '../runner/api-turn';
import { executeApiToolLoop } from '../runner/api-tool-loop';
import { buildControlPlaneToolDefs } from './control-plane';
import {
  lowerPermission,
  runTurn,
  RunnerError,
  RUNTIME_CODE_CAPABILITIES,
  type TurnRequest,
  type TurnResult,
} from '../runner/runner';
import {
  captureRunChanges,
  getProjectRepository,
  resolveExecutionWorkspace,
  snapshotBeforeRun,
  type ResolvedWorkspace,
} from '../code-workspaces/workspace.service';
import { addSystemComment } from '../issues/comments.service';
import { buildIssueRunPrompt, buildReviewRunPrompt } from '../runner/turn-context';
import type { CliRuntime } from '../agents/runtime-detect';
import { config } from '../../config';
import { issueRunToken } from './run-token';

const ISSUE_RUN_TIMEOUT_MS = 15 * 60_000;

/** Runtimes that can mount the platform MCP server for the turn. */
const MCP_RUNTIMES: ReadonlySet<string> = new Set(['claude-code']);

type TurnExecutor = (request: TurnRequest) => Promise<TurnResult>;
let turnExecutor: TurnExecutor = runTurn;

/** Test seam: swap the CLI executor without spawning real processes. */
export function setIssueTurnExecutorForTests(executor: TurnExecutor | null): void {
  turnExecutor = executor ?? runTurn;
}

export interface IssueTurnOutcome {
  text: string;
  sessionRef: string | null;
}

/**
 * One agent turn against an issue: build the prompt from the issue context
 * and run it in the project workspace. Locking, run-state transitions, and
 * the timeline comment are the wake service's job, not this function's.
 */
export async function executeIssueTurn(run: Run, agent: Agent, issue: Issue): Promise<IssueTurnOutcome> {
  const credentials = agent.providerId
    ? await getProviderCredentials(run.userId, agent.providerId)
    : null;

  const comments = (await listComments(run.userId, issue.id)).map((c) => ({
    author: c.authorType,
    body: c.body,
  }));

  // A repository binding switches the run into the issue's isolated worktree;
  // without one the legacy shared project workspace remains in effect.
  const codeWorkspace = await resolveCodeWorkspace(run, agent, issue);
  const workspace = codeWorkspace
    ? codeWorkspace.workspace.worktreePath
    : storage.projectWorkspace(run.userId, issue.projectId);

  // The api lane gets the same tools in-process.
  const mcpCapable = MCP_RUNTIMES.has(agent.runtime);
  const hasControlPlane = agent.runtime === 'api' || mcpCapable;

  const buildPrompt = run.trigger === 'review' ? buildReviewRunPrompt : buildIssueRunPrompt;
  const prompt = buildPrompt({
    agent,
    issueNumber: issue.issueNumber,
    title: issue.title,
    description: issue.description,
    status: issue.status,
    reason: run.reason,
    comments,
    workspace,
    controlPlane: hasControlPlane ? 'mcp' : 'report',
  });

  if (agent.runtime === 'api') {
    if (!credentials) {
      throw new RunnerError(
        `Agent "${agent.name}" needs an OpenAI or Anthropic provider configured`,
        'api_failed'
      );
    }
    const result = await executeApiToolLoop({
      protocol: credentials.vendor as ApiProtocol,
      apiKey: credentials.apiKey,
      baseUrl: credentials.baseUrl,
      model: resolveApiModel(agent, credentials.vendor as ApiProtocol),
      system:
        agent.manifest.api?.systemPrompt ?? `You are ${agent.name}. ${agent.description}`.trim(),
      prompt,
      tools: buildControlPlaneToolDefs({ run, agent, issue }),
      timeoutMs: ISSUE_RUN_TIMEOUT_MS,
    });
    return { text: result.text, sessionRef: null };
  }

  const paths = storage.agentPaths(run.userId, agent.id);
  const controlPlane = mcpCapable
    ? { url: config.mcpUrl(), token: issueRunToken(run.id) }
    : undefined;
  // The agent level is a ceiling: review turns are always forced to read-only.
  const permission =
    run.trigger === 'review'
      ? lowerPermission(agent.permissionLevel, 'read_only')
      : agent.permissionLevel;

  const before = codeWorkspace ? await snapshotBeforeRun(codeWorkspace.workspace) : null;
  try {
    const result = await turnExecutor({
      runtime: agent.runtime as CliRuntime,
      workspace,
      stateDir: paths.state,
      prompt,
      model: agent.model,
      credentials: credentials ?? undefined,
      sessionRef: null,
      timeoutMs: ISSUE_RUN_TIMEOUT_MS,
      permission,
      mcp: controlPlane,
      extraEnv: controlPlane
        ? { SWARMDEV_MCP_URL: controlPlane.url, SWARMDEV_RUN_TOKEN: controlPlane.token }
        : undefined,
    });
    return { text: result.text, sessionRef: result.sessionRef ?? null };
  } finally {
    // Git evidence is captured on success, failure, and cancellation alike;
    // a capture problem is logged, never allowed to mask the run outcome.
    if (codeWorkspace && before) {
      await settleRunCapture(run, issue, codeWorkspace, before, permission).catch((err) => {
        console.error(`Run ${run.id} change capture failed:`, err);
      });
    }
  }
}

/**
 * Fails visibly when the agent cannot actually operate on the bound
 * repository; compatibility is checked before any worktree is created.
 */
async function resolveCodeWorkspace(
  run: Run,
  agent: Agent,
  issue: Issue
): Promise<ResolvedWorkspace | null> {
  const repository = await getProjectRepository(run.userId, issue.projectId);
  if (!repository) return null;

  if (agent.runtime === 'api') {
    // API agents have no filesystem execution; a textual review is fine, a
    // worker assignment on a code project is not.
    if (run.trigger !== 'review') {
      throw new RunnerError(
        `Agent "${agent.name}" is API-hosted and cannot edit code; assign a CLI runtime`,
        'cli_failed'
      );
    }
    return null;
  }

  const capability = RUNTIME_CODE_CAPABILITIES[agent.runtime as CliRuntime];
  if (!capability || capability.codeWorkspace === 'disabled') {
    throw new RunnerError(
      `Runtime "${agent.runtime}" is not supported for code workspaces`,
      'cli_failed'
    );
  }
  return resolveExecutionWorkspace(run.userId, issue);
}

async function settleRunCapture(
  run: Run,
  issue: Issue,
  codeWorkspace: ResolvedWorkspace,
  before: Awaited<ReturnType<typeof snapshotBeforeRun>>,
  permission: 'read_only' | 'edit' | 'full'
): Promise<void> {
  const { snapshot, policyViolation } = await captureRunChanges({
    runId: run.id,
    userId: run.userId,
    workspace: codeWorkspace.workspace,
    before,
    permission,
  });
  if (policyViolation) {
    await addSystemComment(
      run.userId,
      issue.id,
      `Read-only policy violation: tracked files changed during a read-only run (${snapshot.changedFiles} files).`
    );
  } else if (snapshot.changedFiles > 0) {
    await addSystemComment(
      run.userId,
      issue.id,
      `Code changes captured: ${snapshot.changedFiles} file(s), +${snapshot.additions}/-${snapshot.deletions} on ${codeWorkspace.workspace.branchName}.`
    );
  }
}
