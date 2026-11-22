import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import { agents, dispatches, runs, tasks } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { submitDispatchReport } from '../src/modules/control-plane/tools';
import { LeaseKeeper } from '../src/modules/ownership/lease';
import { reconcileOnce } from '../src/modules/ownership/reconciler';
import { admitRun, createQueuedRun, failQueuedRun } from '../src/modules/runs/runs.service';
import { setTaskHostFactoryForTests } from '../src/modules/runs/task-run';
import { drainRunsForTests, promoteQueuedRun } from '../src/modules/runs/wake';
import { scriptedHost } from './support/scripted-host';

/**
 * Admission by gate key: a worktree (or, for legacy runs, a whole task) runs
 * one run at a time, while runs on different gates of the same task run
 * together. The agent claim still spans tasks.
 */
const app = createApp();
let token = '';
let userId = '';

const auth = () => ({ Authorization: `Bearer ${token}` });

async function newAgent(name: string): Promise<string> {
  const res = await request(app).post('/api/agents').set(auth()).send({ name, runtime: 'claude-code' });
  return (res.body.agent ?? res.body).id;
}

async function newTask(title: string): Promise<string> {
  const res = await request(app).post('/api/tasks').set(auth()).send({ title });
  return res.body.task.id;
}

function queue(agentId: string, taskId: string, gateKey: string | null) {
  return createQueuedRun(userId, { agentId, agentName: 'gate', taskId, trigger: 'manual', gateKey });
}

async function release(runIds: string[]): Promise<void> {
  for (const id of runIds) {
    await db.update(runs).set({ status: 'failed', leaseExpiresAt: null }).where(eq(runs.id, id));
  }
  await db.update(agents).set({ status: 'idle' });
}

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  const reg = await request(app).post('/auth/register').send({
    email: 'gates@example.com',
    username: 'gates',
    password: 'a-strong-password',
  });
  token = reg.body.token;
  userId = reg.body.user.id;
});

afterEach(async () => {
  await drainRunsForTests();
  setTaskHostFactoryForTests(null);
});

afterAll(async () => {
  await drainRunsForTests();
});

describe('gate keys', () => {
  it('runs one run per gate, and runs on different gates of one task together', async () => {
    const [a, b, c] = [await newAgent('Gate A'), await newAgent('Gate B'), await newAgent('Gate C')];
    const taskId = await newTask('Two worktrees');
    const onFirst = await queue(a, taskId, 'ws:first');
    const onSecond = await queue(b, taskId, 'ws:second');
    const alsoFirst = await queue(c, taskId, 'ws:first');

    expect((await admitRun(onFirst.id))?.run.status).toBe('running');
    expect((await admitRun(onSecond.id))?.run.status).toBe('running');
    expect(await admitRun(alsoFirst.id)).toBeUndefined();
    await failQueuedRun(alsoFirst.id, 'cleanup');
    await release([onFirst.id, onSecond.id]);
  });

  it('still keeps an agent to one run across tasks, and a legacy task to one run', async () => {
    const [a, b] = [await newAgent('Busy'), await newAgent('Other')];
    const [one, two] = [await newTask('One'), await newTask('Two')];
    const first = await queue(a, one, `task:${one}`);
    expect((await admitRun(first.id))?.run.status).toBe('running');

    const sameAgent = await queue(a, two, `task:${two}`);
    expect(await admitRun(sameAgent.id)).toBeUndefined();
    const sameTask = await queue(b, one, `task:${one}`);
    expect(await admitRun(sameTask.id)).toBeUndefined();

    await failQueuedRun(sameAgent.id, 'cleanup');
    await failQueuedRun(sameTask.id, 'cleanup');
    await release([first.id]);
  });

  it('starts the next run waiting on a gate when the gate frees', async () => {
    let active = 0;
    let most = 0;
    setTaskHostFactoryForTests(
      scriptedHost(async () => {
        active += 1;
        most = Math.max(most, active);
        await new Promise((resolve) => setTimeout(resolve, 50));
        active -= 1;
        return { text: 'done' };
      })
    );
    const [a, b] = [await newAgent('Promote A'), await newAgent('Promote B')];
    const taskId = await newTask('Promotion by gate');
    const first = await queue(a, taskId, 'ws:shared');
    const second = await queue(b, taskId, 'ws:shared');
    expect(await promoteQueuedRun(first)).toBe(true);
    await drainRunsForTests();

    const [x] = await db.select().from(runs).where(eq(runs.id, first.id));
    const [y] = await db.select().from(runs).where(eq(runs.id, second.id));
    expect([x!.status, y!.status]).toEqual(['succeeded', 'succeeded']);
    // The second started only once the first had freed the gate.
    expect(most).toBe(1);
  });

  it('promotes a queued run on a free gate while another gate of the task is held', async () => {
    const [a, b] = [await newAgent('Holder'), await newAgent('Waiter')];
    const taskId = await newTask('Reconciler by gate');
    const held = await queue(a, taskId, 'ws:held');
    await admitRun(held.id, { instance: 'gate-holder' });
    const waiting = await queue(b, taskId, 'ws:free');
    setTaskHostFactoryForTests(scriptedHost(async () => ({ text: 'done' })));
    const keeper = new LeaseKeeper({ instance: 'gate-reconciler' });
    try {
      const pass = await reconcileOnce(keeper);
      expect(pass.promoted).toContain(waiting.id);
    } finally {
      await keeper.stop();
    }
    await drainRunsForTests();
    await release([held.id]);
  });

  it('lets the members of a workshop without a repository explore at the same time', async () => {
    let inside = 0;
    let bothInside!: () => void;
    const together = new Promise<void>((resolve) => (bothInside = resolve));
    setTaskHostFactoryForTests((req) =>
      scriptedHost(async () => {
        inside += 1;
        if (inside === 2) bothInside();
        // Each member waits for the other: with a per-task gate the second would never start.
        await Promise.race([
          together,
          new Promise((_, reject) => setTimeout(() => reject(new Error('members did not run together')), 5_000)),
        ]);
        const [run] = await db
          .select()
          .from(runs)
          .where(and(eq(runs.agentId, req.agent.id), eq(runs.status, 'running')));
        const [agent] = await db.select().from(agents).where(eq(agents.id, req.agent.id));
        const [dispatch] = await db.select().from(dispatches).where(eq(dispatches.id, run!.dispatchId!));
        const [task] = await db.select().from(tasks).where(eq(tasks.id, run!.taskId!));
        if (dispatch!.phase === 'explore') {
          await submitDispatchReport({ run: run!, epoch: run!.ownerEpoch, agent: agent!, task: task! }, 'submit_exploration', { ok: true });
        }
        return { text: 'Looked.' };
      })(req)
    );
    const ids = [await newAgent('Together A'), await newAgent('Together B')];
    const created = await request(app)
      .post('/api/tasks')
      .set(auth())
      .send({ title: 'Explore together', playbook: 'build', leadAgentId: ids[0], memberAgentIds: ids });
    await request(app).post(`/api/tasks/${created.body.task.id}/start`).set(auth());
    await together;
    await drainRunsForTests();
    const explored = await db.select().from(dispatches).where(eq(dispatches.taskId, created.body.task.id));
    expect(explored.filter((d) => d.phase === 'explore').map((d) => d.status)).toEqual(['reported', 'reported']);
  });
});
