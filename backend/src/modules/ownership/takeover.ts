import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { agents, runs, type Run } from '../../db/schema';

export interface TakeoverOptions {
  /** Instance recorded as the new owner. */
  instance: string;
  /** Why the run is being taken over; stored as the run error. */
  reason: string;
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
 * D1 ends a taken-over run as failed; leaving `running` frees its agent claim
 * and task lock. Returns undefined when the run was not running or its lease
 * was still valid.
 */
export async function takeOverRun(runId: string, options: TakeoverOptions): Promise<Run | undefined> {
  return db.transaction(async (tx) => {
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
        status: 'failed',
        error: `Owner lost: ${options.reason}`,
        ownerInstance: options.instance,
        ownerEpoch: sql`${runs.ownerEpoch} + 1`,
        leaseExpiresAt: null,
        finishedAt: new Date(),
      })
      .where(and(eq(runs.id, runId), eq(runs.status, 'running')))
      .returning();
    if (!run) return undefined;

    if (run.agentId) {
      await tx.update(agents).set({ status: 'error', updatedAt: new Date() }).where(eq(agents.id, run.agentId));
    }
    return run;
  });
}
