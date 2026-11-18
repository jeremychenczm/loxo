import { eq } from 'drizzle-orm';
import type { Executor } from '../../db/client';
import { runs } from '../../db/schema';

/** A write was refused because the run now belongs to another owner or epoch. */
export class FencedError extends Error {
  constructor(
    readonly runId: string,
    readonly epoch: number,
    readonly operation: string
  ) {
    super(`Run ${runId} epoch ${epoch} is fenced; ${operation} refused`);
    this.name = 'FencedError';
  }
}

let rejections = 0;

/**
 * Logs a refused write as one structured line. The count is per process; the
 * chaos harness (D5) keeps the durable record outside the database.
 */
export function recordFenceRejection(operation: string, runId: string, epoch: number): void {
  rejections += 1;
  console.warn(JSON.stringify({ event: 'fence_rejected', operation, runId, epoch }));
}

export function fenceRejectionsForTests(): number {
  return rejections;
}

/**
 * First statement of an owner's write transaction: confirms the run is still
 * running under this owner and epoch, and holds FOR KEY SHARE on the run row
 * until commit. A takeover needs FOR UPDATE on the same row, so it waits for
 * this transaction to finish; renewals take FOR NO KEY UPDATE, which does not
 * conflict, so they never wait on it. Lock the run row before any other row.
 */
export async function fence(
  tx: Executor,
  lease: { runId: string; epoch: number; instance: string },
  operation: string
): Promise<void> {
  const [row] = await tx
    .select({ epoch: runs.ownerEpoch, owner: runs.ownerInstance, status: runs.status })
    .from(runs)
    .where(eq(runs.id, lease.runId))
    .for('key share');
  if (!row || row.status !== 'running' || row.epoch !== lease.epoch || row.owner !== lease.instance) {
    recordFenceRejection(operation, lease.runId, lease.epoch);
    throw new FencedError(lease.runId, lease.epoch, operation);
  }
}
