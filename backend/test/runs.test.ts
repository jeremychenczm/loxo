import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/client';
import { createApp } from '../src/http/app';
import { eq } from 'drizzle-orm';
import { config } from '../src/config';
import { db } from '../src/db/client';
import { runs } from '../src/db/schema';
import { instanceId } from '../src/modules/ownership/instance';
import {
  admitRun,
  createQueuedRun,
  failQueuedRun,
  getRun,
  listRuns,
  nextQueuedRunForTask,
  ownerOf,
  settleRun,
} from '../src/modules/runs/runs.service';

const app = createApp();
let token = '';
let userId = '';
let otherUserId = '';
let agentId = '';
let taskId = '';

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  const reg = await request(app).post('/auth/register').send({
    email: 'runs@example.com',
    username: 'runsuser',
    password: 'a-strong-password',
  });
  token = reg.body.token;
  userId = reg.body.user.id;

  const other = await request(app).post('/auth/register').send({
    email: 'runs-other@example.com',
    username: 'runsother',
    password: 'a-strong-password',
  });
  otherUserId = other.body.user.id;

  const agent = await request(app)
    .post('/api/agents')
    .set({ Authorization: `Bearer ${token}` })
    .send({ name: 'Run worker', runtime: 'api' });
  agentId = agent.body.agent.id;

  const task = await request(app)
    .post('/api/tasks')
    .set({ Authorization: `Bearer ${token}` })
    .send({ title: 'Lock target' });
  taskId = task.body.task.id;
});

async function owned(runId: string) {
  return ownerOf(await getRun(userId, runId));
}

function queueRun(overrides: { taskId?: string | null; reason?: string } = {}) {
  return createQueuedRun(userId, {
    agentId,
    agentName: 'Run worker',
    taskId: overrides.taskId === undefined ? taskId : overrides.taskId,
    trigger: 'assignment',
    reason: overrides.reason,
  });
}

describe('runs service', () => {
  it('creates a queued run with defaults', async () => {
    const run = await queueRun({ reason: 'assigned to Lock target' });
    await failQueuedRun(run.id, 'cleanup');
    expect(run.status).toBe('queued');
    expect(run.trigger).toBe('assignment');
    expect(run.reason).toBe('assigned to Lock target');
    expect(run.output).toBe('');
    expect(run.startedAt).toBeNull();
    expect(run.agentName).toBe('Run worker');
    expect(run).toMatchObject({ actor: 'agent', gateKey: `task:${taskId}`, workspaceId: null, dispatchId: null });
  });

  it('gives a run without a task no gate key', async () => {
    const run = await queueRun({ taskId: null });
    await failQueuedRun(run.id, 'cleanup');
    expect(run.gateKey).toBeNull();
  });

  it('admits a queued run exactly once, with a new epoch and a lease on the database clock', async () => {
    const run = await queueRun();
    const admission = await admitRun(run.id);
    expect(admission?.run).toMatchObject({ status: 'running', ownerInstance: instanceId, ownerEpoch: 1 });
    expect(admission?.run.startedAt).not.toBeNull();
    expect(admission!.leaseRemainingMs).toBeGreaterThan(config.runLeaseTtlMs - 2_000);
    expect(admission!.leaseRemainingMs).toBeLessThanOrEqual(config.runLeaseTtlMs);

    expect(await admitRun(run.id)).toBeUndefined();
    await settleRun(await owned(run.id), { status: 'succeeded' }, 'idle');
  });

  it('settles a running run, drops its lease, and refuses to settle it twice', async () => {
    const run = await queueRun();
    await admitRun(run.id);
    const done = await settleRun(await owned(run.id),
      { status: 'succeeded', output: 'patched the widget', sessionRef: 'sess-1', tokensIn: 10, tokensOut: 20 },
      'idle'
    );
    expect(done).toMatchObject({ status: 'succeeded', output: 'patched the widget', sessionRef: 'sess-1' });
    expect(done?.finishedAt).not.toBeNull();
    expect(done?.leaseExpiresAt).toBeNull();
    expect(done?.ownerEpoch).toBe(1);

    expect(await settleRun(await owned(run.id), { status: 'failed' }, 'error')).toBeUndefined();
  });

  it('fails a queued run without admitting it', async () => {
    const run = await queueRun();
    await failQueuedRun(run.id, 'Agent no longer exists');
    expect((await getRun(userId, run.id)).status).toBe('failed');
    expect(await admitRun(run.id)).toBeUndefined();
  });

  it('admits exactly one of many concurrent contenders and frees the gates on settlement', async () => {
    const contenders = await Promise.all(Array.from({ length: 8 }, () => queueRun()));
    const results = await Promise.all(contenders.map((run) => admitRun(run.id)));
    const winners = results.filter(Boolean);
    expect(winners).toHaveLength(1);
    const loser = contenders.find((run) => run.id !== winners[0]!.run.id)!;
    expect((await getRun(userId, loser.id)).status).toBe('queued');

    await settleRun(await owned(winners[0]!.run.id), { status: 'succeeded' }, 'idle');
    expect(await admitRun(loser.id)).toBeDefined();
    await settleRun(await owned(loser.id), { status: 'succeeded' }, 'idle');
    for (const run of contenders) await failQueuedRun(run.id, 'cleanup');
  });

  it('holds a backing-off run until its not_before passes', async () => {
    const run = await queueRun();
    await db.update(runs).set({ notBefore: new Date(Date.now() + 60_000) }).where(eq(runs.id, run.id));
    expect(await nextQueuedRunForTask(taskId)).toBeUndefined();
    expect(await admitRun(run.id)).toBeUndefined();

    await db.update(runs).set({ notBefore: new Date(Date.now() - 1_000) }).where(eq(runs.id, run.id));
    expect((await nextQueuedRunForTask(taskId))?.id).toBe(run.id);
    expect(await admitRun(run.id)).toBeDefined();
    await settleRun(await owned(run.id), { status: 'succeeded' }, 'idle');
  });

  it('promotes queued runs oldest-first', async () => {
    const task = await request(app)
      .post('/api/tasks')
      .set({ Authorization: `Bearer ${token}` })
      .send({ title: 'Promotion order' });
    const first = await queueRun({ taskId: task.body.task.id });
    const second = await queueRun({ taskId: task.body.task.id });

    expect((await nextQueuedRunForTask(task.body.task.id))?.id).toBe(first.id);

    await failQueuedRun(first.id, 'cancelled');
    expect((await nextQueuedRunForTask(task.body.task.id))?.id).toBe(second.id);

    await failQueuedRun(second.id, 'cancelled');
    expect(await nextQueuedRunForTask(task.body.task.id)).toBeUndefined();
  });

  it('scopes reads to the owning user', async () => {
    const run = await queueRun();
    await expect(getRun(otherUserId, run.id)).rejects.toMatchObject({ status: 404 });

    const mine = await listRuns(userId, { taskId });
    expect(mine.some((r) => r.id === run.id)).toBe(true);
    expect(await listRuns(otherUserId, {})).toHaveLength(0);
  });
});
