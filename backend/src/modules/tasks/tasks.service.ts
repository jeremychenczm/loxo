import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import {
  agents,
  tasks,
  users,
  type Task,
  type TaskStatus,
} from '../../db/schema';
import { badRequest, conflict, notFound } from '../../http/errors';
import { findRepository, hasActiveWorkspaces } from '../code-workspaces/workspace.service';
import { requestWake } from '../runs/wake';
import { isTransitionAllowed, TERMINAL_STATUSES } from './task-transitions';
import { countAgentRejections, REVIEW_CYCLE_CAP } from './reviews.service';

/** Statuses where an agent assignee is expected to act; backlog means "not ready yet". */
const WAKE_STATUSES: TaskStatus[] = ['todo', 'in_progress'];

/**
 * Reviewer wake on entering review. Skipped when the reviewer is also the
 * assignee (self-review is noise) and once the automated-cycle fuse has
 * blown — after that, reviews on this task are human-only.
 */
async function wakeReviewerAgent(task: Task): Promise<void> {
  if (!task.reviewerAgentId || task.reviewerAgentId === task.assigneeAgentId) return;
  try {
    if ((await countAgentRejections(task.id)) >= REVIEW_CYCLE_CAP) return;
    await requestWake(task.userId, {
      agentId: task.reviewerAgentId,
      taskId: task.id,
      trigger: 'review',
      reason: `Review requested on task #${task.number}: ${task.title}`,
    });
  } catch (error) {
    console.error(`Reviewer wake for task ${task.id} failed:`, error);
  }
}

/** Wake-ups are post-commit side effects; a failed wake never fails the write. */
async function wakeAssignedAgent(task: Task, reason: string): Promise<void> {
  if (!task.assigneeAgentId || !WAKE_STATUSES.includes(task.status)) return;
  try {
    await requestWake(task.userId, {
      agentId: task.assigneeAgentId,
      taskId: task.id,
      trigger: 'assignment',
      reason,
    });
  } catch (error) {
    console.error(`Wake for task ${task.id} failed:`, error);
  }
}

export interface AssignmentPatch {
  /** Exactly one of agentId/userId may be set; null clears the slot. */
  agentId?: string | null;
  userId?: string | null;
}

async function findTask(userId: string, taskId: string): Promise<Task | undefined> {
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)))
    .limit(1);
  return task;
}

async function assertOwnedRepository(userId: string, repositoryId: string): Promise<void> {
  if (!(await findRepository(userId, repositoryId))) {
    throw badRequest('invalid_repository', 'Repository does not exist');
  }
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
async function nextBoardOrder(userId: string, status: TaskStatus): Promise<number> {
  const [row] = await db
    .select({ max: sql<number | null>`max(${tasks.boardOrder})` })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.status, status)));
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

export async function createTask(
  userId: string,
  input: {
    title: string;
    brief?: string;
    repositoryId?: string;
    assignee?: AssignmentPatch;
    /** Validated by the caller; not exposed through the HTTP create route. */
    sourceConversationId?: string;
  }
): Promise<Task> {
  if (input.repositoryId) await assertOwnedRepository(userId, input.repositoryId);
  const assignee = input.assignee
    ? await resolvePrincipal(userId, input.assignee, 'assignee')
    : { agentId: null, userId: null };

  const boardOrder = await nextBoardOrder(userId, 'backlog');

  // The counter UPDATE takes a row lock on the user, so concurrent creates
  // queue up and each draws a distinct number.
  return db.transaction(async (tx) => {
    const [counter] = await tx
      .update(users)
      .set({ taskCounter: sql`${users.taskCounter} + 1` })
      .where(eq(users.id, userId))
      .returning({ value: users.taskCounter });

    const [task] = await tx
      .insert(tasks)
      .values({
        userId,
        repositoryId: input.repositoryId ?? null,
        number: counter!.value,
        title: input.title,
        brief: input.brief ?? '',
        assigneeAgentId: assignee.agentId,
        assigneeUserId: assignee.userId,
        sourceConversationId: input.sourceConversationId ?? null,
        boardOrder,
      })
      .returning();
    return task!;
  });
}

