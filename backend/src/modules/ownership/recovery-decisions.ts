import { and, eq, inArray, lte, or, sql } from 'drizzle-orm';
import { db, type Tx } from '../../db/client';
import { humanRequests, runs, type HumanRequest, type Run } from '../../db/schema';
import { badRequest, conflict } from '../../http/errors';
import {
  getTaskWorkspace,
  leaveQuarantine,
  settleWorkspaceForDecision,
  type ObservedWorkspace,
} from '../code-workspaces/workspace.service';
import { createQueuedRun } from '../runs/runs.service';
import { startQueuedRuns } from '../runs/wake';
import { addSystemTurn } from '../tasks/turns.service';

/**
 * A person's answer to an interrupted run's retry request. Git work happens
 * first and can be repeated; the answer, the run's final state, the
 * workspace leaving quarantine, and the follow-up run then commit together,
 * and only while the request is still open and the run still interrupted.
 *
 *   choice    run          workspace                        follow-up run
 *   continue  failed       observed state (changes kept)    queued: same agent and trigger,
 *   discard   failed       before-state, observed state       parent_run_id, attempt + 1
 *   stop      cancelled    stays quarantined                none
 *
 * The task's status never changes; an expired request counts as stop.
 */
export async function decideInterruptedRun(
  userId: string,
  request: HumanRequest,
  input: { choice: string; note?: string }
): Promise<HumanRequest> {
  if (!request.choices.includes(input.choice)) {
    throw badRequest('invalid_choice', `Choose one of: ${request.choices.join(', ')}`);
  }
  const closed = () => conflict('request_closed', 'This request is no longer open');
  // Checked before any Git work, so a late discard cannot wipe changes and then be refused.
  if (request.status !== 'open' || !request.runId) throw closed();
  if (request.expiresAt && request.expiresAt.getTime() <= Date.now()) throw closed();
  const [run] = await db.select().from(runs).where(eq(runs.id, request.runId));
  if (!run || run.status !== 'interrupted') throw closed();

  const choice = input.choice as 'continue' | 'discard' | 'stop';
  const workspace = run.taskId ? await getTaskWorkspace(userId, run.taskId) : null;
  let observed: ObservedWorkspace | null = null;
  if (choice !== 'stop' && workspace) {
    const discardTo =
      choice === 'discard' && run.beforeHead && run.beforeTree ? { head: run.beforeHead, tree: run.beforeTree } : null;
    if (choice === 'discard' && !discardTo) throw badRequest('invalid_choice', 'The run has no before-state to discard to');
    observed = await settleWorkspaceForDecision(userId, workspace, discardTo);
  }

  const { answered, queued } = await db.transaction(async (tx) => {
    const [answered] = await tx
      .update(humanRequests)
      .set({
        status: 'answered',
        answer: { choice, ...(input.note ? { note: input.note } : {}) },
        answeredAt: new Date(),
      })
      .where(
        and(
          eq(humanRequests.id, request.id),
          eq(humanRequests.status, 'open'),
          sql`(${humanRequests.expiresAt} IS NULL OR ${humanRequests.expiresAt} > now())`
        )
      )
      .returning();
    if (!answered) throw closed();
    const decided = await closeInterruptedRun(tx, run.id, choice === 'stop' ? 'cancelled' : 'failed', OUTCOME[choice]);
    if (!decided) throw closed();

    if (observed && workspace) await leaveQuarantine(tx, workspace.id, observed);
    const queued: Run[] = [];
    if (choice !== 'stop' && run.agentId) {
      queued.push(
        await createQueuedRun(
          userId,
          {
            agentId: run.agentId,
            agentName: run.agentName,
            taskId: run.taskId,
            trigger: run.trigger,
            reason: followUpReason(run, choice),
            parentRunId: run.id,
            attempt: run.attempt + 1,
          },
          tx
        )
      );
    }
    if (run.taskId) {
      await addSystemTurn(userId, run.taskId, `Interrupted run by ${run.agentName}: ${DECISION_NOTE[choice]}`, {}, tx);
    }
    return { answered, queued };
  });
  await startQueuedRuns(queued);
  return answered;
}

const OUTCOME = {
  continue: 'Interrupted; continued in a new run',
  discard: 'Interrupted; its changes were discarded and the run queued again',
  stop: 'Interrupted; stopped by a person',
} as const;

const DECISION_NOTE = {
  continue: 'continued in a new run on the current worktree.',
  discard: 'worktree restored to its before-state; the run starts again from there.',
  stop: 'stopped. The workspace stays quarantined until it is reconciled or abandoned.',
} as const;

function followUpReason(run: Run, choice: 'continue' | 'discard'): string {
  const state =
    choice === 'continue'
      ? 'Whatever it changed is still in the worktree; check it before building on it.'
      : 'Its worktree changes were discarded, so the worktree is as it was before that turn.';
  return `Your previous turn on this task was interrupted before it finished. ${state}${run.reason ? `\n\n${run.reason}` : ''}`;
}

async function closeInterruptedRun(
  tx: Tx,
  runId: string,
  status: 'failed' | 'cancelled',
  error: string
): Promise<Run | undefined> {
  const [row] = await tx
    .update(runs)
    .set({ status, error, finishedAt: new Date() })
    .where(and(eq(runs.id, runId), eq(runs.status, 'interrupted')))
    .returning();
  return row;
}

/**
 * Stops interrupted runs whose retry request expired unanswered. Idempotent:
 * each run moves only while it is still interrupted.
 */
export async function stopExpiredDecisions(): Promise<string[]> {
  const overdue = await db
    .select({ requestId: humanRequests.id, runId: runs.id, userId: runs.userId, taskId: runs.taskId, agentName: runs.agentName })
    .from(humanRequests)
    .innerJoin(runs, eq(runs.id, humanRequests.runId))
    .where(
      and(
        eq(humanRequests.kind, 'retry'),
        eq(runs.status, 'interrupted'),
        or(
          eq(humanRequests.status, 'expired'),
          and(eq(humanRequests.status, 'open'), lte(humanRequests.expiresAt, sql`now()`))
        )
      )
    );
  const stopped: string[] = [];
  for (const row of overdue) {
    const done = await db.transaction(async (tx) => {
      await tx
        .update(humanRequests)
        .set({ status: 'expired' })
        .where(and(eq(humanRequests.id, row.requestId), inArray(humanRequests.status, ['open', 'expired'])));
      const decided = await closeInterruptedRun(tx, row.runId, 'cancelled', 'Interrupted; stopped when its retry request expired');
      if (decided && row.taskId) {
        await addSystemTurn(
          row.userId,
          row.taskId,
          `Interrupted run by ${row.agentName}: no decision before the request expired, so it was stopped. The workspace stays quarantined until it is reconciled or abandoned.`,
          {},
          tx
        );
      }
      return decided !== undefined;
    });
    if (done) stopped.push(row.runId);
  }
  return stopped;
}
