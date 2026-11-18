import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import { agents, runs, tasks } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { buildControlPlaneToolDefs } from '../src/modules/control-plane/tools';
import { armCrashPointForTests, type CrashPoint } from '../src/modules/ownership/crash-points';
import { runLeases } from '../src/modules/ownership/lease';
import { reconcileOnce } from '../src/modules/ownership/reconciler';
import { setTaskHostFactoryForTests } from '../src/modules/runs/task-run';
import { drainRunsForTests } from '../src/modules/runs/wake';
import { moveTask } from '../src/modules/tasks/tasks.service';
import { scriptedHost } from './support/scripted-host';

const app = createApp();
let token = '';
let userId = '';
const releases: Array<() => void> = [];
let entered: () => void = () => {};
/** Only the first run of a test parks; runs started later finish at once. */
let parkNext = false;

const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  setTaskHostFactoryForTests(
    scriptedHost(async () => {
      if (parkNext) {
        parkNext = false;
        entered();
        await new Promise<void>((resolve) => releases.push(resolve));
      }
      return { text: 'done' };
    })
  );
  const reg = await request(app)
    .post('/auth/register')
    .send({ email: 'outbox@example.com', username: 'outboxuser', password: 'a-strong-password' });
  token = reg.body.token;
  userId = reg.body.user.id;
});

afterAll(() => setTaskHostFactoryForTests(null));

afterEach(async () => {
  parkNext = false;
  for (const release of releases.splice(0)) release();
  await drainRunsForTests();
});

async function createAgent(name: string): Promise<string> {
  const res = await request(app).post('/api/agents').set(auth()).send({ name, runtime: 'claude-code' });
  return res.body.agent.id;
}

/** A backlog task with a lead (and optional reviewer); backlog wakes nobody. */
async function createTask(title: string, lead: string, reviewer?: string): Promise<string> {
  const created = await request(app).post('/api/tasks').set(auth()).send({ title });
  const taskId = created.body.task.id as string;
  const members = reviewer ? [lead, reviewer] : [lead];
  await request(app).patch(`/api/tasks/${taskId}`).set(auth()).send({ leadAgentId: lead, memberAgentIds: members });
  expect(await runsOf(taskId)).toEqual([]);
  return taskId;
}

async function runsOf(taskId: string) {
  return db
    .select({ id: runs.id, agentId: runs.agentId, status: runs.status, trigger: runs.trigger })
    .from(runs)
    .where(eq(runs.taskId, taskId));
}

async function withCrash<T>(point: CrashPoint, action: () => Promise<T>): Promise<void> {
  const disarm = armCrashPointForTests(point);
  try {
    await expect(action()).rejects.toThrow(`crash point ${point}`);
  } finally {
    disarm();
  }
}

/** The lead's run parked in `running`, with the in-process control-plane tools bound to it. */
async function holdLeadRun(taskId: string) {
  const parked = new Promise<void>((resolve) => (entered = resolve));
  parkNext = true;
  await moveTask(userId, taskId, { status: 'todo' });
  await parked;
  const [run] = await db.select().from(runs).where(and(eq(runs.taskId, taskId), eq(runs.status, 'running')));
  const [agent] = await db.select().from(agents).where(eq(agents.id, run!.agentId!));
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  const tools = buildControlPlaneToolDefs({ run: run!, epoch: run!.ownerEpoch, agent: agent!, task: task! });
  return { run: run!, tool: (name: string) => tools.find((def) => def.name === name)! };
}

describe('wakes as an outbox in the writing transaction', () => {
  it('keeps the wake of a move that crashed before starting it, and the reconciler starts it', async () => {
    const lead = await createAgent('Outbox Lead');
    const taskId = await createTask('Crash after commit', lead);

    await withCrash('wake.before_start', () => moveTask(userId, taskId, { status: 'todo' }));

    const [task] = await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId));
    expect(task!.status).toBe('todo');
    const queued = await runsOf(taskId);
    expect(queued).toMatchObject([{ agentId: lead, status: 'queued', trigger: 'assignment' }]);

    const result = await reconcileOnce(runLeases);
    expect(result.promoted).toEqual([queued[0]!.id]);
    await drainRunsForTests();
    expect(await runsOf(taskId)).toMatchObject([{ id: queued[0]!.id, status: 'succeeded' }]);
  });

  it('keeps the wake a control-plane write queued when the process dies right after commit', async () => {
    const lead = await createAgent('Tool Lead');
    const reviewer = await createAgent('Tool Reviewer');
    const taskId = await createTask('Tool crash after commit', lead, reviewer);
    const { tool } = await holdLeadRun(taskId);

    await withCrash('wake.before_start', () => tool('submit_result').execute({ summary: 'Ready for review.' }));

    const review = (await runsOf(taskId)).filter((r) => r.trigger === 'review');
    expect(review).toMatchObject([{ agentId: reviewer, status: 'queued' }]);
    // The write itself committed: a repeat is answered from the stored result.
    expect(JSON.parse(await tool('submit_result').execute({ summary: 'Ready for review.' }))).toEqual({
      status: 'in_review',
    });

    // The task gate holds the review until the lead's run finishes; then it runs.
    for (const release of releases.splice(0)) release();
    await drainRunsForTests();
    await reconcileOnce(runLeases);
    await drainRunsForTests();
    const [after] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, review[0]!.id));
    expect(after!.status).toBe('succeeded');
  });

  it('queues nothing when the writing transaction rolls back', async () => {
    const lead = await createAgent('Rollback Lead');
    const reviewer = await createAgent('Rollback Reviewer');
    const taskId = await createTask('Rolled back write', lead, reviewer);
    const { tool } = await holdLeadRun(taskId);

    await withCrash('control_plane.before_record', () =>
      tool('submit_result').execute({ summary: 'Never committed.' })
    );

    expect((await runsOf(taskId)).filter((r) => r.trigger === 'review')).toEqual([]);
  });
});
