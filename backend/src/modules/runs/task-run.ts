import os from 'node:os';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { runs, type Agent, type Task, type Run } from '../../db/schema';
import { storage } from '../../storage/layout';
import { getProviderCredentials } from '../providers/providers.service';
import { resolveApiModel, type ApiProtocol } from '../runner/api-protocol';
import { CONTROL_PLANE_SERVER } from '../control-plane/names';
import { buildControlPlaneToolDefs } from '../control-plane/tools';
import {
  lowerPermission,
  RunnerError,
  type TurnPermission,
} from '../runner/runner';
import {
  captureRunChanges,
  findRepository,
  getWorkspace,
  resolveWorkspace,
  runWorkspace,
  snapshotBeforeRun,
  type ResolvedWorkspace,
} from '../code-workspaces/workspace.service';
import { addSystemTurn, listTurns } from '../tasks/turns.service';
import { buildTaskRunPrompt, buildReviewRunPrompt } from '../runner/turn-context';
import { isAgentRuntime, type CliRuntime } from '../agents/runtimes';
import { config } from '../../config';
import { mintRunToken } from '../control-plane/run-token';
import { AcpHost, HostStartupError } from '../hosts/acp-host';
import { ApiHost } from '../hosts/api-host';
import type { AgentHost, HostMcpServer, HostTransport, TurnStopReason } from '../hosts/host.types';
import { createPermissionArbiter } from '../hosts/permission-arbiter';
import { acpLaunchSpec, resolveAcpAdapter } from '../hosts/runtime-catalog';
import { withWatchdog } from '../hosts/watchdog';
import { RunEventRecorder } from './run-events.service';
import { recordRunWorkspace, recordSessionStart } from './runs.service';
import { crashPoint } from '../ownership/crash-points';
import { FencedError } from '../ownership/fence';
import { runLeases, type RunLease } from '../ownership/lease';
import { HttpError } from '../../http/errors';
import { dispatchOf, isReadOnlyDispatch } from '../workshop/dispatch-info';

const TASK_RUN_TIMEOUT_MS = 15 * 60_000;

/** Prepended when a run picks up after an earlier attempt whose conversation could not be restored. */
export const CONTEXT_LOST_NOTE =
  'Note: this run picks up after an earlier attempt on this task, but that conversation could not be restored, so you are starting without its context. Re-read the task timeline and the worktree before acting.';


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
 *
 * Runs under `lease`. Losing it aborts startup, kills the session's process
 * tree at once (no cancel-and-wait), and skips every later write: events,
 * change capture, and the outcome itself (OwnershipLostError).
 *
 * `handoff` stops the turn so the run can be handed off while the lease is
 * still held: startup is abandoned, or the agent is asked to cancel and is
 * killed if it has not stopped after the handoff grace. Events and change
 * capture are still written.
 */
