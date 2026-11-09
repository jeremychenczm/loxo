import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import {
  agents,
  issues,
  projects,
  users,
  type Issue,
  type IssueStatus,
} from '../../db/schema';
import { badRequest, conflict, notFound } from '../../http/errors';
import { hasActiveWorkspaces } from '../code-workspaces/workspace.service';
import { getOrCreateDefaultProject } from '../projects/projects.service';
import { requestWake } from '../runs/wake';
import { isTransitionAllowed, TERMINAL_STATUSES } from './issue-transitions';
import { countAgentRejections, REVIEW_CYCLE_CAP } from './reviews.service';

/** Statuses where an agent assignee is expected to act; backlog means "not ready yet". */
const WAKE_STATUSES: IssueStatus[] = ['todo', 'in_progress'];

/**
 * Reviewer wake on entering review. Skipped when the reviewer is also the
 * assignee (self-review is noise) and once the automated-cycle fuse has
 * blown — after that, reviews on this issue are human-only.
 */
async function wakeReviewerAgent(issue: Issue): Promise<void> {
  if (!issue.reviewerAgentId || issue.reviewerAgentId === issue.assigneeAgentId) return;
  try {
    if ((await countAgentRejections(issue.id)) >= REVIEW_CYCLE_CAP) return;
    await requestWake(issue.userId, {
      agentId: issue.reviewerAgentId,
      issueId: issue.id,
      trigger: 'review',
      reason: `Review requested on issue #${issue.issueNumber}: ${issue.title}`,
    });
  } catch (error) {
    console.error(`Reviewer wake for issue ${issue.id} failed:`, error);
  }
}

/** Wake-ups are post-commit side effects; a failed wake never fails the write. */
async function wakeAssignedAgent(issue: Issue, reason: string): Promise<void> {
  if (!issue.assigneeAgentId || !WAKE_STATUSES.includes(issue.status)) return;
  try {
    await requestWake(issue.userId, {
      agentId: issue.assigneeAgentId,
      issueId: issue.id,
      trigger: 'assignment',
      reason,
    });
  } catch (error) {
    console.error(`Wake for issue ${issue.id} failed:`, error);
  }
}

export interface AssignmentPatch {
  /** Exactly one of agentId/userId may be set; null clears the slot. */
  agentId?: string | null;
  userId?: string | null;
}

async function findIssue(userId: string, issueId: string): Promise<Issue | undefined> {
  const [issue] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.userId, userId)))
    .limit(1);
  return issue;
}

async function assertOwnedProject(userId: string, projectId: string): Promise<void> {
  const [row] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  if (!row) throw badRequest('invalid_project', 'Project does not exist');
}

async function assertOwnedAgent(userId: string, agentId: string): Promise<void> {
  const [row] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
    .limit(1);
  if (!row) throw badRequest('invalid_assignee', 'Agent does not exist');
}

/** Bottom of the column: current max order + 1 within (user, status). */
async function nextBoardOrder(userId: string, status: IssueStatus): Promise<number> {
  const [row] = await db
    .select({ max: sql<number | null>`max(${issues.boardOrder})` })
    .from(issues)
    .where(and(eq(issues.userId, userId), eq(issues.status, status)));
  return (row?.max ?? 0) + 1;
}

/**
 * Resolves an assignment patch to concrete column values, enforcing the
 * single-principal rule before the database CHECK ever sees it.
 */
async function resolvePrincipal(
  userId: string,
  patch: AssignmentPatch,
  slot: 'assignee' | 'reviewer'
): Promise<{ agentId: string | null; userId: string | null }> {
  if (patch.agentId && patch.userId) {
    throw badRequest('invalid_input', `Set either an agent or a user as ${slot}, not both`);
  }
  if (patch.agentId) {
    await assertOwnedAgent(userId, patch.agentId);
    return { agentId: patch.agentId, userId: null };
  }
  if (patch.userId) {
    if (patch.userId !== userId) {
      throw badRequest('invalid_assignee', 'Only the account owner can be assigned');
    }
    return { agentId: null, userId: patch.userId };
  }
  return { agentId: null, userId: null };
}

export async function createIssue(
  userId: string,
  input: {
    title: string;
    description?: string;
    projectId?: string;
    assignee?: AssignmentPatch;
    /** Validated by the caller; not exposed through the HTTP create route. */
    sourceConversationId?: string;
  }
): Promise<Issue> {
  let projectId = input.projectId;
  if (projectId) {
    await assertOwnedProject(userId, projectId);
  } else {
    projectId = (await getOrCreateDefaultProject(userId)).id;
  }
  const assignee = input.assignee
    ? await resolvePrincipal(userId, input.assignee, 'assignee')
    : { agentId: null, userId: null };

  const boardOrder = await nextBoardOrder(userId, 'backlog');

  // The counter UPDATE takes a row lock on the user, so concurrent creates
  // queue up and each draws a distinct number.
  return db.transaction(async (tx) => {
    const [counter] = await tx
      .update(users)
      .set({ issueCounter: sql`${users.issueCounter} + 1` })
      .where(eq(users.id, userId))
      .returning({ value: users.issueCounter });

    const [issue] = await tx
      .insert(issues)
      .values({
        userId,
        projectId: projectId!,
        issueNumber: counter!.value,
        title: input.title,
        description: input.description ?? '',
        assigneeAgentId: assignee.agentId,
        assigneeUserId: assignee.userId,
        sourceConversationId: input.sourceConversationId ?? null,
        boardOrder,
      })
      .returning();
    return issue!;
  });
}

