import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/client';
import { createApp } from '../src/http/app';
import {
  acquireTaskLock,
  claimRun,
  createQueuedRun,
  finishRun,
  getRun,
  listRuns,
  nextQueuedRunForTask,
  releaseTaskLock,
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
    expect(run.status).toBe('queued');
    expect(run.trigger).toBe('assignment');
    expect(run.reason).toBe('assigned to Lock target');
    expect(run.output).toBe('');
    expect(run.startedAt).toBeNull();
    expect(run.agentName).toBe('Run worker');
  });

  it('claims a queued run exactly once', async () => {
    const run = await queueRun();
    const claimed = await claimRun(run.id);
    expect(claimed?.status).toBe('running');
    expect(claimed?.startedAt).not.toBeNull();

    const again = await claimRun(run.id);
    expect(again).toBeUndefined();
  });

  it('finishes a running run and refuses to finish it twice', async () => {
    const run = await queueRun();
    await claimRun(run.id);
    const done = await finishRun(run.id, {
      status: 'succeeded',
      output: 'patched the widget',
      sessionRef: 'sess-1',
      tokensIn: 10,
      tokensOut: 20,
    });
    expect(done.status).toBe('succeeded');
    expect(done.output).toBe('patched the widget');
    expect(done.sessionRef).toBe('sess-1');
    expect(done.finishedAt).not.toBeNull();

    await expect(finishRun(run.id, { status: 'failed' })).rejects.toMatchObject({ status: 404 });
  });

  it('cancels a queued run without claiming it', async () => {
    const run = await queueRun();
    const cancelled = await finishRun(run.id, { status: 'cancelled' });
    expect(cancelled.status).toBe('cancelled');
    expect(await claimRun(run.id)).toBeUndefined();
  });

  it('grants the task lock to exactly one concurrent contender', async () => {
    const contenders = await Promise.all(Array.from({ length: 8 }, () => queueRun()));
    const results = await Promise.all(contenders.map((run) => acquireTaskLock(taskId, run.id)));
    expect(results.filter(Boolean)).toHaveLength(1);

    const winner = contenders[results.findIndex(Boolean)]!;

    // A non-holder release is a no-op; the winner's release frees the lock.
    const loser = contenders[(results.findIndex(Boolean) + 1) % contenders.length]!;
    await releaseTaskLock(taskId, loser.id);
    expect(await acquireTaskLock(taskId, loser.id)).toBe(false);

    await releaseTaskLock(taskId, winner.id);
    expect(await acquireTaskLock(taskId, loser.id)).toBe(true);
    await releaseTaskLock(taskId, loser.id);
  });

  it('promotes queued runs oldest-first', async () => {
    const task = await request(app)
      .post('/api/tasks')
      .set({ Authorization: `Bearer ${token}` })
      .send({ title: 'Promotion order' });
    const first = await queueRun({ taskId: task.body.task.id });
    const second = await queueRun({ taskId: task.body.task.id });

    expect((await nextQueuedRunForTask(task.body.task.id))?.id).toBe(first.id);

    await finishRun(first.id, { status: 'cancelled' });
    expect((await nextQueuedRunForTask(task.body.task.id))?.id).toBe(second.id);

    await finishRun(second.id, { status: 'cancelled' });
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
