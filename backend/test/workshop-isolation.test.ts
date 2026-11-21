import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import { agents, humanRequests, runs, tasks, type Agent, type Task } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { askBlocker, submitResult, updateTaskStatus, type RunToolContext } from '../src/modules/control-plane/tools';
import { admitRun, createQueuedRun, ownerOf, settleRun } from '../src/modules/runs/runs.service';
import { drainRunsForTests } from '../src/modules/runs/wake';

/**
 * Workshop tasks belong to the engine: none of the legacy status-driven
 * paths may move them or wake their members.
 */
const app = createApp();
let token = '';
let userId = '';
let lead = '';
let peer = '';

const auth = () => ({ Authorization: `Bearer ${token}` });

async function newAgent(name: string): Promise<string> {
  const res = await request(app).post('/api/agents').set(auth()).send({ name, runtime: 'api' });
  expect(res.status).toBe(201);
  return (res.body.agent ?? res.body).id;
}

async function newTask(playbook: 'legacy' | 'build', title = 'Two-step login'): Promise<Task> {
  const res = await request(app)
    .post('/api/tasks')
    .set(auth())
    .send({ title, playbook, leadAgentId: lead, memberAgentIds: [lead, peer] });
  expect(res.status).toBe(201);
  const [row] = await db.select().from(tasks).where(eq(tasks.id, res.body.task.id));
  return row!;
}

async function runsOf(taskId: string) {
  return db.select().from(runs).where(eq(runs.taskId, taskId));
}

/** A running run on the task, as a control-plane call sees it. */
async function toolContext(task: Task, agentId: string): Promise<RunToolContext> {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  const queued = await createQueuedRun(userId, {
    agentId,
    agentName: agent!.name,
    taskId: task.id,
    trigger: 'dispatch',
  });
  const admitted = await admitRun(queued.id);
  expect(admitted).toBeDefined();
  return { run: admitted!.run, epoch: admitted!.run.ownerEpoch, agent: agent as Agent, task };
}

async function finish(ctx: RunToolContext): Promise<void> {
  await settleRun(ownerOf(ctx.run), { status: 'succeeded' });
}

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  const reg = await request(app).post('/auth/register').send({
    email: 'isolation@example.com',
    username: 'isolation',
    password: 'a-strong-password',
  });
  token = reg.body.token;
  userId = reg.body.user.id;
  lead = await newAgent('Lead');
  peer = await newAgent('Peer');
});

afterAll(async () => {
  await drainRunsForTests();
});

describe('workshop tasks and the legacy paths', () => {
  it('creates tasks on the legacy playbook unless asked otherwise', async () => {
    const res = await request(app).post('/api/tasks').set(auth()).send({ title: 'Plain' });
    expect(res.body.task).toMatchObject({ playbook: 'legacy', phase: null });
  });

  it('refuses status moves on a workshop task but still allows reordering', async () => {
    const task = await newTask('build');
    const moved = await request(app).post(`/api/tasks/${task.id}/move`).set(auth()).send({ status: 'todo' });
    expect(moved.status).toBe(409);
    expect(moved.body).toMatchObject({ code: 'workshop_status' });
    const reordered = await request(app)
      .post(`/api/tasks/${task.id}/move`)
      .set(auth())
      .send({ status: task.status, boardOrder: 42 });
    expect(reordered.status).toBe(200);
    expect(reordered.body.task.boardOrder).toBe(42);
    expect(await runsOf(task.id)).toEqual([]);
  });

  it('refuses a manual wake on a workshop task', async () => {
    const task = await newTask('build');
    const res = await request(app).post(`/api/tasks/${task.id}/wake`).set(auth()).send({});
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'workshop_task' });
    expect(await runsOf(task.id)).toEqual([]);
  });

  it('lets the roster change before the workshop starts without waking anyone', async () => {
    const task = await newTask('build');
    const res = await request(app).patch(`/api/tasks/${task.id}`).set(auth()).send({ leadAgentId: peer });
    expect(res.status).toBe(200);
    expect(res.body.task.leadAgentId).toBe(peer);
    expect(await runsOf(task.id)).toEqual([]);
  });

  it('fixes the roster and lead once the workshop has started', async () => {
    const task = await newTask('build');
    await db.update(tasks).set({ phase: 'explore' }).where(eq(tasks.id, task.id));
    const res = await request(app).patch(`/api/tasks/${task.id}`).set(auth()).send({ leadAgentId: peer });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'workshop_started' });
    const renamed = await request(app).patch(`/api/tasks/${task.id}`).set(auth()).send({ title: 'Renamed' });
    expect(renamed.status).toBe(200);
  });

  it('refuses update_task_status from an agent on a workshop task', async () => {
    const task = await newTask('build');
    const ctx = await toolContext(task, peer);
    await expect(updateTaskStatus(ctx, 'in_review')).rejects.toMatchObject({ status: 409, code: 'workshop_status' });
    await finish(ctx);
  });

  it("turns an agent's blocker on a workshop task into an open question, not a status", async () => {
    const task = await newTask('build');
    const ctx = await toolContext(task, peer);
    const result = await askBlocker(ctx, 'Which OTP library should we use?');
    await finish(ctx);
    expect(result.status).toBe(task.status);
    const requests = await db.select().from(humanRequests).where(eq(humanRequests.taskId, task.id));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      kind: 'input',
      status: 'open',
      runId: ctx.run.id,
      payload: { question: 'Which OTP library should we use?', agentId: peer },
    });
    const [after] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(after!.status).toBe(task.status);
  });

  it('records a submitted result on a workshop task without moving it or waking reviewers', async () => {
    const task = await newTask('build');
    const ctx = await toolContext(task, lead);
    const result = await submitResult(ctx, 'Added TOTP enrollment.');
    await finish(ctx);
    expect(result.status).toBe(task.status);
    const [after] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(after!.status).toBe(task.status);
    expect((await runsOf(task.id)).map((r) => r.id)).toEqual([ctx.run.id]);
  });

  it('keeps the legacy flow: submitting a result moves the task to review and wakes the reviewer', async () => {
    const task = await newTask('legacy', 'Legacy flow');
    await db.update(tasks).set({ status: 'in_progress' }).where(eq(tasks.id, task.id));
    const ctx = await toolContext({ ...task, status: 'in_progress' }, lead);
    const result = await submitResult(ctx, 'Done the legacy way.');
    await finish(ctx);
    expect(result.status).toBe('in_review');
    const reviewerRuns = (await runsOf(task.id)).filter((r) => r.trigger === 'review');
    expect(reviewerRuns.map((r) => r.agentId)).toEqual([peer]);
  });
});
