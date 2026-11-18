import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import { runEvents, runs, taskMembers, tasks } from '../src/db/schema';
import { createApp } from '../src/http/app';

const app = createApp();
let token = '';
let userId = '';
let agentId = '';
let otherAgentId = '';

/** pg surfaces SQLSTATE on the error; drizzle may wrap it as the cause. */
async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code;
  }
}

const auth = () => ({ Authorization: `Bearer ${token}` });

async function newTask(title: string): Promise<{ id: string; members: Map<string, string> }> {
  const res = await request(app)
    .post('/api/tasks')
    .set(auth())
    .send({ title, memberAgentIds: [agentId, otherAgentId] });
  const id = res.body.task.id as string;
  const rows = await db.select().from(taskMembers).where(eq(taskMembers.taskId, id));
  return { id, members: new Map(rows.map((r) => [r.agentId, r.id])) };
}

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  const reg = await request(app).post('/auth/register').send({
    email: 'constraints@example.com',
    username: 'constraintsuser',
    password: 'a-strong-password',
  });
  token = reg.body.token;
  userId = reg.body.user.id;
  for (const name of ['Signer A', 'Signer B']) {
    const res = await request(app).post('/api/agents').set(auth()).send({ name, runtime: 'api' });
    if (name === 'Signer A') agentId = res.body.agent.id;
    else otherAgentId = res.body.agent.id;
  }
});

describe('terminal statuses', () => {
  it('never lets a finished task change status again', async () => {
    const { id } = await newTask('Finished');
    await db.update(tasks).set({ status: 'done' }).where(eq(tasks.id, id));
    expect(await sqlState(db.update(tasks).set({ status: 'todo' }).where(eq(tasks.id, id)))).toBe(
      '23514'
    );
    expect(
      await sqlState(db.update(tasks).set({ status: 'cancelled' }).where(eq(tasks.id, id)))
    ).toBe('23514');
    // Other columns stay writable, and rewriting the same status is not a transition.
    expect(
      await sqlState(db.update(tasks).set({ title: 'Renamed', status: 'done' }).where(eq(tasks.id, id)))
    ).toBeUndefined();
  });

  it('keeps cancelled tasks cancelled', async () => {
    const { id } = await newTask('Dropped');
    await db.update(tasks).set({ status: 'cancelled' }).where(eq(tasks.id, id));
    expect(
      await sqlState(db.update(tasks).set({ status: 'backlog' }).where(eq(tasks.id, id)))
    ).toBe('23514');
  });

});

describe('streams and watermarks', () => {
  it('orders run events by a unique per-run sequence', async () => {
    const { id } = await newTask('Streaming');
    const [run] = await db
      .insert(runs)
      .values({ userId, agentId, agentName: 'Signer A', taskId: id, trigger: 'manual' })
      .returning();
    await db.insert(runEvents).values({ runId: run!.id, seq: 1, kind: 'message_delta', payload: { text: 'hi' } });
    expect(
      await sqlState(db.insert(runEvents).values({ runId: run!.id, seq: 1, kind: 'usage' }))
    ).toBe('23505');
  });

});
