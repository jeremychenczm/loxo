import { and, eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { db, pool } from '../src/db/client';
import { agents, runs } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { armCrashPointForTests } from '../src/modules/ownership/crash-points';
import { admitRun, createQueuedRun, getRun, settleRun } from '../src/modules/runs/runs.service';
import { setTaskHostFactoryForTests } from '../src/modules/runs/task-run';
import { drainRunsForTests, requestWake } from '../src/modules/runs/wake';
import { scriptedHost } from './support/scripted-host';

/**
 * Admission under contention. More wakes than pool connections race for one
 * shared gate; the gate indexes must let exactly one through, nobody may
 * hang waiting for a connection, and promotion must drain the rest.
 */
const app = createApp();
const CONTENDERS = config.dbPoolMax + 5;
let token = '';
let userId = '';

/** The first turn parks here so the test can inspect the gates mid-run. */
let entered: () => void = () => {};
let release: () => void = () => {};
let parked = Promise.resolve();

function parkFirstTurn(): Promise<void> {
  const inside = new Promise<void>((resolve) => (entered = resolve));
  parked = new Promise<void>((resolve) => (release = resolve));
  return inside;
}

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  setTaskHostFactoryForTests(
    scriptedHost(async () => {
      entered();
      await parked;
      return { text: 'done' };
    })
  );
  const reg = await request(app).post('/auth/register').send({
    email: 'admission@example.com',
    username: 'admission',
    password: 'a-strong-password',
  });
  token = reg.body.token;
  userId = reg.body.user.id;
});

afterAll(async () => {
  release();
  await drainRunsForTests();
  setTaskHostFactoryForTests(null);
});

const auth = () => ({ Authorization: `Bearer ${token}` });

async function createAgents(prefix: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const res = await request(app).post('/api/agents').set(auth()).send({ name: `${prefix} ${i}`, runtime: 'claude-code' });
    ids.push(res.body.agent.id);
  }
  return ids;
}

async function createTasks(prefix: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const res = await request(app).post('/api/tasks').set(auth()).send({ title: `${prefix} ${i}` });
    ids.push(res.body.task.id);
  }
  return ids;
}

/** Largest number of running runs any single agent or task holds right now. */
async function maxRunningPerGate(): Promise<{ perAgent: number; perTask: number }> {
  const { rows } = await pool.query<{ per_agent: number; per_task: number }>(`
    SELECT
      COALESCE((SELECT max(n) FROM (SELECT count(*)::int AS n FROM runs WHERE status = 'running' GROUP BY agent_id) a), 0) AS per_agent,
      COALESCE((SELECT max(n) FROM (SELECT count(*)::int AS n FROM runs WHERE status = 'running' GROUP BY task_id) t), 0) AS per_task`);
  return { perAgent: rows[0]!.per_agent, perTask: rows[0]!.per_task };
}

async function statusesFor(ids: string[]): Promise<string[]> {
  const rows = await db.select({ status: runs.status }).from(runs).where(inArray(runs.id, ids));
  return rows.map((r) => r.status);
}

describe('admission under contention', () => {
  it.each([
    ['many agents race for one task', 'task'],
    ['one agent races across many tasks', 'agent'],
  ] as const)('%s: one runs, the rest queue, and all of them finish', async (_label, shared) => {
    const inside = parkFirstTurn();
    const agentIds = shared === 'task' ? await createAgents('Racer', CONTENDERS) : await createAgents('Solo', 1);
    const taskIds = shared === 'task' ? await createTasks('Contested', 1) : await createTasks('Queue', CONTENDERS);

    const decisions = await Promise.all(
      Array.from({ length: CONTENDERS }, (_, i) =>
        requestWake(userId, {
          agentId: agentIds[shared === 'task' ? i : 0]!,
          taskId: taskIds[shared === 'task' ? 0 : i]!,
          trigger: 'manual',
        })
      )
    );
    await inside;

    const admitted = decisions.map((d) => d.admitted);
    expect(admitted.filter((a) => a === 'started')).toHaveLength(1);
    expect(admitted.filter((a) => a === 'queued')).toHaveLength(CONTENDERS - 1);
    expect(await maxRunningPerGate()).toEqual({ perAgent: 1, perTask: 1 });

    release();
    await drainRunsForTests();
    const finished = await statusesFor(decisions.map((d) => d.run.id));
    expect(finished).toHaveLength(CONTENDERS);
    expect(finished.every((s) => s === 'succeeded')).toBe(true);
  }, 60_000);
});

describe('admission atomicity', () => {
  it('leaves nothing behind when admission fails part-way', async () => {
    const [agentId] = await createAgents('Fragile', 1);
    const [taskId] = await createTasks('Fragile', 1);
    const run = await createQueuedRun(userId, { agentId: agentId!, agentName: 'Fragile 0', taskId, trigger: 'manual' });

    const disarm = armCrashPointForTests('admission.after_claim');
    try {
      await expect(admitRun(run.id)).rejects.toThrow('crash point admission.after_claim');
    } finally {
      disarm();
    }

    expect(await getRun(userId, run.id)).toMatchObject({
      status: 'queued',
      ownerInstance: null,
      ownerEpoch: 0,
      leaseExpiresAt: null,
      startedAt: null,
    });
    const [agent] = await db.select({ status: agents.status }).from(agents).where(eq(agents.id, agentId!));
    expect(agent!.status).toBe('idle');

    // Both gates are still free.
    const admission = await admitRun(run.id);
    expect(admission?.run.ownerEpoch).toBe(1);
    await settleRun(run.id, { status: 'succeeded' }, 'idle');
  });

  it('refuses a second running run or an ownerless one at the database', async () => {
    const [agentId] = await createAgents('Guarded', 1);
    const [first, second] = await createTasks('Guarded', 2);
    const a = await createQueuedRun(userId, { agentId: agentId!, agentName: 'Guarded 0', taskId: first, trigger: 'manual' });
    const b = await createQueuedRun(userId, { agentId: agentId!, agentName: 'Guarded 0', taskId: second, trigger: 'manual' });
    await admitRun(a.id);

    const lease = { ownerInstance: 'elsewhere', leaseExpiresAt: new Date(Date.now() + 60_000) };
    await expect(
      db.update(runs).set({ status: 'running', ...lease }).where(eq(runs.id, b.id))
    ).rejects.toMatchObject({ code: '23505', constraint: 'runs_one_running_per_agent' });

    await settleRun(a.id, { status: 'succeeded' }, 'idle');
    await expect(
      db.update(runs).set({ status: 'running' }).where(and(eq(runs.id, b.id), eq(runs.status, 'queued')))
    ).rejects.toMatchObject({ code: '23514', constraint: 'runs_running_has_lease' });
  });
});
