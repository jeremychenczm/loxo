import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { agents, humanRequests, runs, workspaces, type Run, type WorkspaceStatus } from '../../db/schema';

export interface TakeoverOptions {
  /** Instance recorded as the new owner. */
  instance: string;
  /** Why the run is being taken over; stored as the run error. */
  reason: string;
  /** Take the run even though its lease has not expired (tests and operator tools). */
  force?: boolean;
}

/** Workspace states a lost writer can leave behind and that a new run could pick up. */
const LIVE_WORKSPACE: WorkspaceStatus[] = ['preparing', 'ready', 'dirty', 'conflicted', 'missing', 'error'];

/**
 * Takes a running run away from its owner in one transaction. Locks the run
 * row first, FOR UPDATE: that waits for any owner write transaction holding
 * FOR KEY SHARE to commit, and every later fence or settlement under the old
 * epoch fails. Locking the run row before any other row, as every
 * transaction does, keeps takeover from deadlocking with owner writes.
 *
 * In the same transaction:
 * - open questions the run asked (permission requests) are cancelled, so no
 *   one answers for an agent that is gone;
 * - if the run could write the task's worktree, the workspace is quarantined:
 *   the old agent process may still be alive (orphan cleanup comes later), so
 *   no new writer is let in until a person reconciles the workspace.
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

    await tx
      .update(humanRequests)
      .set({ status: 'cancelled', answeredAt: new Date() })
      .where(and(eq(humanRequests.runId, run.id), eq(humanRequests.status, 'open')));

    const [agent] = run.agentId
      ? await tx
          .select({ runtime: agents.runtime, permissionLevel: agents.permissionLevel })
          .from(agents)
          .where(eq(agents.id, run.agentId))
      : [];
    const couldWrite =
      agent !== undefined && agent.runtime !== 'api' && run.trigger !== 'review' && agent.permissionLevel !== 'read_only';
    if (couldWrite && run.taskId) {
      await tx
        .update(workspaces)
        .set({
          status: 'quarantined',
          lastError: `Run ${run.id} lost its owner while it could write here; reconcile the workspace before running again`,
          updatedAt: new Date(),
        })
        .where(and(eq(workspaces.taskId, run.taskId), inArray(workspaces.status, LIVE_WORKSPACE)));
    }

    if (run.agentId) {
      await tx.update(agents).set({ status: 'error', updatedAt: new Date() }).where(eq(agents.id, run.agentId));
    }
    return run;
  });
}
