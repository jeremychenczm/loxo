import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../../db/client';
import { dispatchReports, dispatches, runs, tasks, type Dispatch, type DispatchStatus, type Run } from '../../db/schema';
import { isReadOnlyDispatch } from './dispatch-info';

/**
 * How a run of a workshop dispatch ended, from the path that ended it:
 * settled by its owner, continued by a follow-up run (handoff, automatic
 * retry, a person's continue or discard), interrupted and waiting on a
 * person, or abandoned (stopped, expired, out of retries) with no follow-up.
 */
export type RunEnding =
  | { kind: 'settled'; status: 'succeeded' | 'failed' | 'cancelled' }
  | { kind: 'continued' }
  | { kind: 'interrupted' }
  | { kind: 'abandoned' };

/**
 * Called inside every transaction that ends a run. Locks the run row first,
 * which also makes a report still being written commit before it is looked
 * for (the report holds a key-share lock on the run). For a workshop run it
 * then flags the task to advance and records how the dispatch ended; the
 * caller advances after commit. Returns the task to advance, if any.
 */
export async function noteRunEnded(tx: Tx, runId: string, ending: RunEnding): Promise<string | null> {
  const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).for('update');
  if (!run?.dispatchId) return null;
  const [dispatch] = await tx.select().from(dispatches).where(eq(dispatches.id, run.dispatchId));
  if (!dispatch) return null;
  await tx.update(tasks).set({ advancePending: true }).where(eq(tasks.id, dispatch.taskId));
  if (ending.kind === 'continued' || ending.kind === 'interrupted') return dispatch.taskId;

  const [report] = await tx
    .select({ id: dispatchReports.id })
    .from(dispatchReports)
    .where(eq(dispatchReports.dispatchId, dispatch.id));
  const status = endedStatus(dispatch, ending, report !== undefined);
  await tx
    .update(dispatches)
    .set({ status, endedAt: sql`clock_timestamp()`, updatedAt: new Date() })
    .where(and(eq(dispatches.id, dispatch.id), inArray(dispatches.status, ['pending', 'running'])));
  return dispatch.taskId;
}

function endedStatus(dispatch: Dispatch, ending: RunEnding, reported: boolean): DispatchStatus {
  if (reported) return 'reported';
  const cancelled = dispatch.cancelRequestedAt !== null;
  if (cancelled && (ending.kind === 'abandoned' || (ending.kind === 'settled' && ending.status === 'cancelled'))) {
    return isReadOnlyDispatch(dispatch) ? 'skipped' : 'cancelled';
  }
  if (ending.kind === 'settled' && ending.status === 'succeeded') return 'no_report';
  return 'failed';
}

/**
 * Whether a follow-up run may carry the dispatch on. A run without a
 * dispatch always may; a dispatch told to stop, or already ended, may not.
 */
export async function dispatchContinues(tx: Tx, run: Pick<Run, 'dispatchId'>): Promise<boolean> {
  if (!run.dispatchId) return true;
  const [dispatch] = await tx.select().from(dispatches).where(eq(dispatches.id, run.dispatchId));
  return dispatch !== undefined && dispatch.cancelRequestedAt === null && ['pending', 'running'].includes(dispatch.status);
}

/** What a follow-up run copies from the run it continues, so it keeps the dispatch, gate and worktree. */
export function carriedOver(run: Pick<Run, 'dispatchId' | 'gateKey' | 'workspaceId'>) {
  return { dispatchId: run.dispatchId, gateKey: run.gateKey, workspaceId: run.workspaceId };
}

/** Advances a workshop after the transaction that ended one of its runs has committed. */
export async function advanceAfterRunEnded(taskId: string | null): Promise<void> {
  if (!taskId) return;
  const { advanceTask } = await import('./advance');
  await advanceTask(taskId);
}
