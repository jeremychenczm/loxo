import { db } from '../../db/client';
import type { Run } from '../../db/schema';
import { createQueuedRun, settleRun, type RunOutcome, type RunOwner } from '../runs/runs.service';
import { addSystemTurn } from '../tasks/turns.service';
import { crashPoint } from './crash-points';

export const HANDOFF_STOP_REASON = 'handoff';

/**
 * Ends a run whose live owner is shutting down and queues the run that
 * continues it, in one transaction fenced on the owner's epoch: an instance
 * that has lost the run cannot mark it handed off, so a handoff always means
 * the owner stopped the agent and captured its changes itself.
 *
 * Unlike recovery after a crash, nothing about the run is uncertain, so the
 * follow-up starts without a person's decision. It keeps the attempt number
 * (a handoff is not a failure) and restores the agent's session when the
 * runtime can. Returns the follow-up, or undefined when the run had moved on
 * or its agent no longer exists.
 */
export async function handOffRun(owner: RunOwner, outcome: RunOutcome): Promise<Run | undefined> {
  crashPoint('handoff.before_commit');
  const followUp = await db.transaction(async (tx) => {
    const ended = await settleRun(
      owner,
      { ...outcome, status: 'cancelled', stopReason: HANDOFF_STOP_REASON, error: 'Handed off: its backend shut down' },
      'idle',
      tx
    );
    if (!ended?.agentId) return undefined;
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
    return next;
  });
  if (followUp) crashPoint('handoff.after_commit');
  return followUp;
}

const CONTINUATION =
  'Your previous turn on this task was stopped because the platform restarted, not because of anything you did. Whatever it changed is still in the worktree; continue from where it left off.';

/** The run's own reason after the note, which a run handed off more than once carries only once. */
function continuationReason(run: Run): string {
  const reason = run.reason.startsWith(CONTINUATION) ? run.reason.slice(CONTINUATION.length).trim() : run.reason;
  return reason ? `${CONTINUATION}\n\n${reason}` : CONTINUATION;
}
