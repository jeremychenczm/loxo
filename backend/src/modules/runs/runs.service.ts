import { and, asc, desc, eq, getTableColumns, isNull, lte, or, sql } from 'drizzle-orm';
import { config } from '../../config';
import { db, type Executor } from '../../db/client';
import { agents, dispatches, runs, tasks, workspaces, type Run, type RunStatus, type RunTrigger } from '../../db/schema';
import { notFound } from '../../http/errors';
import { crashPoint } from '../ownership/crash-points';
import { FencedError, recordFenceRejection } from '../ownership/fence';
import { instanceId } from '../ownership/instance';

/**
 * Statuses that hold the agent claim and the task lock. The partial unique
 * indexes runs_one_running_per_agent/_task enforce them; keep both in step.
 * An interrupted run keeps its task (a person decides what happens to its
 * work) but frees its agent for other tasks.
 */
export const AGENT_GATE_STATUSES = ['running'] as const satisfies readonly RunStatus[];
export const TASK_GATE_STATUSES = ['running', 'interrupted'] as const satisfies readonly RunStatus[];

const GATE_INDEXES = new Set(['runs_one_running_per_agent', 'runs_one_running_per_task']);

export interface CreateRunInput {
  agentId: string;
  agentName: string;
  taskId?: string | null;
  trigger: RunTrigger;
  reason?: string;
  model?: string | null;
  /** Set when the run picks up after an earlier attempt. */
  parentRunId?: string | null;
  attempt?: number;
  /** Keeps the run from being promoted for this long, measured on the database clock. */
  delayMs?: number;
  /** Defaults to task:<taskId>, the per-task gate legacy runs use. */
  gateKey?: string | null;
  workspaceId?: string | null;
  dispatchId?: string | null;
}

export function taskGateKey(taskId: string): string {
  return `task:${taskId}`;
}

export interface RunOutcome {
  status: Extract<RunStatus, 'succeeded' | 'failed' | 'cancelled'>;
  output?: string;
  error?: string | null;
  sessionRef?: string | null;
  model?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
  /** acp, process, or api. */
  transport?: string | null;
  /** Why the turn ended, as reported by the host. */
  stopReason?: string | null;
}

/** Who may write for a run: the instance and epoch that claimed it. */
export interface RunOwner {
  runId: string;
  epoch: number;
  instance: string;
}

export function ownerOf(run: Pick<Run, 'id' | 'ownerEpoch' | 'ownerInstance'>): RunOwner {
  return { runId: run.id, epoch: run.ownerEpoch, instance: run.ownerInstance ?? '' };
}

export interface Admission {
  run: Run;
  /** Lease time left, measured on the database clock right after the claim. */
  leaseRemainingMs: number;
}

export async function createQueuedRun(userId: string, input: CreateRunInput, ex: Executor = db): Promise<Run> {
  const [run] = await ex
    .insert(runs)
    .values({
      userId,
      agentId: input.agentId,
      agentName: input.agentName,
      taskId: input.taskId ?? null,
      trigger: input.trigger,
      reason: input.reason ?? '',
      model: input.model ?? null,
      parentRunId: input.parentRunId ?? null,
      attempt: input.attempt ?? 1,
      notBefore: input.delayMs ? sql`clock_timestamp() + ${input.delayMs}::integer * interval '1 millisecond'` : null,
      gateKey: input.gateKey !== undefined ? input.gateKey : input.taskId ? taskGateKey(input.taskId) : null,
      workspaceId: input.workspaceId ?? null,
      dispatchId: input.dispatchId ?? null,
    })
    .returning();
  return run!;
}

export async function getRun(userId: string, runId: string): Promise<Run> {
  const [run] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.userId, userId)))
    .limit(1);
  if (!run) throw notFound('Run not found');
  return run;
}

export async function listRuns(
  userId: string,
  filter: { taskId?: string; agentId?: string; status?: RunStatus }
): Promise<Run[]> {
  const conditions = [eq(runs.userId, userId)];
  if (filter.taskId) conditions.push(eq(runs.taskId, filter.taskId));
  if (filter.agentId) conditions.push(eq(runs.agentId, filter.agentId));
  if (filter.status) conditions.push(eq(runs.status, filter.status));
  return db
    .select()
    .from(runs)
    .where(and(...conditions))
    .orderBy(desc(runs.createdAt));
}

/** Queued runs whose back-off, if any, has elapsed. */
const promotable = () => or(isNull(runs.notBefore), lte(runs.notBefore, sql`clock_timestamp()`));

/**
 * The run's worktree is not quarantined: the worktree recorded on the run,
 * or, for a run that has not recorded one yet, any worktree of its task.
 * Checked inside admission so every path (wake, promotion, reconciler) waits
 * instead of starting a run that would collide with a writer that lost its
 * owner. Shared with the reconciler's promotion query.
 */
export const notQuarantined = () =>
  sql`NOT EXISTS (SELECT 1 FROM ${workspaces} w WHERE w.status = 'quarantined' AND (
    w.id = ${runs.workspaceId} OR (${runs.workspaceId} IS NULL AND w.task_id = ${runs.taskId})))`;