export async function listTasks(
  userId: string,
  filter: { repositoryId?: string; status?: TaskStatus; assigneeAgentId?: string }
): Promise<Task[]> {
  const conditions = [eq(tasks.userId, userId)];
  if (filter.repositoryId) conditions.push(eq(tasks.repositoryId, filter.repositoryId));
  if (filter.status) conditions.push(eq(tasks.status, filter.status));
  if (filter.assigneeAgentId) conditions.push(eq(tasks.assigneeAgentId, filter.assigneeAgentId));
  return db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(desc(tasks.createdAt));
}

/** Kanban payload: every status bucket present, cards ordered by boardOrder. */
export async function getBoard(
  userId: string,
  repositoryId?: string
): Promise<Record<TaskStatus, Task[]>> {
  const conditions = [eq(tasks.userId, userId)];
  if (repositoryId) conditions.push(eq(tasks.repositoryId, repositoryId));
  const rows = await db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(asc(tasks.boardOrder));

  const board: Record<TaskStatus, Task[]> = {
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

export async function getTask(userId: string, taskId: string): Promise<Task> {
  const task = await findTask(userId, taskId);
  if (!task) throw notFound('Task not found');
  return task;
}

export async function updateTask(
  userId: string,
  taskId: string,
  input: {
    title?: string;
    brief?: string;
    assignee?: AssignmentPatch | null;
    reviewer?: AssignmentPatch | null;
  }
): Promise<Task> {
  const existing = await findTask(userId, taskId);
  if (!existing) throw notFound('Task not found');

  const patch: Partial<typeof tasks.$inferInsert> = {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.brief !== undefined ? { brief: input.brief } : {}),
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
    .update(tasks)
    .set(patch)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)))
    .returning();

  if (updated!.assigneeAgentId && updated!.assigneeAgentId !== existing.assigneeAgentId) {
    await wakeAssignedAgent(
      updated!,
      `You were assigned task #${updated!.number}: ${updated!.title}`
    );
  }
  return updated!;
}

/**
 * Kanban move: optional column change plus position. Same-status calls are
 * pure reorders and skip transition validation; cross-status calls go
 * through the transition table like every other write path.
 */
export async function moveTask(
  userId: string,
  taskId: string,
  input: { status: TaskStatus; boardOrder?: number }
): Promise<Task> {
  const existing = await findTask(userId, taskId);
  if (!existing) throw notFound('Task not found');

  const changingStatus = input.status !== existing.status;
  if (changingStatus && !isTransitionAllowed(existing.status, input.status)) {
    throw badRequest(
      'invalid_transition',
      `Cannot move a task from ${existing.status} to ${input.status}`
    );
  }

  const boardOrder = input.boardOrder ?? (await nextBoardOrder(userId, input.status));
  const closesNow = changingStatus && TERMINAL_STATUSES.includes(input.status);

  const [updated] = await db
    .update(tasks)
    .set({
      status: input.status,
      boardOrder,
      ...(closesNow ? { closedAt: new Date() } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)))
    .returning();

  const enteredWakeStatus =
    changingStatus &&
    WAKE_STATUSES.includes(input.status) &&
    !WAKE_STATUSES.includes(existing.status);
  if (enteredWakeStatus) {
    await wakeAssignedAgent(
      updated!,
      `Task #${updated!.number} moved to ${input.status}: ${updated!.title}`
    );
  }
  if (changingStatus && input.status === 'in_review') {
    await wakeReviewerAgent(updated!);
  }
  return updated!;
}

export async function deleteTask(userId: string, taskId: string): Promise<void> {
  if (await hasActiveWorkspaces({ taskId })) {
    throw conflict(
      'workspace_active',
      'Merge, keep the branch, or abandon the code workspace before deleting this task'
    );
  }
  const deleted = await db
    .delete(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)))
    .returning({ id: tasks.id });
  if (deleted.length === 0) throw notFound('Task not found');
}
