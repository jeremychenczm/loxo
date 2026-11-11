import { and, asc, eq } from 'drizzle-orm';
import { db } from '../../db/client';
import {
  agents,
  taskReviews,
  tasks,
  type Task,
  type TaskReview,
  type ReviewDecision,
} from '../../db/schema';
import { badRequest, notFound } from '../../http/errors';
import { getProjectRepository, latestTaskSnapshot } from '../code-workspaces/workspace.service';
import { addAgentComment, addHumanComment } from './comments.service';
import { moveTask } from './tasks.service';

export interface CreateReviewInput {
  decision: ReviewDecision;
  body: string;
  /** Exactly one principal; humans must be the account owner. */
  reviewer: { userId: string } | { agentId: string };
  /** Review run that produced this verdict, for agent reviewers. */
  runId?: string | null;
}

export interface CreateReviewOptions {
  /**
   * Agent approvals record a recommendation but leave the task in review —
   * closing a task stays a human decision. Rejections always transition.
   */
  applyTransition?: boolean;
}

/** Automated reject cycles allowed per task before a human must take over. */
export const REVIEW_CYCLE_CAP = 3;

/** Agent-taskd changes_requested verdicts on a task, ever. */
export async function countAgentRejections(taskId: string): Promise<number> {
  const rows = await db
    .select({ id: taskReviews.id })
    .from(taskReviews)
    .where(
      and(
        eq(taskReviews.taskId, taskId),
        eq(taskReviews.reviewerType, 'agent'),
        eq(taskReviews.decision, 'changes_requested')
      )
    );
  return rows.length;
}

const DECISION_LABEL: Record<ReviewDecision, string> = {
  approved: '[APPROVED]',
  changes_requested: '[CHANGES REQUESTED]',
};

async function findOwnedTask(userId: string, taskId: string): Promise<Task> {
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)))
    .limit(1);
  if (!task) throw notFound('Task not found');
  return task;
}

/**
 * One review verdict: record it, put the feedback on the timeline, then move
 * the task. The comment must exist before the transition, because moving to
 * in_progress re-wakes the assignee and the next run reads it.
 */
export async function createReview(
  userId: string,
  taskId: string,
  input: CreateReviewInput,
  options: CreateReviewOptions = {}
): Promise<TaskReview> {
  const task = await findOwnedTask(userId, taskId);
  if (task.status !== 'in_review') {
    throw badRequest('not_in_review', 'Only tasks in review can be reviewed');
  }
  const body = input.body.trim();
  if (!body) throw badRequest('invalid_input', 'A review must carry a comment');

  let reviewerAgentId: string | null = null;
  let reviewerUserId: string | null = null;
  if ('agentId' in input.reviewer) {
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, input.reviewer.agentId), eq(agents.userId, userId)))
      .limit(1);
    if (!agent) throw badRequest('invalid_reviewer', 'Agent does not exist');
    reviewerAgentId = agent.id;
  } else {
    if (input.reviewer.userId !== userId) {
      throw badRequest('invalid_reviewer', 'Only the account owner can review');
    }
    reviewerUserId = userId;
  }

  // Code projects: the verdict applies to an exact captured change set. A
  // later workspace change makes an approval stale without another status.
  const codeProject = (await getProjectRepository(userId, task.projectId)) !== null;
  const changeSnapshotId = codeProject
    ? ((await latestTaskSnapshot(userId, taskId))?.id ?? null)
    : null;

  const [review] = await db
    .insert(taskReviews)
    .values({
      userId,
      taskId,
      reviewerType: reviewerAgentId ? 'agent' : 'human',
      reviewerAgentId,
      reviewerUserId,
      runId: input.runId ?? null,
      changeSnapshotId,
      decision: input.decision,
      body,
    })
    .returning();

  const commentBody = `${DECISION_LABEL[input.decision]} ${body}`;
  if (reviewerAgentId) {
    await addAgentComment(userId, taskId, reviewerAgentId, commentBody);
  } else {
    await addHumanComment(userId, taskId, commentBody);
  }

  // in_review -> done | in_progress are both legal transitions; moving to
  // in_progress re-wakes the assignee through the existing move hook. On a
  // code project an approval never closes the task by itself: it stays in
  // review until merge or keep-branch succeeds against this snapshot.
  if (options.applyTransition !== false) {
    if (input.decision === 'approved' && codeProject) {
      return review!;
    }
    await moveTask(userId, taskId, {
      status: input.decision === 'approved' ? 'done' : 'in_progress',
    });
  }

  return review!;
}

export async function listReviews(userId: string, taskId: string): Promise<TaskReview[]> {
  await findOwnedTask(userId, taskId);
  return db
    .select()
    .from(taskReviews)
    .where(eq(taskReviews.taskId, taskId))
    .orderBy(asc(taskReviews.createdAt));
}