/**
 * Records the worktree a run works in once it has one, guarded by ownership
 * like recordBeforeState. Throws FencedError when the run moved on.
 */
export async function recordRunWorkspace(owner: RunOwner, workspaceId: string, executor: Executor = db): Promise<void> {
  const [row] = await executor
    .update(runs)
    .set({ workspaceId })
    .where(
      and(
        eq(runs.id, owner.runId),
        eq(runs.status, 'running'),
        eq(runs.ownerEpoch, owner.epoch),
        eq(runs.ownerInstance, owner.instance)
      )
    )
    .returning({ id: runs.id });
  if (!row) {
    recordFenceRejection('run_workspace', owner.runId, owner.epoch);
    throw new FencedError(owner.runId, owner.epoch, 'run_workspace');
  }
}

/**
 * A workshop run may start only while its dispatch is still wanted: not
 * ended, not told to stop, and still in the task's current phase, cycle and
 * round. Runs without a dispatch always pass.
 */
const dispatchCurrent = () =>
  sql`(${runs.dispatchId} IS NULL OR EXISTS (
    SELECT 1 FROM ${dispatches} d JOIN ${tasks} t ON t.id = d.task_id
    WHERE d.id = ${runs.dispatchId}
      AND d.status IN ('pending', 'running')
      AND d.cancel_requested_at IS NULL
      AND t.phase = d.phase AND t.cycle = d.cycle AND d.round >= t.round))`;

/** Cancels a queued workshop run whose dispatch is no longer current; it never started, so nothing else changes. */
export async function cancelStaleRun(runId: string, executor: Executor = db): Promise<boolean> {
  const rows = await executor
    .update(runs)
    .set({ status: 'cancelled', stopReason: 'stale', error: 'Its workshop moved on before it started', finishedAt: new Date() })
    .where(and(eq(runs.id, runId), eq(runs.status, 'queued'), sql`NOT ${dispatchCurrent()}`))
    .returning({ id: runs.id });
  return rows.length > 0;
}

function isGateConflict(err: unknown): boolean {
  const pgErr = ((err as { cause?: unknown })?.cause ?? err) as { code?: string; constraint?: string };
  return pgErr.code === '23505' && GATE_INDEXES.has(pgErr.constraint ?? '');
}

/**
 * Starts a queued run. One statement flips it to running, takes the next
 * epoch, and sets the lease on the database clock; the gate indexes make that
 * same statement the agent claim and the task lock, so a held gate surfaces
 * as a unique violation and the run stays queued with nothing written.
 * Returns undefined when the run is no longer queued, is backing off, its
 * task's workspace is quarantined, or a gate is held.
 */
export interface AdmitOptions {
  ttlMs?: number;
  /** Owner recorded on the run; tests stand in for other instances with it. */
  instance?: string;
  executor?: Executor;
}

export async function admitRun(runId: string, options: AdmitOptions = {}): Promise<Admission | undefined> {
  const { ttlMs = config.runLeaseTtlMs, instance = instanceId, executor = db } = options;
  try {
    return await executor.transaction(async (tx) => {
      const [row] = await tx
        .update(runs)
        .set({
          status: 'running',
          ownerInstance: instance,
          ownerEpoch: sql`${runs.ownerEpoch} + 1`,
          leaseExpiresAt: sql`clock_timestamp() + ${ttlMs}::integer * interval '1 millisecond'`,
          startedAt: sql`clock_timestamp()`,
        })
        .where(and(eq(runs.id, runId), eq(runs.status, 'queued'), promotable(), notQuarantined(), dispatchCurrent()))
        .returning({
          ...getTableColumns(runs),
          leaseRemainingMs: sql<string>`extract(epoch from ${runs.leaseExpiresAt} - clock_timestamp()) * 1000`,
        });
      if (!row) return undefined;
      crashPoint('admission.after_claim');
      if (row.dispatchId) {
        // The dispatch's clock starts with its first run; follow-up runs keep it going.
        await tx
          .update(dispatches)
          .set({ status: 'running', startedAt: sql`COALESCE(${dispatches.startedAt}, clock_timestamp())`, updatedAt: new Date() })
          .where(and(eq(dispatches.id, row.dispatchId), sql`${dispatches.status} IN ('pending', 'running')`, isNull(dispatches.pausedAt)));
      }
      if (row.agentId) {
        await tx
          .update(agents)
          .set({ status: 'busy', lastActiveAt: new Date(), updatedAt: new Date() })
          .where(eq(agents.id, row.agentId));
      }
      const { leaseRemainingMs, ...run } = row;
      return { run, leaseRemainingMs: Number(leaseRemainingMs) };
    });
  } catch (err) {
    if (isGateConflict(err)) return undefined;
    throw err;
  }
}

