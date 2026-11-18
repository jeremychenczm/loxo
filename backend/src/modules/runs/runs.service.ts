import { and, asc, desc, eq, getTableColumns, isNull, lte, or, sql } from 'drizzle-orm';
import { config } from '../../config';
import { db, type Executor } from '../../db/client';
import { agents, runs, type Run, type RunStatus, type RunTrigger } from '../../db/schema';
import { notFound } from '../../http/errors';
import { crashPoint } from '../ownership/crash-points';
import { instanceId } from '../ownership/instance';

/**
 * Statuses that hold the agent claim and the task lock. The partial unique
 * indexes runs_one_running_per_agent/_task enforce them; keep both in step.
 */
export const GATE_HOLDING_STATUSES = ['running'] as const satisfies readonly RunStatus[];

const GATE_INDEXES = new Set(['runs_one_running_per_agent', 'runs_one_running_per_task']);

export interface CreateRunInput {
  agentId: string;
  agentName: string;
  taskId?: string | null;
  trigger: RunTrigger;
  reason?: string;
  model?: string | null;
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

export interface Admission {
  run: Run;
  /** Lease time left, measured on the database clock right after the claim. */
  leaseRemainingMs: number;
}

export async function createQueuedRun(userId: string, input: CreateRunInput): Promise<Run> {
  const [run] = await db
    .insert(runs)
    .values({
      userId,
      agentId: input.agentId,
      agentName: input.agentName,
      taskId: input.taskId ?? null,
      trigger: input.trigger,
      reason: input.reason ?? '',
      model: input.model ?? null,
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

function isGateConflict(err: unknown): boolean {
  const pgErr = ((err as { cause?: unknown })?.cause ?? err) as { code?: string; constraint?: string };
  return pgErr.code === '23505' && GATE_INDEXES.has(pgErr.constraint ?? '');
}

/**
 * Starts a queued run. One statement flips it to running, takes the next
 * epoch, and sets the lease on the database clock; the gate indexes make that
 * same statement the agent claim and the task lock, so a held gate surfaces
 * as a unique violation and the run stays queued with nothing written.
 * Returns undefined when the run is no longer queued, is backing off, or a
 * gate is held.
 */
export async function admitRun(runId: string, executor: Executor = db): Promise<Admission | undefined> {
  try {
    return await executor.transaction(async (tx) => {
      const [row] = await tx
        .update(runs)
        .set({
          status: 'running',
          ownerInstance: instanceId,
          ownerEpoch: sql`${runs.ownerEpoch} + 1`,
          leaseExpiresAt: sql`clock_timestamp() + ${config.runLeaseTtlMs}::integer * interval '1 millisecond'`,
          startedAt: sql`clock_timestamp()`,
        })
        .where(and(eq(runs.id, runId), eq(runs.status, 'queued'), promotable()))
        .returning({
          ...getTableColumns(runs),
          leaseRemainingMs: sql<string>`extract(epoch from ${runs.leaseExpiresAt} - clock_timestamp()) * 1000`,
        });
      if (!row) return undefined;
      crashPoint('admission.after_claim');
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
 * Settles a running run in one transaction. Leaving `running` is what frees
 * the agent claim and the task lock (the gate indexes cover running rows
 * only); the agent's display status follows in the same commit. Returns
 * undefined when the run was no longer running.
 */
export async function settleRun(
  runId: string,
  outcome: RunOutcome,
  agentStatus: 'idle' | 'error',
  executor: Executor = db
): Promise<Run | undefined> {
  return executor.transaction(async (tx) => {
    const [run] = await tx
      .update(runs)
      .set({ ...outcomeColumns(outcome), leaseExpiresAt: null })
      .where(and(eq(runs.id, runId), eq(runs.status, 'running')))
      .returning();
    if (!run) return undefined;
    if (run.agentId) {
      await tx
        .update(agents)
        .set({ status: agentStatus, lastActiveAt: new Date(), updatedAt: new Date() })
        .where(eq(agents.id, run.agentId));
    }
    return run;
  });
}

/** Fails a run that never started; it holds no gates. */
export async function failQueuedRun(runId: string, error: string, executor: Executor = db): Promise<void> {
  await executor
    .update(runs)
    .set(outcomeColumns({ status: 'failed', error }))
    .where(and(eq(runs.id, runId), eq(runs.status, 'queued')));
}

/** The queued run a new wake for this agent and task should join, if any. */
export async function queuedRunFor(agentId: string, taskId: string): Promise<Run | undefined> {
  const [run] = await db
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
