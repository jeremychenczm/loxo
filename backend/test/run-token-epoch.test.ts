import { and, count, eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import { agents, runs, tasks, turns } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { mintRunToken, verifyRunToken } from '../src/modules/control-plane/run-token';
import { buildControlPlaneToolDefs } from '../src/modules/control-plane/tools';
import { fenceRejectionsForTests } from '../src/modules/ownership/fence';
import { runLeases } from '../src/modules/ownership/lease';
import { setTaskHostFactoryForTests } from '../src/modules/runs/task-run';
import { drainRunsForTests } from '../src/modules/runs/wake';
import { scriptedHost } from './support/scripted-host';

const app = createApp();
let token = '';
const releases: Array<() => void> = [];
let parked: Promise<void> = Promise.resolve();
let entered: () => void = () => {};

const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  setTaskHostFactoryForTests(
    scriptedHost(async () => {
      entered();
      await new Promise<void>((resolve) => releases.push(resolve));
      return { text: 'done' };
    })
  );
  const reg = await request(app)
    .post('/auth/register')
    .send({ email: 'epoch@example.com', username: 'epochuser', password: 'a-strong-password' });
  token = reg.body.token;
});

afterAll(() => setTaskHostFactoryForTests(null));

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await drainRunsForTests();
});

/** A fresh agent and task with the agent's first run parked in `running` (epoch 1). */
async function startHeldRun(name: string) {
  parked = new Promise<void>((resolve) => (entered = resolve));
  const agent = await request(app).post('/api/agents').set(auth()).send({ name, runtime: 'claude-code' });
  const created = await request(app).post('/api/tasks').set(auth()).send({ title: `${name} task` });
  const taskId = created.body.task.id as string;
  await request(app).post(`/api/tasks/${taskId}/move`).set(auth()).send({ status: 'todo' });
  await request(app).patch(`/api/tasks/${taskId}`).set(auth()).send({ leadAgentId: agent.body.agent.id });
  await parked;
  const [run] = await db.select().from(runs).where(eq(runs.taskId, taskId));
  expect(run).toMatchObject({ status: 'running', ownerEpoch: 1 });
  return { run: run!, taskId, agentId: agent.body.agent.id as string };
}

/** Another instance claims the run under the next epoch; the row stays running. */
async function claimElsewhere(runId: string): Promise<void> {
  await db
    .update(runs)
    .set({
      ownerInstance: 'other-instance',
      ownerEpoch: sql`${runs.ownerEpoch} + 1`,
      leaseExpiresAt: sql`clock_timestamp() + interval '30 seconds'`,
    })
    .where(eq(runs.id, runId));
}

let callId = 0;
function callTool(runToken: string, name: string, args: Record<string, unknown> = {}) {
  callId += 1;
  return request(app)
    .post('/mcp')
    .set({
      Authorization: `Bearer ${runToken}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    })
    .send({ jsonrpc: '2.0', id: callId, method: 'tools/call', params: { name, arguments: args } });
}

async function agentTurnCount(taskId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(turns)
    .where(and(eq(turns.taskId, taskId), eq(turns.kind, 'agent')));
  return row!.n;
}

describe('run tokens bound to the owner epoch', () => {
  it('signs the epoch into the token', () => {
    const runId = '7b0f8a52-3c1e-4d7a-9f00-1a2b3c4d5e6f';
    const minted = mintRunToken(runId, 3);
    expect(verifyRunToken(minted)).toEqual({ runId, epoch: 3 });
    expect(verifyRunToken(minted.replace('_3_', '_4_'))).toBeNull();
    expect(verifyRunToken(minted.replace('_3_', '_03_'))).toBeNull();
    expect(verifyRunToken(mintRunToken(runId, 1).replace(runId, runId.replace('7b', '7c')))).toBeNull();
  });

  it('refuses a token from an earlier epoch and accepts the current one', async () => {
    const { run } = await startHeldRun('Epoch Worker');
    const first = mintRunToken(run.id, 1);
    expect((await callTool(first, 'get_task')).status).toBe(200);

    await claimElsewhere(run.id);
    const before = fenceRejectionsForTests();
    const stale = await callTool(first, 'get_task');
    expect(stale.status).toBe(401);
    expect(stale.body.error.message).toBe('Run token is from an earlier owner');
    expect(fenceRejectionsForTests()).toBe(before + 1);

    // Validity follows the epoch, not which instance serves the call.
    expect((await callTool(mintRunToken(run.id, 2), 'get_task')).status).toBe(200);
  });

  it('refuses calls on an expired lease and writes nothing', async () => {
    const { run, taskId } = await startHeldRun('Expired Worker');
    await db
      .update(runs)
      .set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(runs.id, run.id));

    const before = fenceRejectionsForTests();
    const res = await callTool(mintRunToken(run.id, 1), 'comment_on_task', { body: 'still here' });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Run lease expired');
    expect(fenceRejectionsForTests()).toBe(before + 1);
    expect(await agentTurnCount(taskId)).toBe(0);
  });

  it('refuses calls once this instance fences the run, before the database lease expires', async () => {
    const { run, taskId } = await startHeldRun('Fenced Worker');
    runLeases.get(run.id)!.lose('test: local deadline passed');

    // The row still names this instance as owner under epoch 1 with a live lease.
    const [row] = await db.select().from(runs).where(eq(runs.id, run.id));
    expect(row).toMatchObject({ status: 'running', ownerEpoch: 1, ownerInstance: runLeases.instance });
    const res = await callTool(mintRunToken(run.id, 1), 'comment_on_task', { body: 'after the fence' });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Run lost its lease');
    expect(await agentTurnCount(taskId)).toBe(0);
  });

  it('fences in-process tools under the same epoch check', async () => {
    const { run, taskId, agentId } = await startHeldRun('Api Worker');
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    const comment = buildControlPlaneToolDefs({ run, epoch: 1, agent: agent!, task: task! }).find(
      (def) => def.name === 'comment_on_task'
    )!;

    expect(await comment.execute({ body: 'first note' })).toBe('Comment posted');
    await claimElsewhere(run.id);
    await expect(comment.execute({ body: 'stale note' })).rejects.toMatchObject({ status: 401 });
    expect(await agentTurnCount(taskId)).toBe(1);
  });

  it('treats a settled run as inactive, not as a fence rejection', async () => {
    const { run } = await startHeldRun('Settled Worker');
    const runToken = mintRunToken(run.id, 1);
    for (const release of releases.splice(0)) release();
    await drainRunsForTests();

    const before = fenceRejectionsForTests();
    const res = await callTool(runToken, 'get_task');
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Run is not active');
    expect(fenceRejectionsForTests()).toBe(before);
  });
});
