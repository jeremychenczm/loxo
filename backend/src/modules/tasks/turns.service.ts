import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { agents, tasks, turns, type Turn, type TurnKind, type TurnReport } from '../../db/schema';
import { badRequest, notFound } from '../../http/errors';

async function assertOwnedTask(userId: string, taskId: string): Promise<void> {
  const [row] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)))
    .limit(1);
  if (!row) throw notFound('Task not found');
}

interface AppendInput {
  kind: TurnKind;
  content: string;
  agentId?: string;
  authorUserId?: string;
  runId?: string | null;
  report?: TurnReport;
}

/**
 * Records a finished turn. The counter UPDATE row-locks the task, so
 * concurrent appends on one task serialize and each draws a distinct seq.
 */
async function appendCompletedTurn(taskId: string, input: AppendInput): Promise<Turn> {
  return db.transaction(async (tx) => {
    const [counter] = await tx
      .update(tasks)
      .set({ turnCounter: sql`${tasks.turnCounter} + 1` })
      .where(eq(tasks.id, taskId))
      .returning({ seq: tasks.turnCounter });
    if (!counter) throw notFound('Task not found');
    const now = new Date();
    const [turn] = await tx
      .insert(turns)
      .values({
        taskId,
        seq: counter.seq,
        kind: input.kind,
        agentId: input.agentId ?? null,
        authorUserId: input.authorUserId ?? null,
        runId: input.runId ?? null,
        report: input.report ?? null,
        content: input.content,
        status: 'completed',
        createdAt: now,
        completedAt: now,
      })
      .returning();
    return turn!;
  });
}

export async function addHumanTurn(userId: string, taskId: string, content: string): Promise<Turn> {
  await assertOwnedTask(userId, taskId);
  return appendCompletedTurn(taskId, { kind: 'human', authorUserId: userId, content });
}

export async function addAgentTurn(
  userId: string,
  taskId: string,
  agentId: string,
  content: string,
  extra: { runId?: string | null; report?: TurnReport } = {}
): Promise<Turn> {
  await assertOwnedTask(userId, taskId);
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
    .limit(1);
  if (!agent) throw badRequest('invalid_author', 'Agent does not exist');
  return appendCompletedTurn(taskId, { kind: 'agent', agentId, content, ...extra });
}

/** Platform-generated entry (workspace lifecycle, capture evidence). */
export async function addSystemTurn(userId: string, taskId: string, content: string): Promise<Turn> {
  await assertOwnedTask(userId, taskId);
  return appendCompletedTurn(taskId, { kind: 'system', content });
}

export async function listTurns(userId: string, taskId: string): Promise<Turn[]> {
  await assertOwnedTask(userId, taskId);
  return db.select().from(turns).where(eq(turns.taskId, taskId)).orderBy(asc(turns.seq));
}

/** True when the run left at least one turn on the timeline. */
export async function runHasTurns(runId: string): Promise<boolean> {
  const [row] = await db.select({ id: turns.id }).from(turns).where(eq(turns.runId, runId)).limit(1);
  return row !== undefined;
}
