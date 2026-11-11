import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import {
  agents,
  taskMembers,
  tasks,
  users,
  type Task,
  type TaskStatus,
} from '../../db/schema';
import { badRequest, conflict, HttpError, notFound } from '../../http/errors';
import { findRepository, hasActiveWorkspaces } from '../code-workspaces/workspace.service';
import { getCrew } from '../crews/crews.service';
import { requestWake } from '../runs/wake';
import { isTransitionAllowed, TERMINAL_STATUSES } from './task-transitions';
import { countAgentRejections, REVIEW_CYCLE_CAP } from './approvals.service';

/** Statuses where the lead is expected to act; backlog means "not ready yet". */
const WAKE_STATUSES: TaskStatus[] = ['todo', 'in_progress'];

export const MAX_TASK_MEMBERS = 8;

export interface TaskView extends Task {
  /** Active members in speaking order; the lead is always among them. */
  memberAgentIds: string[];
}

/** Active member agent ids per task, ordered by position. */
async function loadActiveMembers(taskIds: string[]): Promise<Map<string, string[]>> {
  const members = new Map<string, string[]>(taskIds.map((id) => [id, []]));
  if (taskIds.length === 0) return members;
  const rows = await db
    .select({ taskId: taskMembers.taskId, agentId: taskMembers.agentId })
    .from(taskMembers)
    .where(and(inArray(taskMembers.taskId, taskIds), eq(taskMembers.state, 'active')))
    .orderBy(asc(taskMembers.position), asc(taskMembers.createdAt));
  for (const row of rows) members.get(row.taskId)?.push(row.agentId);
  return members;
}

export async function toTaskViews(rows: Task[]): Promise<TaskView[]> {
  const members = await loadActiveMembers(rows.map((r) => r.id));
  return rows.map((row) => ({ ...row, memberAgentIds: members.get(row.id)! }));
}

export async function toTaskView(row: Task): Promise<TaskView> {
  return (await toTaskViews([row]))[0]!;
}

export async function activeMemberIds(taskId: string): Promise<string[]> {
  return (await loadActiveMembers([taskId])).get(taskId)!;
}

/**
 * Reviewer wakes on entering review: every active member except the lead
 * (self-review is noise), until the automated-cycle fuse has blown — after
 * that, reviews on this task are human-only.
 */
async function wakeReviewers(task: Task): Promise<void> {
  try {
    const reviewers = (await activeMemberIds(task.id)).filter((id) => id !== task.leadAgentId);
    if (reviewers.length === 0) return;
    if ((await countAgentRejections(task.id)) >= REVIEW_CYCLE_CAP) return;
    for (const agentId of reviewers) {
      await requestWake(task.userId, {
        agentId,
        taskId: task.id,
        trigger: 'review',
        reason: `Review requested on task #${task.number}: ${task.title}`,
      });
    }
  } catch (error) {
    console.error(`Reviewer wake for task ${task.id} failed:`, error);
  }
}

/** Wake-ups are post-commit side effects; a failed wake never fails the write. */
async function wakeLead(task: Task, reason: string): Promise<void> {
  if (!task.leadAgentId || !WAKE_STATUSES.includes(task.status)) return;
  try {
    await requestWake(task.userId, {
      agentId: task.leadAgentId,
      taskId: task.id,
      trigger: 'assignment',
      reason,
    });
  } catch (error) {
    console.error(`Wake for task ${task.id} failed:`, error);
  }
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

/** Bottom of the column: current max order + 1 within (user, status). */
async function nextBoardOrder(userId: string, status: TaskStatus): Promise<number> {
  const [row] = await db
    .select({ max: sql<number | null>`max(${tasks.boardOrder})` })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.status, status)));
  return (row?.max ?? 0) + 1;
}

/**
 * Normalizes a roster and its lead: the lead joins the roster at the front
 * when missing, agents are unique and owned, and the size is bounded.
 */
async function resolveRoster(
  userId: string,
  roster: string[],
  leadAgentId: string | null
): Promise<{ roster: string[]; leadAgentId: string | null }> {
  const unique = [...new Set(roster)];
  if (unique.length !== roster.length) {
    throw badRequest('invalid_members', 'An agent can join a task only once');
  }
  const full = leadAgentId && !unique.includes(leadAgentId) ? [leadAgentId, ...unique] : unique;
  if (full.length > MAX_TASK_MEMBERS) {
    throw badRequest('invalid_members', `A task can have at most ${MAX_TASK_MEMBERS} members`);
  }
  if (full.length > 0) {
    const owned = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.userId, userId), inArray(agents.id, full)));
    if (owned.length !== full.length) {
      throw badRequest('invalid_members', 'One or more agents do not exist');
    }
  }
  return { roster: full, leadAgentId };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Makes `roster` the active member list in order. Members who drop out are
 * marked removed rather than deleted, so their history stays attributable.
 */
