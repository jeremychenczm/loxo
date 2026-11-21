import { sql } from 'drizzle-orm';
import { db } from '../../db/client';
import type { Run } from '../../db/schema';
import { readRunEffects } from '../runs/run-effects';
import { createQueuedRun, settleRun, type RunOutcome, type RunOwner } from '../runs/runs.service';
import { addSystemTurn } from '../tasks/turns.service';
import { crashPoint } from './crash-points';

export const HANDOFF_STOP_REASON = 'handoff';

/**
 * Ends a run whose live owner is shutting down, in one transaction fenced on
 * the owner's epoch: an instance that has lost the run cannot mark it handed
 * off, so a handoff always means the owner stopped the agent and captured its
 * changes itself.
 *
 * A run that already committed its terminal call (its result or review) has
 * done its work and settles as succeeded, as recovery treats it. Any other
 * run ends cancelled and is continued by a follow-up queued in the same
 * transaction. Nothing about it is uncertain, unlike after a crash, so the
 * follow-up starts without a person's decision; it keeps the attempt number
 * (a handoff is not a failure) and restores the agent's session when the
 * runtime can. Returns the follow-up, if one was queued.
 */
export async function handOffRun(owner: RunOwner, outcome: RunOutcome): Promise<Run | undefined> {
  crashPoint('handoff.before_commit');
  const { ended, followUp } = await db.transaction(async (tx) => {
    // Locked first, so a control-plane call still in flight commits before the
    // effects are read, and any later one is refused by its fence.
    await tx.execute(sql`SELECT 1 FROM runs WHERE id = ${owner.runId} FOR UPDATE`);
    const finished = (await readRunEffects(owner.runId, tx)).terminal !== null;
    const ended = await settleRun(
      owner,
      finished
        ? { ...outcome, status: 'succeeded', stopReason: HANDOFF_STOP_REASON, error: null }
        : { ...outcome, status: 'cancelled', stopReason: HANDOFF_STOP_REASON, error: 'Handed off: its backend shut down' },
      'idle',
      tx
    );
    if (!ended) return { ended: false, followUp: undefined };
    if (finished || !ended.agentId) {
      if (ended.taskId) {
        await addSystemTurn(
          ended.userId,
          ended.taskId,
          `Run by ${ended.agentName} was stopped when its backend shut down${finished ? ', after it had submitted its result' : ''}.`,
          { runId: ended.id, epoch: owner.epoch },
          tx
        );
      }
      return { ended: true, followUp: undefined };
    }
    const next = await createQueuedRun(
      ended.userId,
      {
        agentId: ended.agentId,
        agentName: ended.agentName,
        taskId: ended.taskId,
        trigger: ended.trigger,
        reason: continuationReason(ended),
        parentRunId: ended.id,
        attempt: ended.attempt,
      },
      tx
    );
    if (ended.taskId) {
      await addSystemTurn(
        ended.userId,
        ended.taskId,
        `Run by ${ended.agentName} was handed off because its backend shut down; it continues in a new run.`,
        { runId: ended.id, epoch: owner.epoch },
        tx
      );
    }
    return { ended: true, followUp: next };
  });
  if (ended) crashPoint('handoff.after_commit');
  return followUp;
}

const CONTINUATION =
  'Your previous turn on this task was stopped because the platform restarted, not because of anything you did. Whatever it changed is still in the worktree; continue from where it left off.';

/** The run's own reason after the note, which a run handed off more than once carries only once. */
function continuationReason(run: Run): string {
  const reason = run.reason.startsWith(CONTINUATION) ? run.reason.slice(CONTINUATION.length).trim() : run.reason;
  return reason ? `${CONTINUATION}\n\n${reason}` : CONTINUATION;
}
