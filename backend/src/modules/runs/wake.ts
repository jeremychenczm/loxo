import { and, eq } from 'drizzle-orm';
import { db, type Executor } from '../../db/client';
import { agents, tasks, type Agent, type Task, type Run, type RunTrigger } from '../../db/schema';
import { badRequest } from '../../http/errors';
import { addAgentTurn, runHasAgentTurns } from '../tasks/turns.service';
import { RunnerError } from '../runner/runner';
import { executeTaskTurn } from './task-run';
import {
  cancelStaleRun,
  createQueuedRun,
  failQueuedRun,
  nextQueuedRunForAgent,
  nextQueuedRunForGate,
  queuedRunFor,
  settleRun,
  type RunOutcome,
} from './runs.service';
import { crashPoint } from '../ownership/crash-points';
import { fence, FencedError } from '../ownership/fence';
import { handOffRun } from '../ownership/handoff';
import { OwnershipLostError, runLeases, type RunOwnership } from '../ownership/lease';
import { advanceAfterRunEnded, noteRunEnded } from '../workshop/dispatch-end';
import { executePlatformRun, notePlatformRunEnded, type PlatformRunEnding } from '../workshop/platform-ops';

export type WakeAdmission = 'started' | 'queued' | 'merged';

export interface WakeInput {
  agentId: string;
  taskId: string;
  trigger: RunTrigger;
  reason?: string;
}

export interface WakeDecision {
  run: Run;
  admitted: WakeAdmission;
}

/** Abort reason when the database asked this instance to stop a run, as opposed to a shutdown handoff. */
const STOP_REQUESTED = 'stop_requested';

/** In-flight executions, awaitable by tests. */
const settling = new Set<Promise<void>>();

/** The runs this instance executes, each with the signal that hands it off. */
const handoffs = new Map<string, AbortController>();

/** Admissions still waiting on the database; each may yet start a run here. */
const admitting = new Set<Promise<unknown>>();

/** Test seam: resolves once every started run has settled and promoted. */
export async function drainRunsForTests(): Promise<void> {
  while (settling.size > 0) {
    await Promise.all([...settling]);
  }
}

/**
 * Hands off every run this instance executes and resolves once each has
 * ended: a turn already finishing settles as usual, any other is stopped and
 * continued by a follow-up run another instance (or this one, restarted)
 * starts (see handOffRun). Call after runLeases.drain(), so nothing new
 * starts here meanwhile.
 */
export async function handOffActiveRuns(): Promise<void> {
  while (handoffs.size > 0 || admitting.size > 0) {
    for (const handoff of handoffs.values()) handoff.abort();
    await Promise.all([...settling, ...[...admitting].map((admission) => admission.catch(() => {}))]);
  }
}

/**
 * The single admission surface for agent wake-ups. Every trigger source
 * (assignment, manual nudge, review) calls this and nothing else.
 *
 * Agent and task must exist and be owned by the caller. A wake joins a run
 * already queued for the same agent and task (merged); otherwise it becomes a
 * new queued run that starts at once if the agent and the task are both free,
 * or waits for promotion. A running run never absorbs a wake: its prompt is
 * already built, and if its owner has died the wake would die with it.
 */
export async function requestWake(userId: string, input: WakeInput): Promise<WakeDecision> {
  const { run, merged } = await enqueueWake(db, userId, input);
  if (merged) return { run, admitted: 'merged' };
  const started = await tryStartRun(run);
  return { run: started ?? run, admitted: started ? 'started' : 'queued' };
}

/**
 * Records a wake through `ex` as a queued run, joining the one already queued
 * for the same agent and task. Inside a caller's transaction this is the
 * outbox: the run commits together with the write that asked for it, and if
 * the process dies before starting it, the reconciler promotes it.
 */
export async function enqueueWake(
  ex: Executor,
  userId: string,
  input: WakeInput
): Promise<{ run: Run; merged: boolean }> {
  const [agent] = await ex
    .select()
    .from(agents)
    .where(and(eq(agents.id, input.agentId), eq(agents.userId, userId)))
    .limit(1);
  if (!agent) throw badRequest('invalid_agent', 'Agent does not exist');

  const [task] = await ex
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, input.taskId), eq(tasks.userId, userId)))
    .limit(1);
  if (!task) throw badRequest('invalid_task', 'Task does not exist');

  // Two racing wakes can both miss this check; the loser then queues a second
  // run behind the winner, which is safe, just not merged.
  const pending = await queuedRunFor(input.agentId, input.taskId, ex);
  if (pending) return { run: pending, merged: true };

  const run = await createQueuedRun(
    userId,
    {
      agentId: agent.id,
      agentName: agent.name,
      taskId: input.taskId,
      trigger: input.trigger,
      reason: input.reason,
    },
    ex
  );
  return { run, merged: false };
}

