import { EventEmitter } from 'node:events';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import {
  humanRequests,
  tasks,
  type HumanRequest,
  type HumanRequestKind,
  type HumanRequestStatus,
} from '../../db/schema';
import { badRequest, conflict, notFound } from '../../http/errors';

/**
 * Decisions only a person can make. The row is the source of truth; the
 * in-process emitter only wakes waiters early, and waiters also re-read the
 * row, so a lost signal costs latency, never a decision.
 */

const answered = new EventEmitter();
answered.setMaxListeners(0);

const POLL_MS = 1000;

export interface OpenRequestInput {
  taskId: string;
  /** Run that asked; its open requests are cancelled when the run loses its owner. */
  runId?: string | null;
  kind: HumanRequestKind;
  payload: Record<string, unknown>;
  /** Allowed answers; empty means a free-text answer. */
  choices: string[];
  ttlMs: number;
}

export async function openHumanRequest(input: OpenRequestInput): Promise<HumanRequest> {
  const [row] = await db
    .insert(humanRequests)
    .values({
      taskId: input.taskId,
      runId: input.runId ?? null,
      kind: input.kind,
      payload: input.payload,
      choices: input.choices,
      expiresAt: new Date(Date.now() + input.ttlMs),
    })
    .returning();
  return row!;
}

async function ownedRequest(userId: string, requestId: string): Promise<HumanRequest> {
  const [row] = await db
    .select({ request: humanRequests })
    .from(humanRequests)
    .innerJoin(tasks, eq(tasks.id, humanRequests.taskId))
    .where(and(eq(humanRequests.id, requestId), eq(tasks.userId, userId)))
    .limit(1);
  if (!row) throw notFound('Request not found');
  return row.request;
}

/** Marks open requests past their deadline as expired; returns how many changed. */
export async function expireOverdueRequests(): Promise<number> {
  const rows = await db
    .update(humanRequests)
    .set({ status: 'expired' })
    .where(and(eq(humanRequests.status, 'open'), lt(humanRequests.expiresAt, new Date())))
    .returning({ id: humanRequests.id });
  for (const row of rows) answered.emit(row.id);
  return rows.length;
}

export async function answerHumanRequest(
  userId: string,
  requestId: string,
  input: { choice: string; note?: string }
): Promise<HumanRequest> {
  const request = await ownedRequest(userId, requestId);
  if (request.choices.length > 0 && !request.choices.includes(input.choice)) {
    throw badRequest('invalid_choice', `Choose one of: ${request.choices.join(', ')}`);
  }
  // The status guard makes answering and expiring race-safe: exactly one wins.
  const [row] = await db
    .update(humanRequests)
    .set({
      status: 'answered',
      answer: { choice: input.choice, ...(input.note ? { note: input.note } : {}) },
      answeredAt: new Date(),
    })
    .where(
      and(
        eq(humanRequests.id, requestId),
        eq(humanRequests.status, 'open'),
        sql`(${humanRequests.expiresAt} IS NULL OR ${humanRequests.expiresAt} > now())`
      )
    )
    .returning();
  if (!row) {
    await expireOverdueRequests();
    throw conflict('request_closed', 'This request is no longer open');
  }
  answered.emit(row.id);
  return row;
}

export async function listHumanRequests(
  userId: string,
  filter: { status?: HumanRequestStatus; taskId?: string } = {}
): Promise<HumanRequest[]> {
  await expireOverdueRequests();
  const conditions = [eq(tasks.userId, userId)];
  if (filter.status) conditions.push(eq(humanRequests.status, filter.status));
  if (filter.taskId) conditions.push(eq(humanRequests.taskId, filter.taskId));
  const rows = await db
    .select({ request: humanRequests })
    .from(humanRequests)
    .innerJoin(tasks, eq(tasks.id, humanRequests.taskId))
    .where(and(...conditions))
    .orderBy(desc(humanRequests.createdAt));
  return rows.map((r) => r.request);
}

export type WaitResult =
  | { status: 'answered'; choice: string; note: string | null }
  | { status: 'expired' | 'cancelled' };

async function settle(requestId: string): Promise<WaitResult | null> {
  const [row] = await db.select().from(humanRequests).where(eq(humanRequests.id, requestId)).limit(1);
  if (!row || row.status === 'cancelled') return { status: 'cancelled' };
  if (row.status === 'answered') {
    const answer = (row.answer ?? {}) as { choice?: string; note?: string };
    return { status: 'answered', choice: answer.choice ?? '', note: answer.note ?? null };
  }
  if (row.status === 'expired') return { status: 'expired' };
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
    const [expired] = await db
      .update(humanRequests)
      .set({ status: 'expired' })
      .where(and(eq(humanRequests.id, requestId), eq(humanRequests.status, 'open')))
      .returning({ id: humanRequests.id });
    // Lost the race to an answer that landed just now; read it back.
    return expired ? { status: 'expired' } : settle(requestId);
  }
  return null;
}

/** Resolves when the request is answered, expires, or is withdrawn. */
export async function waitForHumanAnswer(requestId: string): Promise<WaitResult> {
  for (;;) {
    const result = await settle(requestId);
    if (result) return result;
    await new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        answered.off(requestId, wake);
        resolve();
      }, POLL_MS);
      answered.once(requestId, wake);
    });
  }
}
