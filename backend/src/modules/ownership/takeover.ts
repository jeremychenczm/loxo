import { and, eq, sql } from 'drizzle-orm';
import { config } from '../../config';
import { db } from '../../db/client';
import { humanRequests, runEvents, runs, type Run } from '../../db/schema';
import { runEventBus, type RunEventFrame } from '../runs/run-events.service';

export interface TakeoverOptions {
  /** Instance recorded as the new owner. */
  instance: string;
  /** Why the run is being taken over; stored as the run error. */
  reason: string;
  /** Lease the new owner gets for the recovery steps. */
  ttlMs?: number;
  /** Take the run even though its lease has not expired (tests and operator tools). */
  force?: boolean;
}

/**
 * Takes a running run away from its owner in one transaction. Locks the run
 * row first, FOR UPDATE: that waits for any owner write transaction holding
 * FOR KEY SHARE to commit, and every later fence or settlement under the old
 * epoch fails. Locking the run row before any other row, as every
 * transaction does, keeps takeover from deadlocking with owner writes.
 *
 * The run stays running under the new owner, with the next epoch and a fresh
 * lease for recovery (see recovery.ts), so it keeps its gates until recovery
 * decides its outcome. A run already in recovery, whose recoverer died, keeps
 * the step it reached. Open questions the run asked (permission requests) are
 * cancelled in the same transaction, so no one answers for an agent that is
 * gone. The takeover is recorded as a run event under the new epoch, in the
 * same transaction: its commit time is the moment the old epoch stopped
 * counting, which the chaos invariant checker compares stale writes against.
 * Returns undefined when the run was not running or its lease was still
 * valid.
 */
export async function takeOverRun(runId: string, options: TakeoverOptions): Promise<Run | undefined> {
  const ttlMs = options.ttlMs ?? config.runLeaseTtlMs;
  const taken = await db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        status: runs.status,
        expired: sql<boolean>`${runs.leaseExpiresAt} IS NULL OR ${runs.leaseExpiresAt} <= clock_timestamp()`,
      })
      .from(runs)
      .where(eq(runs.id, runId))
      .for('update');
    if (!current || current.status !== 'running') return undefined;
    if (!current.expired && !options.force) return undefined;

    const [run] = await tx
      .update(runs)
      .set({
        error: sql`COALESCE(${runs.error}, ${`Owner lost: ${options.reason}`})`,
        ownerInstance: options.instance,
        ownerEpoch: sql`${runs.ownerEpoch} + 1`,
        leaseExpiresAt: sql`clock_timestamp() + ${ttlMs}::integer * interval '1 millisecond'`,
        recoveryStep: sql`COALESCE(${runs.recoveryStep}, 'taken_over')`,
      })
      .where(and(eq(runs.id, runId), eq(runs.status, 'running')))
      .returning();
    if (!run) return undefined;

    await tx
      .update(humanRequests)
      .set({ status: 'cancelled', answeredAt: new Date() })
      .where(and(eq(humanRequests.runId, run.id), eq(humanRequests.status, 'open')));

    // Every writer of this run's events locks the run row first, so seq cannot race here.
    const [event] = await tx
      .insert(runEvents)
      .values({
        runId: run.id,
        epoch: run.ownerEpoch,
        seq: sql`(SELECT COALESCE(MAX(${runEvents.seq}), 0) + 1 FROM ${runEvents} WHERE ${runEvents.runId} = ${run.id})`,
        kind: 'status',
        payload: { message: `Taken over by another instance: ${options.reason}` },
      })
      .returning();
    return { run, event: event! };
  });
  if (!taken) return undefined;

  const { run, event } = taken;
  runEventBus.emit('event', {
    userId: run.userId,
    taskId: run.taskId,
    runId: run.id,
    seq: event.seq,
    kind: event.kind,
    payload: event.payload,
    createdAt: event.createdAt.toISOString(),
  } satisfies RunEventFrame);
  return run;
}