export async function listIssues(
  userId: string,
  filter: { projectId?: string; status?: IssueStatus; assigneeAgentId?: string }
): Promise<Issue[]> {
  const conditions = [eq(issues.userId, userId)];
  if (filter.projectId) conditions.push(eq(issues.projectId, filter.projectId));
  if (filter.status) conditions.push(eq(issues.status, filter.status));
  if (filter.assigneeAgentId) conditions.push(eq(issues.assigneeAgentId, filter.assigneeAgentId));
  return db
    .select()
    .from(issues)
    .where(and(...conditions))
    .orderBy(desc(issues.createdAt));
}

/** Kanban payload: every status bucket present, cards ordered by boardOrder. */
export async function getBoard(
  userId: string,
  projectId?: string
): Promise<Record<IssueStatus, Issue[]>> {
  const conditions = [eq(issues.userId, userId)];
  if (projectId) conditions.push(eq(issues.projectId, projectId));
  const rows = await db
    .select()
    .from(issues)
    .where(and(...conditions))
    .orderBy(asc(issues.boardOrder));

  const board: Record<IssueStatus, Issue[]> = {
    backlog: [],
    todo: [],
    in_progress: [],
    in_review: [],
    blocked: [],
    done: [],
    cancelled: [],
  };
  for (const row of rows) board[row.status].push(row);
  return board;
}

export async function getIssue(userId: string, issueId: string): Promise<Issue> {
  const issue = await findIssue(userId, issueId);
  if (!issue) throw notFound('Issue not found');
  return issue;
}

export async function updateIssue(
  userId: string,
  issueId: string,
  input: {
    title?: string;
    description?: string;
    assignee?: AssignmentPatch | null;
    reviewer?: AssignmentPatch | null;
  }
): Promise<Issue> {
  const existing = await findIssue(userId, issueId);
  if (!existing) throw notFound('Issue not found');

  const patch: Partial<typeof issues.$inferInsert> = {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    updatedAt: new Date(),
  };

  if (input.assignee !== undefined) {
    const resolved = await resolvePrincipal(userId, input.assignee ?? {}, 'assignee');
    patch.assigneeAgentId = resolved.agentId;
    patch.assigneeUserId = resolved.userId;
  }
  if (input.reviewer !== undefined) {
    const resolved = await resolvePrincipal(userId, input.reviewer ?? {}, 'reviewer');
    patch.reviewerAgentId = resolved.agentId;
    patch.reviewerUserId = resolved.userId;
  }

  const [updated] = await db
    .update(issues)
    .set(patch)
    .where(and(eq(issues.id, issueId), eq(issues.userId, userId)))
    .returning();

  if (updated!.assigneeAgentId && updated!.assigneeAgentId !== existing.assigneeAgentId) {
    await wakeAssignedAgent(
      updated!,
      `You were assigned issue #${updated!.issueNumber}: ${updated!.title}`
    );
  }
  return updated!;
}

/**
 * Kanban move: optional column change plus position. Same-status calls are
 * pure reorders and skip transition validation; cross-status calls go
 * through the transition table like every other write path.
 */
export async function moveIssue(
  userId: string,
  issueId: string,
  input: { status: IssueStatus; boardOrder?: number }
): Promise<Issue> {
  const existing = await findIssue(userId, issueId);
  if (!existing) throw notFound('Issue not found');

  const changingStatus = input.status !== existing.status;
  if (changingStatus && !isTransitionAllowed(existing.status, input.status)) {
    throw badRequest(
      'invalid_transition',
      `Cannot move an issue from ${existing.status} to ${input.status}`
    );
  }

  const boardOrder = input.boardOrder ?? (await nextBoardOrder(userId, input.status));
  const closesNow = changingStatus && TERMINAL_STATUSES.includes(input.status);

  const [updated] = await db
    .update(issues)
    .set({
      status: input.status,
      boardOrder,
      ...(closesNow ? { closedAt: new Date() } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(issues.id, issueId), eq(issues.userId, userId)))
    .returning();

  const enteredWakeStatus =
    changingStatus &&
    WAKE_STATUSES.includes(input.status) &&
    !WAKE_STATUSES.includes(existing.status);
  if (enteredWakeStatus) {
    await wakeAssignedAgent(
      updated!,
      `Issue #${updated!.issueNumber} moved to ${input.status}: ${updated!.title}`
    );
  }
  if (changingStatus && input.status === 'in_review') {
    await wakeReviewerAgent(updated!);
  }
  return updated!;
}

export async function deleteIssue(userId: string, issueId: string): Promise<void> {
  if (await hasActiveWorkspaces({ issueId })) {
    throw conflict(
      'workspace_active',
      'Merge, keep the branch, or abandon the code workspace before deleting this issue'
    );
  }
  const deleted = await db
    .delete(issues)
    .where(and(eq(issues.id, issueId), eq(issues.userId, userId)))
    .returning({ id: issues.id });
  if (deleted.length === 0) throw notFound('Issue not found');
}