/**
 * Tries to start runs a committed write queued. One that cannot start now,
 * or is never tried because the process died first, waits for promotion.
 */
export async function startQueuedRuns(queued: Run[]): Promise<void> {
  crashPoint('wake.before_start');
  for (const run of queued) {
    try {
      await tryStartRun(run);
    } catch (error) {
      console.error(`Run ${run.id} could not be started:`, error);
    }
  }
}

/** Starts a queued run if its gates are free; the reconciler's promotion step. */
export async function promoteQueuedRun(run: Run): Promise<boolean> {
  return (await tryStartRun(run)) !== undefined;
}

/**
 * Starts a queued run if its agent and task are free; otherwise it stays
 * queued for a later promotion pass. Admission is a single transaction, so a
 * failure part-way leaves no claim or lock behind.
 */
async function tryStartRun(run: Run): Promise<Run | undefined> {
  // A platform run has no agent by design; an agent run without one lost it to a deletion.
  if (run.actor === 'agent' && !run.agentId) {
    const taskId = await db
      .transaction(async (tx) => {
        await failQueuedRun(run.id, 'Agent no longer exists', tx);
        return noteRunEnded(tx, run.id, { kind: 'settled', status: 'failed' });
      })
      .catch(() => null);
    await advanceAfterRunEnded(taskId);
    return undefined;
  }
  const admission = runLeases.admit(run.id);
  admitting.add(admission);
  let admitted: Awaited<typeof admission>;
  try {
    admitted = await admission;
  } finally {
    admitting.delete(admission);
  }
  if (!admitted) {
    // A queued run whose dispatch or operation is no longer wanted is cancelled rather than left waiting.
    if (run.dispatchId || run.opId) await cancelStaleRun(run.id).catch(() => {});
    return undefined;
  }

  const { run: started, lease } = admitted;
  const handoff = new AbortController();
  // Admitted while a shutdown began: hand it on before its agent starts.
  if (runLeases.draining) handoff.abort();
  // A stop the database asks for (a workshop dispatch out of time, a stopped workshop) uses the same signal.
  lease.stopSignal.addEventListener('abort', () => handoff.abort(STOP_REQUESTED), { once: true });
  handoffs.set(started.id, handoff);
  const settled = performRun(started, lease, handoff.signal).catch((error) => {
    console.error(`Run ${started.id} settlement failed:`, error);
  });
  settling.add(settled);
  void settled.finally(() => {
    settling.delete(settled);
    handoffs.delete(started.id);
  });
  return started;
}

async function performRun(run: Run, lease: RunOwnership, handoff: AbortSignal): Promise<void> {
  try {
    if (run.actor === 'platform') await executeAndSettlePlatform(run, lease, handoff);
    else await executeAndSettle(run, lease, handoff);
  } finally {
    runLeases.release(run.id);
  }
}

