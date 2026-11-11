import { and, asc, eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { agents, taskComments, tasks, type TaskComment } from '../../db/schema';
import { badRequest, notFound } from '../../http/errors';

async function assertOwnedTask(userId: string, taskId: string): Promise<void> {
  const [row] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)))
    .limit(1);
  if (!row) throw notFound('Task not found');
}

export async function addHumanComment(
  userId: string,
  taskId: string,
  body: string
): Promise<TaskComment> {
  await assertOwnedTask(userId, taskId);
  const [comment] = await db
    .insert(taskComments)
    .values({ taskId, authorType: 'human', authorUserId: userId, body })
    .returning();
  return comment!;
}

/**
 * Agent-authored timeline entry. No HTTP route yet; the runner and the
 * future control-plane tools call this directly.
 */
export async function addAgentComment(
  userId: string,
  taskId: string,
  agentId: string,
  body: string
): Promise<TaskComment> {
  await assertOwnedTask(userId, taskId);
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
    .limit(1);
  if (!agent) throw badRequest('invalid_author', 'Agent does not exist');

  const [comment] = await db
    .insert(taskComments)
    .values({ taskId, authorType: 'agent', authorAgentId: agentId, body })
    .returning();
  return comment!;
}

/** Platform-generated timeline entry (workspace lifecycle, capture evidence). */
export async function addSystemComment(
  userId: string,
  taskId: string,
  body: string
): Promise<TaskComment> {
  await assertOwnedTask(userId, taskId);
  const [comment] = await db
    .insert(taskComments)
    .values({ taskId, authorType: 'system', body })
    .returning();
  return comment!;
}

export async function listComments(userId: string, taskId: string): Promise<TaskComment[]> {
  await assertOwnedTask(userId, taskId);
  return db
    .select()
    .from(taskComments)
    .where(eq(taskComments.taskId, taskId))
    .orderBy(asc(taskComments.createdAt));
}