export async function executeTaskTurn(
  run: Run,
  agent: Agent,
  task: Task,
  lease: RunLease,
  handoff?: AbortSignal
): Promise<TaskTurnOutcome> {
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
  lease.assertHeld();
  const agentWorkspace = storage.agentPaths(run.userId, agent.id).workspace;
  const workspace = codeWorkspace ? codeWorkspace.workspace.worktreePath : agentWorkspace;

  // The agent level is a ceiling: review turns and read-only workshop phases are forced to read-only.
  const readOnly =
    run.trigger === 'review' || (run.dispatchId !== null && isReadOnlyDispatch(await dispatchOf(run.dispatchId)));
  const permission: TurnPermission = readOnly
    ? lowerPermission(agent.permissionLevel, 'read_only')
    : agent.permissionLevel;

  const launch =
    agent.runtime === 'api' || hostFactoryForTests
      ? null
      : acpLaunchSpec(agent.runtime as CliRuntime, { credentials, model: agent.model, permission });

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
  });

  const runToken = mintRunToken(run.id, lease.epoch);
  const mcpServers: HostMcpServer[] = [
    { type: 'http', name: CONTROL_PLANE_SERVER, url: config.mcpUrl(), headers: { Authorization: `Bearer ${runToken}` } },
  ];

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
    // A reviewer reads the run's worktree (or its task's) when there is one, never its own scratch space.
    const taskWorkspace = await runWorkspace(run);
    if (taskWorkspace) readRoot = taskWorkspace.worktreePath;
    host = new ApiHost({
      protocol: credentials.vendor as ApiProtocol,
      apiKey: credentials.apiKey,
      baseUrl: credentials.baseUrl,
      model: resolveApiModel(agent, credentials.vendor as ApiProtocol),
      system: agent.manifest.api?.systemPrompt ?? `You are ${agent.name}. ${agent.description}`.trim(),
      turnTimeoutMs: TASK_RUN_TIMEOUT_MS,
      repo: { baseCommit: taskWorkspace?.baseCommit ?? null },
      extraTools: buildControlPlaneToolDefs({ run, epoch: lease.epoch, agent, task }),
    });
  } else {
    if (!launch) {
      const resolution = resolveAcpAdapter(agent.runtime as CliRuntime);
      throw new RunnerError(
        resolution.available ? `No ACP launch spec for ${agent.runtime}` : resolution.reason,
        'cli_failed'
      );
    }
    host = new AcpHost(launch);
  }

  const recorder = new RunEventRecorder({
    id: run.id,
    userId: run.userId,
    taskId: task.id,
    epoch: lease.epoch,
    instance: runLeases.instance,
  });
  const owner = { runId: run.id, epoch: lease.epoch, instance: runLeases.instance };
  const before = codeWorkspace ? await snapshotBeforeRun(owner, codeWorkspace.workspace) : null;
  // API agents keep no conversation between runs; their prompt carries the timeline.
  const picksUp = run.parentRunId !== null && agent.runtime !== 'api';
  const resumeSessionId = picksUp ? await parentSessionRef(run, agent) : null;
  const stopRecording = () => recorder.stop();
  lease.signal.addEventListener('abort', stopRecording, { once: true });
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
          runId: run.id,
        }),
        resumeSessionId,
        signal: handoff ? AbortSignal.any([lease.signal, handoff]) : lease.signal,
      });
    } catch (err) {
      lease.assertHeld();
      if (err instanceof HostStartupError) {
        throw new RunnerError(err.message, err.reason === 'timeout' ? 'timeout' : 'cli_failed');
      }
      throw err;
    }
    const opened = session;
    const killOnLoss = () => void opened.close();
    lease.signal.addEventListener('abort', killOnLoss, { once: true });
    // From here on the session is closed however this turn ends.
    const supervised = withWatchdog(session);
    let handoffKill: NodeJS.Timeout | undefined;
    const stopForHandoff = () => {
      void supervised.cancel().catch(() => {});
      handoffKill = setTimeout(() => void opened.close(), config.runHandoffGraceMs);
    };
    handoff?.addEventListener('abort', stopForHandoff, { once: true });
    try {
      crashPoint('run.after_spawn_before_pid_recorded');
      const started = opened.processIdentity;
      await recordSessionStart(owner, {
        sessionRef: opened.runtimeSessionId,
        launcher:
          started?.pid && started.tag ? { pid: started.pid, tag: started.tag, host: os.hostname() } : null,
      });
      if (picksUp) {
        recorder.record({
          kind: 'status',
          message: opened.resumed
            ? `Restored the earlier conversation (${opened.resumedBy ?? 'resume'})`
            : 'Could not restore the earlier conversation; started a new one',
        });
      }
      const turnPrompt = picksUp && !opened.resumed ? `${CONTEXT_LOST_NOTE}\n\n${prompt}` : prompt;
      lease.assertHeld();
      if (handoff?.aborted) throw new RunnerError('Handed off before the turn started', 'aborted');
      const outcome = await supervised.prompt({ prompt: turnPrompt, onEvent: (event) => recorder.record(event) });
      lease.assertHeld();
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
      lease.signal.removeEventListener('abort', killOnLoss);
      handoff?.removeEventListener('abort', stopForHandoff);
      clearTimeout(handoffKill);
      await supervised.close();
    }
  } finally {
    lease.signal.removeEventListener('abort', stopRecording);
    // Git evidence is captured on success, failure, and cancellation alike;
    // a capture problem is logged, never allowed to mask the run outcome.
    // A run that lost its lease writes neither.
    if (!lease.lost) await recorder.flush();
    if (codeWorkspace && before) {
      crashPoint('run.before_capture');
      if (!lease.lost) {
        await settleRunCapture(run, lease.epoch, task, codeWorkspace, before, permission).catch((err) => {
          // A fenced capture is already logged as a fence rejection.
          if (!(err instanceof FencedError)) console.error(`Run ${run.id} change capture failed:`, err);
        });
      }
    }
  }
}

/** The earlier attempt's session, when the same agent held it. */
async function parentSessionRef(run: Run, agent: Agent): Promise<string | null> {
  const [parent] = await db
    .select({ agentId: runs.agentId, sessionRef: runs.sessionRef })
    .from(runs)
    .where(eq(runs.id, run.parentRunId!));
  return parent && parent.agentId === agent.id ? parent.sessionRef : null;
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

  // A workshop dispatch works in the worktree the engine chose for it; legacy runs prepare their task's.
  if (run.dispatchId && run.workspaceId) {
    const workspace = await getWorkspace(run.workspaceId);
    if (!workspace || (workspace.status !== 'ready' && workspace.status !== 'dirty')) {
      throw new RunnerError(
        workspace?.lastError ?? `The run's worktree is ${workspace?.status ?? 'gone'}; reconcile it before running`,
        'cli_failed'
      );
    }
    return { workspace, repository };
  }
  try {
    const resolved = await resolveWorkspace(run.userId, task);
    if (resolved) {
      await recordRunWorkspace(
        { runId: run.id, epoch: run.ownerEpoch, instance: runLeases.instance },
        resolved.workspace.id
      );
    }
    return resolved;
  } catch (err) {
    if (err instanceof HttpError && err.code === 'workspace_unavailable') {
      throw new RunnerError(err.message, 'cli_failed');
    }
    throw err;
  }
}

async function settleRunCapture(
  run: Run,
  epoch: number,
  task: Task,
  codeWorkspace: ResolvedWorkspace,
  before: Awaited<ReturnType<typeof snapshotBeforeRun>>,
  permission: 'read_only' | 'edit' | 'full'
): Promise<void> {
  await captureRunChanges({
    runId: run.id,
    epoch,
    instance: runLeases.instance,
    userId: run.userId,
    workspace: codeWorkspace.workspace,
    before,
    permission,
    // The evidence turn commits with the snapshot it describes, under the same fence.
    onCaptured: async (tx, { snapshot, policyViolation }) => {
      const note = policyViolation
        ? `Read-only policy violation: tracked files changed during a read-only run (${snapshot.changedFiles} files).`
        : snapshot.changedFiles > 0
          ? `Code changes captured: ${snapshot.changedFiles} file(s), +${snapshot.additions}/-${snapshot.deletions} on ${codeWorkspace.workspace.currentBranch ?? 'a detached worktree'}.`
          : null;
      if (note) await addSystemTurn(run.userId, task.id, note, { runId: run.id, epoch }, tx);
    },
  });
}
