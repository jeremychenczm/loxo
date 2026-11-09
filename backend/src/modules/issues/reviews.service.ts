import { and, asc, eq } from 'drizzle-orm';
import { db } from '../../db/client';
import {
  agents,
  issueReviews,
  issues,
  type Issue,
  type IssueReview,
  type ReviewDecision,
} from '../../db/schema';
import { badRequest, notFound } from '../../http/errors';
import { getProjectRepository, latestIssueSnapshot } from '../code-workspaces/workspace.service';
import { addAgentComment, addHumanComment } from './comments.service';
import { moveIssue } from './issues.service';

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
   * Agent approvals record a recommendation but leave the issue in review —
   * closing an issue stays a human decision. Rejections always transition.
   */
  applyTransition?: boolean;
}

/** Automated reject cycles allowed per issue before a human must take over. */
export const REVIEW_CYCLE_CAP = 3;

/** Agent-issued changes_requested verdicts on an issue, ever. */
export async function countAgentRejections(issueId: string): Promise<number> {
  const rows = await db
    .select({ id: issueReviews.id })
    .from(issueReviews)
    .where(
      and(
        eq(issueReviews.issueId, issueId),
        eq(issueReviews.reviewerType, 'agent'),
        eq(issueReviews.decision, 'changes_requested')
      )
    );
  return rows.length;
}

const DECISION_LABEL: Record<ReviewDecision, string> = {
  approved: '[APPROVED]',
  changes_requested: '[CHANGES REQUESTED]',
};

async function findOwnedIssue(userId: string, issueId: string): Promise<Issue> {
  const [issue] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.userId, userId)))
    .limit(1);
  if (!issue) throw notFound('Issue not found');
  return issue;
}

/**
 * One review verdict: record it, put the feedback on the timeline, then move
 * the issue. The comment must exist before the transition, because moving to
 * in_progress re-wakes the assignee and the next run reads it.
 */
export async function createReview(
  userId: string,
  issueId: string,
  input: CreateReviewInput,
  options: CreateReviewOptions = {}
): Promise<IssueReview> {
  const issue = await findOwnedIssue(userId, issueId);
  if (issue.status !== 'in_review') {
    throw badRequest('not_in_review', 'Only issues in review can be reviewed');
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
  const codeProject = (await getProjectRepository(userId, issue.projectId)) !== null;
  const changeSnapshotId = codeProject
    ? ((await latestIssueSnapshot(userId, issueId))?.id ?? null)
    : null;

  const [review] = await db
    .insert(issueReviews)
    .values({
      userId,
      issueId,
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
    await addAgentComment(userId, issueId, reviewerAgentId, commentBody);
  } else {
    await addHumanComment(userId, issueId, commentBody);
  }

  // in_review -> done | in_progress are both legal transitions; moving to
  // in_progress re-wakes the assignee through the existing move hook. On a
  // code project an approval never closes the issue by itself: it stays in
  // review until merge or keep-branch succeeds against this snapshot.
  if (options.applyTransition !== false) {
    if (input.decision === 'approved' && codeProject) {
      return review!;
    }
    await moveIssue(userId, issueId, {
      status: input.decision === 'approved' ? 'done' : 'in_progress',
    });
  }

  return review!;
}

export async function listReviews(userId: string, issueId: string): Promise<IssueReview[]> {
  await findOwnedIssue(userId, issueId);
  return db
    .select()
    .from(issueReviews)
    .where(eq(issueReviews.issueId, issueId))
    .orderBy(asc(issueReviews.createdAt));
}
