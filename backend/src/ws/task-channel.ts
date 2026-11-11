import { and, eq } from 'drizzle-orm';
import type { WebSocket } from 'ws';
import { db } from '../db/client';
import { tasks } from '../db/schema';
import { runEventBus, type RunEventFrame } from '../modules/runs/run-events.service';

/**
 * Live task activity over the shared /ws socket:
 *   client → task.subscribe   {taskId}
 *   client → task.unsubscribe {taskId}
 *   server → task.subscribed | task.run_event | task.error
 * Events are pushed after they commit, so a client that reconnects can
 * backfill from the REST history by seq and never sees a gap or a reorder.
 */

const subscribers = new Map<string, Set<WebSocket>>();
const socketTasks = new WeakMap<WebSocket, Set<string>>();
const owners = new WeakMap<WebSocket, string>();

function send(ws: WebSocket, type: string, payload: Record<string, unknown>): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, payload }));
}

runEventBus.on('event', (frame: RunEventFrame) => {
  if (!frame.taskId) return;
  const sockets = subscribers.get(frame.taskId);
  if (!sockets) return;
  const { userId, ...payload } = frame;
  for (const ws of sockets) {
    if (owners.get(ws) === userId) send(ws, 'task.run_event', payload);
  }
});

function unsubscribe(ws: WebSocket, taskId: string): void {
  const sockets = subscribers.get(taskId);
  sockets?.delete(ws);
  if (sockets && sockets.size === 0) subscribers.delete(taskId);
  socketTasks.get(ws)?.delete(taskId);
}

export function releaseTaskSubscriptions(ws: WebSocket): void {
  for (const taskId of [...(socketTasks.get(ws) ?? [])]) unsubscribe(ws, taskId);
}

export async function handleTaskFrame(
  ws: WebSocket,
  userId: string,
  frame: { type: string; payload?: Record<string, unknown> }
): Promise<void> {
  const taskId = typeof frame.payload?.taskId === 'string' ? frame.payload.taskId : '';
  if (!/^[0-9a-f-]{36}$/i.test(taskId)) {
    send(ws, 'task.error', { code: 'invalid_frame', message: 'taskId is required' });
    return;
  }
  if (frame.type === 'task.unsubscribe') {
    unsubscribe(ws, taskId);
    return;
  }
  if (frame.type !== 'task.subscribe') {
    send(ws, 'task.error', { code: 'unknown_frame', message: frame.type });
    return;
  }
  const [owned] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)))
    .limit(1);
  if (!owned) {
    send(ws, 'task.error', { code: 'not_found', message: 'Task not found', taskId });
    return;
  }
  owners.set(ws, userId);
  if (!subscribers.has(taskId)) subscribers.set(taskId, new Set());
  subscribers.get(taskId)!.add(ws);
  if (!socketTasks.has(ws)) socketTasks.set(ws, new Set());
  socketTasks.get(ws)!.add(taskId);
  send(ws, 'task.subscribed', { taskId });
}
