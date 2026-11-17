import type { Agent, Task, Run } from '../../db/schema';
import { storage } from '../../storage/layout';
import { getProviderCredentials } from '../providers/providers.service';
import { resolveApiModel, type ApiProtocol } from '../runner/api-protocol';
import { buildControlPlaneToolDefs } from './control-plane';
import {
  lowerPermission,
  RunnerError,
  RUNTIME_CODE_CAPABILITIES,
  type TurnPermission,
} from '../runner/runner';
import {
  captureRunChanges,
  findRepository,
  getTaskWorkspace,
  resolveWorkspace,
  snapshotBeforeRun,
  type ResolvedWorkspace,
} from '../code-workspaces/workspace.service';
import { addSystemTurn, listTurns } from '../tasks/turns.service';
import { buildTaskRunPrompt, buildReviewRunPrompt } from '../runner/turn-context';
import { isAgentRuntime, type CliRuntime } from '../agents/runtimes';
import { config } from '../../config';
import { mintRunToken } from './run-token';
import { AcpHost, HostStartupError } from '../hosts/acp-host';
import { ApiHost } from '../hosts/api-host';
import type { AgentHost, HostMcpServer, HostTransport, TurnStopReason } from '../hosts/host.types';
import { createPermissionArbiter } from '../hosts/permission-arbiter';
import { ProcessHost } from '../hosts/process-host';
import { acpLaunchSpec } from '../hosts/runtime-catalog';
import { withWatchdog } from '../hosts/watchdog';
import { RunEventRecorder } from './run-events.service';

const TASK_RUN_TIMEOUT_MS = 15 * 60_000;

/** Runtimes whose per-turn process can mount the platform MCP server. */
const PROCESS_MCP_RUNTIMES: ReadonlySet<string> = new Set(['claude-code']);

/** Stop reasons that mean the agent finished its turn, even if it hit a limit. */
const COMPLETED: ReadonlySet<TurnStopReason> = new Set(['end_turn', 'max_tokens', 'max_turn_requests']);

/** What a test double needs to stand in for an agent host. */
export interface HostRequest {
  agent: Agent;
  permission: TurnPermission;
}

type HostFactory = (request: HostRequest) => AgentHost;
let hostFactoryForTests: HostFactory | null = null;

/**
 * Test seam: replace host construction for every runtime, so run
 * orchestration is exercised without spawning agents or reaching providers.
 */
export function setTaskHostFactoryForTests(factory: HostFactory | null): void {
  hostFactoryForTests = factory;
}

export interface TaskTurnOutcome {
  ok: boolean;
  text: string;
  error: string | null;
  sessionRef: string | null;
  transport: HostTransport;
  stopReason: TurnStopReason;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
}

/**
 * One agent turn against a task: build the prompt from the task context and
 * run it through the agent's host in the task's workspace. Locking,
 * run-state transitions, and the timeline entry are the wake service's job.
 * Throws RunnerError only when the turn cannot start.
 */