async function writeRoster(tx: Tx, taskId: string, roster: string[]): Promise<void> {
  const existing = await tx.select().from(taskMembers).where(eq(taskMembers.taskId, taskId));
  const now = new Date();
  for (const row of existing) {
    if (!roster.includes(row.agentId) && row.state !== 'removed') {
      await tx
        .update(taskMembers)
        .set({ state: 'removed', updatedAt: now })
        .where(eq(taskMembers.id, row.id));
    }
  }
  for (const [position, agentId] of roster.entries()) {
    const row = existing.find((r) => r.agentId === agentId);
    if (row) {
      await tx
        .update(taskMembers)
        .set({ position, state: 'active', pausedReason: null, updatedAt: now })
        .where(eq(taskMembers.id, row.id));
    } else {
      await tx.insert(taskMembers).values({ taskId, agentId, position });
    }
  }
}

async function crewRoster(userId: string, crewId: string): Promise<string[]> {
  try {
    return (await getCrew(userId, crewId)).agentIds;
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      throw badRequest('invalid_crew', 'Crew does not exist');
    }
    throw err;
  }
}

export interface CreateTaskInput {
  title: string;
  brief?: string;
  repositoryId?: string;
  /** Copies the crew's roster; memberAgentIds is ignored when set. */
  crewId?: string;
  leadAgentId?: string;
  memberAgentIds?: string[];
  /** Validated by the caller; not exposed through the HTTP create route. */
  sourceConversationId?: string;
}

export async function createTask(userId: string, input: CreateTaskInput): Promise<Task> {
  if (input.repositoryId) await assertOwnedRepository(userId, input.repositoryId);

  const requested = input.crewId
    ? await crewRoster(userId, input.crewId)
    : (input.memberAgentIds ?? []);
  const { roster, leadAgentId } = await resolveRoster(
    userId,
    requested,
    input.leadAgentId ?? requested[0] ?? null
  );

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
        leadAgentId,
        sourceConversationId: input.sourceConversationId ?? null,
        boardOrder,
      })
      .returning();
    await writeRoster(tx, task!.id, roster);
    return task!;
  });
}

export async function listTasks(
  userId: string,
  filter: { repositoryId?: string; status?: TaskStatus; leadAgentId?: string }
): Promise<Task[]> {
  const conditions = [eq(tasks.userId, userId)];
  if (filter.repositoryId) conditions.push(eq(tasks.repositoryId, filter.repositoryId));
  if (filter.status) conditions.push(eq(tasks.status, filter.status));
  if (filter.leadAgentId) conditions.push(eq(tasks.leadAgentId, filter.leadAgentId));
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
): Promise<Record<TaskStatus, TaskView[]>> {
  const conditions = [eq(tasks.userId, userId)];
  if (repositoryId) conditions.push(eq(tasks.repositoryId, repositoryId));
  const rows = await toTaskViews(
    await db
      .select()
      .from(tasks)
      .where(and(...conditions))
      .orderBy(asc(tasks.boardOrder))
  );

  const board: Record<TaskStatus, TaskView[]> = {
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

export interface UpdateTaskInput {
  title?: string;
  brief?: string;
  /** Null clears the lead; the members stay. */
  leadAgentId?: string | null;
  /** Replaces the active roster; a lead outside it joins at the front. */
  memberAgentIds?: string[];
}

export async function updateTask(
  userId: string,
  taskId: string,
  input: UpdateTaskInput
): Promise<Task> {
  const existing = await findTask(userId, taskId);
  if (!existing) throw notFound('Task not found');

  const patch: Partial<typeof tasks.$inferInsert> = {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.brief !== undefined ? { brief: input.brief } : {}),
    updatedAt: new Date(),
  };

  let roster: string[] | null = null;
  if (input.memberAgentIds !== undefined || input.leadAgentId !== undefined) {
    const current = await activeMemberIds(taskId);
    const requested = input.memberAgentIds ?? current;
    const lead =
      input.leadAgentId !== undefined
        ? input.leadAgentId
        : existing.leadAgentId && requested.includes(existing.leadAgentId)
          ? existing.leadAgentId
          : (requested[0] ?? null);
    const resolved = await resolveRoster(userId, requested, lead);
    roster = resolved.roster;
    patch.leadAgentId = resolved.leadAgentId;
  }

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(tasks)
      .set(patch)
      .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)))
      .returning();
    if (roster) await writeRoster(tx, taskId, roster);
    return row!;
  });

  if (updated.leadAgentId && updated.leadAgentId !== existing.leadAgentId) {
    await wakeLead(updated, `You now lead task #${updated.number}: ${updated.title}`);
  }
  return updated;
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
    await wakeLead(updated!, `Task #${updated!.number} moved to ${input.status}: ${updated!.title}`);
  }
  if (changingStatus && input.status === 'in_review') {
    await wakeReviewers(updated!);
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
