import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import {
  approvals,
  tasks,
  turns,
  type Approval,
  type ApprovalDecision,
  type Task,
  type Turn,
} from '../../db/schema';
import { badRequest, notFound } from '../../http/errors';
import { latestTaskSnapshot } from '../code-workspaces/workspace.service';
import { moveTask } from './tasks.service';
import { addAgentTurn, addHumanTurn } from './turns.service';

/** Automated reject cycles allowed per task before a human must take over. */
export const REVIEW_CYCLE_CAP = 3;

const DECISION_LABEL: Record<ApprovalDecision, string> = {
  approved: '[APPROVED]',
  changes_requested: '[CHANGES REQUESTED]',
};

/** Report shape of an agent review turn. */
export interface ReviewVerdictReport {
  type: 'review';
  decision: ApprovalDecision;
}

async function findOwnedTask(userId: string, taskId: string): Promise<Task> {
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)))
    .limit(1);
  if (!task) throw notFound('Task not found');
  return task;
}

function assertReviewable(task: Task, body: string): string {
  if (task.status !== 'in_review') {
    throw badRequest('not_in_review', 'Only tasks in review can be reviewed');
  }
  const trimmed = body.trim();
  if (!trimmed) throw badRequest('invalid_input', 'A review must carry a comment');
  return trimmed;
}

/** Agent changes_requested verdicts on a task, ever. */
export async function countAgentRejections(taskId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(turns)
    .where(
      and(
        eq(turns.taskId, taskId),
        eq(turns.kind, 'agent'),
        sql`${turns.report}->>'type' = 'review'`,
        sql`${turns.report}->>'decision' = 'changes_requested'`
      )
    );
  return row?.n ?? 0;
}

/**
 * A person's decision: record it, put it on the timeline, then move the
 * task. The turn lands before the transition because moving to in_progress
 * re-wakes the lead, whose next run reads it. On a code task an approval
 * pins the current fingerprint and leaves the task in review until merge or
 * keep-branch succeeds against it.
 */
export async function recordApproval(
  userId: string,
  taskId: string,
  input: { decision: ApprovalDecision; body: string }
): Promise<Approval> {
  const task = await findOwnedTask(userId, taskId);
  const body = assertReviewable(task, input.body);

  const codeTask = task.repositoryId !== null;
  const snapshot = codeTask ? await latestTaskSnapshot(userId, taskId) : null;

  const [approval] = await db
    .insert(approvals)
    .values({
      taskId,
      userId,
      decision: input.decision,
      body,
      changeSnapshotId: snapshot?.id ?? null,
      fingerprint: snapshot?.changeFingerprint ?? null,
    })
    .returning();

  await addHumanTurn(userId, taskId, `${DECISION_LABEL[input.decision]} ${body}`);

  if (input.decision === 'approved' && codeTask) return approval!;
  await moveTask(userId, taskId, {
    status: input.decision === 'approved' ? 'done' : 'in_progress',
  });
  return approval!;
}

export interface AgentVerdictOptions {
  /** False once the automated-cycle fuse has blown; the verdict is still recorded. */
  reopen?: boolean;
}

/**
 * An agent reviewer's verdict, kept as a turn. Asymmetric authority: a
 * rejection reopens work, an approval only recommends — closing stays human.
 */
export async function recordAgentVerdict(
  userId: string,
  taskId: string,
  input: { agentId: string; runId: string | null; decision: ApprovalDecision; body: string },
  options: AgentVerdictOptions = {}
): Promise<Turn> {
  const task = await findOwnedTask(userId, taskId);
  const body = assertReviewable(task, input.body);
  const report: ReviewVerdictReport = { type: 'review', decision: input.decision };
  const turn = await addAgentTurn(
    userId,
    taskId,
    input.agentId,
    `${DECISION_LABEL[input.decision]} ${body}`,
    { runId: input.runId, report: { ...report } }
  );
  if (input.decision === 'changes_requested' && options.reopen !== false) {
    await moveTask(userId, taskId, { status: 'in_progress' });
  }
  return turn;
}

export async function listApprovals(userId: string, taskId: string): Promise<Approval[]> {
  await findOwnedTask(userId, taskId);
  return db
    .select()
    .from(approvals)
    .where(eq(approvals.taskId, taskId))
    .orderBy(asc(approvals.createdAt));
}