async function executeAndSettle(run: Run, lease: RunOwnership, handoff: AbortSignal): Promise<void> {
  let outcome: RunOutcome;
  let report: { taskId: string; agentId: string; text: string } | undefined;
  let completed = false;
  try {
    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, run.agentId!))
      .limit(1);
    const [task] = run.taskId
      ? await db.select().from(tasks).where(eq(tasks.id, run.taskId)).limit(1)
      : [undefined];
    if (!agent || !task) {
      throw new RunnerError('Agent or task disappeared before the run started', 'cli_failed');
    }

    const result = await executeTaskTurn(run, agent as Agent, task as Task, lease, handoff);
    completed = result.ok;
    outcome = {
      status: result.ok ? 'succeeded' : 'failed',
      output: result.text,
      error: result.ok ? null : (result.error ?? `Turn ended: ${result.stopReason}`),
      sessionRef: result.sessionRef,
      transport: result.transport,
      stopReason: result.stopReason,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      costUsd: result.costUsd,
    };
    if (result.ok && result.text.trim()) {
      report = { taskId: task.id, agentId: agent.id, text: result.text };
    }
  } catch (error) {
    const detail = error instanceof RunnerError ? error.message : 'Task run failed unexpectedly';
    // Fenced writes are already logged as fence rejections.
    if (!(error instanceof RunnerError) && !(error instanceof OwnershipLostError) && !(error instanceof FencedError)) {
      console.error(`Run ${run.id} failed:`, error);
    }
    outcome = { status: 'failed', error: detail };
  }

  // Without the lease this instance no longer speaks for the run: no report,
  // no settlement, no promotion. Whoever takes the run over does that.
  if (lease.lost) return;

  const owner = { runId: run.id, epoch: lease.epoch, instance: runLeases.instance };
  const stopRequested = handoff.aborted && handoff.reason === STOP_REQUESTED;
  if (stopRequested && !completed) {
    outcome = {
      ...outcome,
      status: 'cancelled',
      stopReason: 'cancel_requested',
      error: 'Stopped: its workshop dispatch ran out of time or the workshop was stopped',
    };
  }
  if (handoff.aborted && !completed && !stopRequested) {
    // A refused or failed handoff leaves the run to crash recovery once the lease lapses.
    await handOffRun(owner, outcome).catch((error) => {
      if (!(error instanceof FencedError)) console.error(`Run ${run.id} could not be handed off:`, error);
    });
    return;
  }

  // Fallback report: only when the agent said nothing through the control
  // plane during the run. Posted while the run still holds the task, so the
  // next run's prompt sees it. Best-effort — the run result stands regardless.
  if (report && !(await runHasAgentTurns(run.id))) {
    const { taskId, agentId, text } = report;
    await db
      .transaction(async (tx) => {
        await fence(tx, owner, 'fallback_report');
        await addAgentTurn(run.userId, taskId, agentId, text, { runId: run.id, epoch: lease.epoch }, tx);
      })
      .catch(() => {});
  }
  // If settling fails the run keeps its lease and the reconciler takes it over;
  // if it is refused, the run was taken over and its new owner settles it.
  crashPoint('run.before_settle');
  let workshopTask: string | null = null;
  const settled = await db
    .transaction(async (tx) => {
      const row = await settleRun(owner, outcome, outcome.status === 'succeeded' ? 'idle' : 'error', tx);
      if (row) workshopTask = await noteRunEnded(tx, row.id, { kind: 'settled', status: outcome.status });
      return row;
    })
    .catch((error) => {
      console.error(`Run ${run.id} could not be settled:`, error);
      return undefined;
    });
  if (!settled) return;
  crashPoint('run.after_settle');
  await advanceAfterRunEnded(workshopTask);
  await promoteNext(run);
}

/**
 * Executes a platform operation and settles its run. No agent, no timeline
 * entries: the operation's own row records the result. A failure is retried
 * as a new run of the same operation (see notePlatformRunEnded); a shutdown
 * that interrupts the handler hands the operation to a follow-up run.
 */
async function executeAndSettlePlatform(run: Run, lease: RunOwnership, handoff: AbortSignal): Promise<void> {
  let outcome: RunOutcome;
  let ending: PlatformRunEnding;
  try {
    if (handoff.aborted) throw new RunnerError('Handed off before the operation started', 'aborted');
    const result = await executePlatformRun(run, { lease, signal: handoff });
    outcome = { status: 'succeeded' };
    ending = { kind: 'done', result };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    outcome = { status: 'failed', error: detail };
    ending = { kind: 'failed', error: detail };
  }
  if (lease.lost) return;

  const owner = { runId: run.id, epoch: lease.epoch, instance: runLeases.instance };
  if (handoff.aborted && ending.kind !== 'done' && handoff.reason !== STOP_REQUESTED) {
    await handOffRun(owner, outcome).catch((error) => {
      if (!(error instanceof FencedError)) console.error(`Run ${run.id} could not be handed off:`, error);
    });
    return;
  }
  crashPoint('run.before_settle');
  let noted: { taskId: string | null; retry: Run | null } = { taskId: null, retry: null };
  const settled = await db
    .transaction(async (tx) => {
      const row = await settleRun(owner, outcome, 'idle', tx);
      if (row) noted = await notePlatformRunEnded(tx, row, ending);
      return row;
    })
    .catch((error) => {
      console.error(`Run ${run.id} could not be settled:`, error);
      return undefined;
    });
  if (!settled) return;
  crashPoint('run.after_settle');
  await advanceAfterRunEnded(noted.taskId);
  if (noted.retry) await startQueuedRuns([noted.retry]);
  await promoteNext(run);
}

/**
 * After a run settles, try the oldest queued run waiting on the gate it
 * freed, then the oldest waiting on the same agent. Gate failures leave
 * candidates queued for the next settlement.
 */
async function promoteNext(finished: Run): Promise<void> {
  const candidates: Run[] = [];
  if (finished.gateKey) {
    const byGate = await nextQueuedRunForGate(finished.gateKey);
    if (byGate) candidates.push(byGate);
  }
  if (finished.agentId) {
    const byAgent = await nextQueuedRunForAgent(finished.agentId);
    if (byAgent && !candidates.some((c) => c.id === byAgent.id)) candidates.push(byAgent);
  }
  for (const candidate of candidates) {
    await tryStartRun(candidate);
  }
}
