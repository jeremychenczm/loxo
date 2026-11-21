import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { runs, workspaces, type Run } from '../../db/schema';
import { promoteQueuedRun } from '../runs/wake';
import type { LeaseKeeper } from './lease';
import { recoverRun } from './recovery';
import { stopExpiredDecisions } from './recovery-decisions';
import { takeOverRun } from './takeover';

export interface ReconcileResult {
  takenOver: string[];
  /** Interrupted runs stopped because their retry request expired. */
  stopped: string[];
  promoted: string[];
}

/**
 * One reconciler pass. Every step is a conditional statement or a single
 * transaction, so passes can overlap, repeat, or run on several instances.
 *
 * 1. Take over running runs whose lease expired: each in its own transaction
 *    (see takeOverRun), after fencing locally if this instance owned it, then
 *    drive it through recovery (see recovery.ts). A run whose recoverer died
 *    expires again and is resumed here.
 * 2. Stop interrupted runs whose retry request expired unanswered.
 * 3. Promote queued runs whose agent and task are free, oldest first,
 *    skipping tasks whose workspace is quarantined.
 */
export async function reconcileOnce(keeper: LeaseKeeper): Promise<ReconcileResult> {
  const result: ReconcileResult = { takenOver: [], stopped: [], promoted: [] };

  const expired = await db
    .select({ id: runs.id, owner: runs.ownerInstance })
    .from(runs)
    .where(
      and(
        eq(runs.status, 'running'),
        or(isNull(runs.leaseExpiresAt), lte(runs.leaseExpiresAt, sql`clock_timestamp()`))
      )
    );
  for (const candidate of expired) {
    // An instance can find its own run expired after an event-loop stall or
    // a sleep; it stops acting for the run before anyone takes it over.
    if (candidate.owner === keeper.instance) {
      keeper.get(candidate.id)?.lose('lease expired before it was renewed');
    }
    const taken = await takeOverRun(candidate.id, {
      instance: keeper.instance,
      reason: 'lease expired',
      ttlMs: keeper.ttlMs,
    }).catch((err) => {
      console.error(`Takeover of run ${candidate.id} failed:`, err);
      return undefined;
    });
    if (!taken) continue;
    result.takenOver.push(taken.id);
    await recoverRun(taken).catch((err) => console.error(`Recovery of run ${taken.id} stopped:`, err));
  }

  result.stopped = await stopExpiredDecisions().catch((err) => {
    console.error('Stopping runs with expired retry decisions failed:', err);
    return [];
  });

  for (const run of await promotableRuns()) {
    if (await promoteQueuedRun(run)) result.promoted.push(run.id);
  }
  return result;
}

/**
 * Queued runs that could start now: back-off elapsed, both gates free (see
 * AGENT_GATE_STATUSES and TASK_GATE_STATUSES), and no quarantined workspace
 * on their task.
 */
async function promotableRuns(): Promise<Run[]> {
  return db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.status, 'queued'),
        or(isNull(runs.notBefore), lte(runs.notBefore, sql`clock_timestamp()`)),
        sql`NOT EXISTS (SELECT 1 FROM runs r WHERE r.status = 'running' AND r.agent_id = ${runs.agentId})`,
        sql`NOT EXISTS (SELECT 1 FROM runs r WHERE r.status IN ('running', 'interrupted') AND r.task_id = ${runs.taskId})`,
        sql`NOT EXISTS (SELECT 1 FROM ${workspaces} w WHERE w.task_id = ${runs.taskId} AND w.status = 'quarantined')`
      )
    )
    .orderBy(asc(runs.createdAt));
}

/**
 * Runs a pass at start-up and then every ttl/2 plus jitter. The returned
 * function stops the loop and resolves once a pass in flight has finished.
 */
export function startReconciler(keeper: LeaseKeeper): () => Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let pass: Promise<void> = Promise.resolve();
  const loop = () => {
    pass = reconcileOnce(keeper).then(
      () => schedule(),
      (err) => {
        console.error('Reconciler pass failed:', err);
        schedule();
      }
    );
  };
  const schedule = () => {
    if (stopped) return;
    const jitter = Math.random() * keeper.ttlMs * 0.1;
    timer = setTimeout(loop, keeper.ttlMs / 2 + jitter);
    timer.unref();
  };
  loop();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await pass;
  };
}
