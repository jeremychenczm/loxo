import { and, desc, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import { runEvents, runs, type Run } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { createQueuedRun } from '../src/modules/runs/runs.service';
import { CONTEXT_LOST_NOTE, setTaskHostFactoryForTests } from '../src/modules/runs/task-run';
import { drainRunsForTests, requestWake, startQueuedRuns } from '../src/modules/runs/wake';
import { scriptedHost, type ScriptedSessions, type ScriptedTurn } from './support/scripted-host';

const app = createApp();
const T = 30_000;
let token = '';
let userId = '';
let counter = 0;
const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  const reg = await request(app)
    .post('/auth/register')
    .send({ email: 'restore@example.com', username: 'restoreuser', password: 'a-strong-password' });
  token = reg.body.token;
  userId = reg.body.user.id;
});

afterAll(() => setTaskHostFactoryForTests(null));

async function newAgent(): Promise<string> {
  counter += 1;
  const res = await request(app).post('/api/agents').set(auth()).send({ name: `Restorer ${counter}`, runtime: 'claude-code' });
  return res.body.agent.id;
}

interface Seen {
  turn: ScriptedTurn;
  /** The session id stored on the running run while its turn was in flight. */
  storedRef: string | null;
}

/** A first run on a fresh task, then a follow-up run that picks up after it. */
async function chain(sessions: ScriptedSessions, followUpAgent: 'same' | 'other' = 'same') {
  const seen: Seen[] = [];
  setTaskHostFactoryForTests(
    scriptedHost(async (turn) => {
      const [running] = await db
        .select({ ref: runs.sessionRef })
        .from(runs)
        .where(and(eq(runs.status, 'running'), eq(runs.userId, userId)));
      seen.push({ turn, storedRef: running?.ref ?? null });
      return { text: 'ok' };
    }, sessions)
  );
  const agentId = await newAgent();
  const task = await request(app).post('/api/tasks').set(auth()).send({ title: `Restore ${counter}` });
  const taskId = task.body.task.id as string;
  await requestWake(userId, { agentId, taskId, trigger: 'manual' });
  await drainRunsForTests();
  const [first] = await db.select().from(runs).where(eq(runs.taskId, taskId));
  const child = await createQueuedRun(userId, {
    agentId: followUpAgent === 'same' ? agentId : await newAgent(),
    agentName: 'Restorer',
    taskId,
    trigger: 'manual',
    reason: 'Pick up where the last attempt stopped.',
    parentRunId: first!.id,
    attempt: 2,
  });
  await startQueuedRuns([child]);
  await drainRunsForTests();
  const [second] = await db.select().from(runs).where(eq(runs.id, child.id));
  return { first: first!, second: second!, seen };
}

async function statusMessages(run: Run): Promise<string[]> {
  const rows = await db
    .select({ payload: runEvents.payload })
    .from(runEvents)
    .where(and(eq(runEvents.runId, run.id), eq(runEvents.kind, 'status')))
    .orderBy(desc(runEvents.seq));
  return rows.map((r) => (r.payload as { message?: string }).message ?? '');
}

describe('a run that picks up after an earlier attempt', () => {
  it('stores the session id while the first run is still in flight', { timeout: T }, async () => {
    const { first, seen } = await chain('fresh');
    expect(first.status).toBe('succeeded');
    expect(seen[0]!.storedRef).toMatch(/^runtime-/);
    expect(first.sessionRef).toBe(seen[0]!.storedRef);
  });

  it('restores the earlier conversation and says so, with no warning to the agent', { timeout: T }, async () => {
    const { first, second, seen } = await chain('restorable');
    expect(second.status).toBe('succeeded');
    expect(seen[0]!.turn.resumeSessionId).toBeNull();
    expect(seen[1]!.turn.resumeSessionId).toBe(first.sessionRef);
    expect(seen[1]!.turn.prompt.startsWith(CONTEXT_LOST_NOTE)).toBe(false);
    expect(second.sessionRef).toBe(first.sessionRef);
    expect(await statusMessages(second)).toContain('Restored the earlier conversation (resume)');
  });

  it('starts fresh when the conversation cannot be restored, and tells the agent', { timeout: T }, async () => {
    const { first, second, seen } = await chain('fresh');
    expect(second.status).toBe('succeeded');
    expect(seen[1]!.turn.resumeSessionId).toBe(first.sessionRef);
    expect(seen[1]!.turn.prompt.startsWith(`${CONTEXT_LOST_NOTE}\n\n`)).toBe(true);
    expect(seen[1]!.turn.prompt).toContain('Pick up where the last attempt stopped.');
    expect(second.sessionRef).not.toBe(first.sessionRef);
    expect(await statusMessages(second)).toContain('Could not restore the earlier conversation; started a new one');
  });

  it("never hands one agent another agent's session", { timeout: T }, async () => {
    const { seen } = await chain('restorable', 'other');
    expect(seen[1]!.turn.resumeSessionId).toBeNull();
    expect(seen[1]!.turn.prompt.startsWith(CONTEXT_LOST_NOTE)).toBe(true);
  });

  it('leaves a first attempt alone', { timeout: T }, async () => {
    const { first, seen } = await chain('fresh');
    expect(seen[0]!.turn.prompt.startsWith(CONTEXT_LOST_NOTE)).toBe(false);
    expect(await statusMessages(first)).toEqual([]);
  });
});
