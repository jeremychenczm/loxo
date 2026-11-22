import { and, eq } from 'drizzle-orm';
import { db, type Tx } from '../../db/client';
import { platformOps, tasks, type HumanRequest, type Run, type Task } from '../../db/schema';
import { platformOpOf, platformOpOfRequestKey, queuePlatformRun } from './platform-ops';
import { badRequest, conflict, notFound } from '../../http/errors';
import { advanceTask, ENGINE_ERROR_KEY, moveToPhase, stopWorkshopWithin } from './advance';
import { liveRoster } from './state';

/**
 * Starts a workshop: checks the roster against the playbook, enters Brief,
 * and advances once so the first dispatches go out with the response.
 */
export async function startWorkshop(userId: string, taskId: string): Promise<Task> {
  await db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)))
      .for('update');
    if (!task) throw notFound('Task not found');
    if (task.playbook === 'legacy') {
      throw conflict('not_a_workshop', 'This task is not a workshop; create it with the build or solo playbook');
    }
    if (task.phase !== null) throw conflict('workshop_started', 'This workshop has already started');
    if (task.repositoryId !== null) {
      throw conflict('workshop_repository_unsupported', 'Workshops on a repository are not supported yet');
    }
    const roster = await liveRoster(tx, task.id);
    if (task.playbook === 'solo' && roster.length !== 1) {
      throw badRequest('invalid_roster', 'A solo workshop has exactly one member');
    }
    if (task.playbook === 'build' && roster.length < 2) {
      throw badRequest('invalid_roster', 'A build workshop needs at least two members');
    }
    if (!task.leadAgentId || !roster.includes(task.leadAgentId)) {
      throw badRequest('no_lead', 'Choose a lead from the members first');
    }
    await moveToPhase(tx, task, null, 'brief', 0, 0, { startedBy: userId });
    await tx.update(tasks).set({ advancePending: true }).where(eq(tasks.id, task.id));
  });
  await advanceTask(taskId);
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  return task!;
}

/**
 * Runs inside the transaction that answers a request the engine opened: the
 * task row is locked first (the system-wide order is task before request),
 * and the workshop is flagged to advance. An engine_error answer is handled
 * here, since the engine itself is what failed; so is the answer about a
 * failed platform operation. Returns runs to start after commit.
 */
export async function noteEngineRequestAnswered(
  tx: Tx,
  request: HumanRequest,
  choice: string | undefined
): Promise<Run[]> {
  const [task] = await tx.select().from(tasks).where(eq(tasks.id, request.taskId)).for('update');
  if (!task) return [];
  const opId = platformOpOfRequestKey(request.dedupeKey);
  if (opId) return answerFailedOperation(tx, task, opId, choice, request.id);
  if (task.playbook === 'legacy') return [];
  if (request.dedupeKey === ENGINE_ERROR_KEY && choice === 'stop') {
    await stopWorkshopWithin(tx, task, { engineError: request.id });
    return [];
  }
  await tx
    .update(tasks)
    .set({
      advancePending: true,
      ...(request.dedupeKey === ENGINE_ERROR_KEY ? { advanceFailures: 0 } : {}),
    })
    .where(eq(tasks.id, task.id));
  return [];
}

/** retry runs the operation again from its first attempt; stop cancels it and stops the workshop. */
async function answerFailedOperation(
  tx: Tx,
  task: Task,
  opId: string,
  choice: string | undefined,
  requestId: string
): Promise<Run[]> {
  const op = await platformOpOf(opId, tx);
  if (!op || op.status !== 'failed') return [];
  const queued: Run[] = [];
  if (choice === 'retry') {
    await tx.update(platformOps).set({ status: 'wanted', error: null, updatedAt: new Date() }).where(eq(platformOps.id, op.id));
    queued.push(
      await queuePlatformRun(tx, task.userId, op, { attempt: 1, reason: `Retrying platform operation ${op.kind} at a person's request` })
    );
  } else if (choice === 'stop') {
    await tx.update(platformOps).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(platformOps.id, op.id));
    if (task.phase !== null && task.phase !== 'done' && task.phase !== 'stopped') {
      await stopWorkshopWithin(tx, task, { platformOp: op.id, request: requestId });
    }
  }
  await tx.update(tasks).set({ advancePending: true }).where(eq(tasks.id, task.id));
  return queued;
}