function outcomeColumns(outcome: RunOutcome) {
  return {
    status: outcome.status,
    output: outcome.output ?? '',
    error: outcome.error ?? null,
    ...(outcome.sessionRef !== undefined ? { sessionRef: outcome.sessionRef } : {}),
    ...(outcome.model !== undefined ? { model: outcome.model } : {}),
    ...(outcome.tokensIn !== undefined ? { tokensIn: outcome.tokensIn } : {}),
    ...(outcome.tokensOut !== undefined ? { tokensOut: outcome.tokensOut } : {}),
    ...(outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}),
    ...(outcome.transport !== undefined ? { transport: outcome.transport } : {}),
    ...(outcome.stopReason !== undefined ? { stopReason: outcome.stopReason } : {}),
    finishedAt: new Date(),
  };
}

/**
 * Settles a running run in one transaction, fenced: the UPDATE only matches
 * while the run is still running under `owner`'s instance and epoch. Leaving
 * `running` is what frees the agent claim and the task lock (the gate
 * indexes cover running rows only); the agent's display status follows in
 * the same commit. Returns undefined, and records a fence rejection, when the
 * run has moved on: settled already, or taken over.
 */
export async function settleRun(
  owner: RunOwner,
  outcome: RunOutcome,
  agentStatus: 'idle' | 'error',
  executor: Executor = db
): Promise<Run | undefined> {
  return executor.transaction(async (tx) => {
    const [run] = await tx
      .update(runs)
      .set({ ...outcomeColumns(outcome), leaseExpiresAt: null })
      .where(
        and(
          eq(runs.id, owner.runId),
          eq(runs.status, 'running'),
          eq(runs.ownerEpoch, owner.epoch),
          eq(runs.ownerInstance, owner.instance)
        )
      )
      .returning();
    if (!run) {
      recordFenceRejection('settle', owner.runId, owner.epoch);
      return undefined;
    }
    if (run.agentId) {
      await tx
        .update(agents)
        .set({ status: agentStatus, lastActiveAt: new Date(), updatedAt: new Date() })
        .where(eq(agents.id, run.agentId));
    }
    return run;
  });
}

/**
 * Records the pinned before-state on the run, guarded by ownership in the
 * same statement (see settleRun). Throws FencedError when the run moved on.
 */
export async function recordBeforeState(
  owner: RunOwner,
  state: { head: string; tree: string },
  executor: Executor = db
): Promise<void> {
  const [row] = await executor
    .update(runs)
    .set({ beforeHead: state.head, beforeTree: state.tree })
    .where(
      and(
        eq(runs.id, owner.runId),
        eq(runs.status, 'running'),
        eq(runs.ownerEpoch, owner.epoch),
        eq(runs.ownerInstance, owner.instance)
      )
    )
    .returning({ id: runs.id });
  if (!row) {
    recordFenceRejection('before_state', owner.runId, owner.epoch);
    throw new FencedError(owner.runId, owner.epoch, 'before_state');
  }
}

export interface SessionStart {
  sessionRef: string | null;
  launcher: { pid: number; tag: string; host: string } | null;
}

/**
 * Records what a run needs after its owner is gone, as soon as the session
 * opens: the runtime session, so a follow-up run can restore the
 * conversation, and the launcher, so recovery can end what is left of the
 * agent. Guarded like recordBeforeState.
 */
export async function recordSessionStart(owner: RunOwner, start: SessionStart, executor: Executor = db): Promise<void> {
  const [row] = await executor
    .update(runs)
    .set({
      sessionRef: start.sessionRef,
      launcherPid: start.launcher?.pid ?? null,
      launcherTag: start.launcher?.tag ?? null,
      launcherHost: start.launcher?.host ?? null,
    })
    .where(
      and(
        eq(runs.id, owner.runId),
        eq(runs.status, 'running'),
        eq(runs.ownerEpoch, owner.epoch),
        eq(runs.ownerInstance, owner.instance)
      )
    )
    .returning({ id: runs.id });
  if (!row) {
    recordFenceRejection('session_start', owner.runId, owner.epoch);
    throw new FencedError(owner.runId, owner.epoch, 'session_start');
  }
}

/** Fails a run that never started; it holds no gates. */
export async function failQueuedRun(runId: string, error: string, executor: Executor = db): Promise<void> {
  await executor
    .update(runs)
    .set(outcomeColumns({ status: 'failed', error }))
    .where(and(eq(runs.id, runId), eq(runs.status, 'queued')));
}

/** The queued run a new wake for this agent and task should join, if any. */
export async function queuedRunFor(agentId: string, taskId: string, ex: Executor = db): Promise<Run | undefined> {
  const [run] = await ex
    .select()
    .from(runs)
    .where(and(eq(runs.agentId, agentId), eq(runs.taskId, taskId), eq(runs.status, 'queued')))
    .limit(1);
  return run;
}

/** Oldest promotable queued run waiting on a task; promotion order is FIFO. */
export async function nextQueuedRunForTask(taskId: string): Promise<Run | undefined> {
  const [run] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.taskId, taskId), eq(runs.status, 'queued'), promotable()))
    .orderBy(asc(runs.createdAt))
    .limit(1);
  return run;
}

/** Oldest promotable queued run waiting on an agent, across tasks. */
export async function nextQueuedRunForAgent(agentId: string): Promise<Run | undefined> {
  const [run] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.agentId, agentId), eq(runs.status, 'queued'), promotable()))
    .orderBy(asc(runs.createdAt))
    .limit(1);
  return run;
}