export async function executeTaskTurn(run: Run, agent: Agent, task: Task): Promise<TaskTurnOutcome> {
  // Agents created before a runtime was retired keep their row but cannot run.
  if (!isAgentRuntime(agent.runtime)) {
    throw new RunnerError(
      `Runtime "${agent.runtime}" is no longer supported; switch the agent to Claude Code, Codex, or an API provider`,
      'cli_failed'
    );
  }
  const credentials = agent.providerId
    ? await getProviderCredentials(run.userId, agent.providerId)
    : null;

  const timeline = (await listTurns(run.userId, task.id)).map((t) => ({
    author: t.kind,
    body: t.content,
  }));

  // A repository binding switches the run into the task's isolated worktree;
  // without one the agent works in its own workspace.
  const codeWorkspace = await resolveCodeWorkspace(run, agent, task);
  const agentWorkspace = storage.agentPaths(run.userId, agent.id).workspace;
  const workspace = codeWorkspace ? codeWorkspace.workspace.worktreePath : agentWorkspace;

  // The agent level is a ceiling: review turns are always forced to read-only.
  const permission: TurnPermission =
    run.trigger === 'review'
      ? lowerPermission(agent.permissionLevel, 'read_only')
      : agent.permissionLevel;

  const launch =
    agent.runtime === 'api' || hostFactoryForTests
      ? null
      : acpLaunchSpec(agent.runtime as CliRuntime, { credentials, model: agent.model, permission });
  const controlPlaneMounted =
    agent.runtime === 'api' ||
    hostFactoryForTests !== null ||
    launch !== null ||
    PROCESS_MCP_RUNTIMES.has(agent.runtime);

  const buildPrompt = run.trigger === 'review' ? buildReviewRunPrompt : buildTaskRunPrompt;
  const prompt = buildPrompt({
    agent,
    taskNumber: task.number,
    title: task.title,
    brief: task.brief,
    status: task.status,
    reason: run.reason,
    timeline,
    workspace,
    controlPlane: controlPlaneMounted ? 'mcp' : 'report',
  });

  const runToken = mintRunToken(run.id);
  const mcpServers: HostMcpServer[] = controlPlaneMounted
    ? [{ type: 'http', name: 'swarmdev', url: config.mcpUrl(), headers: { Authorization: `Bearer ${runToken}` } }]
    : [];

  let host: AgentHost;
  let readRoot = workspace;
  if (hostFactoryForTests) {
    host = hostFactoryForTests({ agent, permission });
  } else if (agent.runtime === 'api') {
    if (!credentials) {
      throw new RunnerError(
        `Agent "${agent.name}" needs an OpenAI or Anthropic provider configured`,
        'api_failed'
      );
    }
    // A reviewer reads the task's worktree when there is one, never its own scratch space.
    const taskWorkspace = await getTaskWorkspace(run.userId, task.id);
    if (taskWorkspace) readRoot = taskWorkspace.worktreePath;
    host = new ApiHost({
      protocol: credentials.vendor as ApiProtocol,
      apiKey: credentials.apiKey,
      baseUrl: credentials.baseUrl,
      model: resolveApiModel(agent, credentials.vendor as ApiProtocol),
      system: agent.manifest.api?.systemPrompt ?? `You are ${agent.name}. ${agent.description}`.trim(),
      turnTimeoutMs: TASK_RUN_TIMEOUT_MS,
      repo: { baseCommit: taskWorkspace?.baseCommit ?? null, workspaceId: taskWorkspace?.id ?? null, taskId: task.id },
      extraTools: buildControlPlaneToolDefs({ run, agent, task }),
    });
  } else if (launch) {
    host = new AcpHost(launch);
  } else {
    host = new ProcessHost({
      runtime: agent.runtime as CliRuntime,
      stateDir: storage.agentPaths(run.userId, agent.id).state,
      credentials: credentials ?? undefined,
      permission,
      turnTimeoutMs: TASK_RUN_TIMEOUT_MS,
      extraEnv: controlPlaneMounted
        ? { SWARMDEV_MCP_URL: config.mcpUrl(), SWARMDEV_RUN_TOKEN: runToken }
        : undefined,
    });
  }

  const recorder = new RunEventRecorder({ id: run.id, userId: run.userId, taskId: task.id });
  const before = codeWorkspace ? await snapshotBeforeRun(codeWorkspace.workspace) : null;
  try {
    let session;
    try {
      session = await host.openSession({
        cwd: readRoot,
        mcpServers,
        model: agent.model,
        arbiter: createPermissionArbiter({
          context: { permission, workspaceRoot: readRoot },
          taskId: task.id,
          agentId: agent.id,
        }),
      });
    } catch (err) {
      if (err instanceof HostStartupError) {
        throw new RunnerError(err.message, err.reason === 'timeout' ? 'timeout' : 'cli_failed');
      }
      throw err;
    }
    // A process per turn reports only at the end; the runner's own timeout guards it.
    const supervised = host.transport === 'process' ? session : withWatchdog(session);
    try {
      const outcome = await supervised.prompt({ prompt, onEvent: (event) => recorder.record(event) });
      return {
        ok: COMPLETED.has(outcome.stopReason),
        text: outcome.text,
        error: outcome.error,
        sessionRef: session.runtimeSessionId,
        transport: host.transport,
        stopReason: outcome.stopReason,
        tokensIn: outcome.usage.inputTokens,
        tokensOut: outcome.usage.outputTokens,
        costUsd: outcome.usage.costUsd,
      };
    } finally {
      await supervised.close();
    }
  } finally {
    await recorder.flush();
    // Git evidence is captured on success, failure, and cancellation alike;
    // a capture problem is logged, never allowed to mask the run outcome.
    if (codeWorkspace && before) {
      await settleRunCapture(run, task, codeWorkspace, before, permission).catch((err) => {
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
  task: Task
): Promise<ResolvedWorkspace | null> {
  const repository = await findRepository(run.userId, task.repositoryId);
  if (!repository) return null;

  if (agent.runtime === 'api') {
    // API agents have no filesystem execution; a textual review is fine, a
    // worker assignment on a code task is not.
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
  return resolveWorkspace(run.userId, task);
}

async function settleRunCapture(
  run: Run,
  task: Task,
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
    await addSystemTurn(
      run.userId,
      task.id,
      `Read-only policy violation: tracked files changed during a read-only run (${snapshot.changedFiles} files).`
    );
  } else if (snapshot.changedFiles > 0) {
    await addSystemTurn(
      run.userId,
      task.id,
      `Code changes captured: ${snapshot.changedFiles} file(s), +${snapshot.additions}/-${snapshot.deletions} on ${codeWorkspace.workspace.branchName}.`
    );
  }
}
