import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/client';
import { createApp } from '../src/http/app';
import { setTaskTurnExecutorForTests } from '../src/modules/runs/task-run';
import { drainRunsForTests } from '../src/modules/runs/wake';

const app = createApp();
let token = '';
let agentId = '';

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  setTaskTurnExecutorForTests(async () => ({ text: 'stub report', durationMs: 5 }));

  const reg = await request(app).post('/auth/register').send({
    email: 'approvals@example.com',
    username: 'approvalsuser',
    password: 'a-strong-password',
  });
  token = reg.body.token;

  const agent = await request(app)
    .post('/api/agents')
    .set({ Authorization: `Bearer ${token}` })
    .send({ name: 'Review worker', runtime: 'claude-code' });
  agentId = agent.body.agent.id;
});

afterAll(() => {
  setTaskTurnExecutorForTests(null);
});

const auth = () => ({ Authorization: `Bearer ${token}` });

async function createTask(title: string, body: Record<string, unknown> = {}) {
  const res = await request(app).post('/api/tasks').set(auth()).send({ title, ...body });
  return res.body.task as { id: string; number: number; repositoryId: string | null };
}

async function moveTo(taskId: string, status: string) {
  const res = await request(app).post(`/api/tasks/${taskId}/move`).set(auth()).send({ status });
  expect(res.status).toBe(200);
}

/** backlog -> todo -> in_progress -> in_review, without waking anyone. */
async function walkToReview(taskId: string) {
  await moveTo(taskId, 'todo');
  await moveTo(taskId, 'in_progress');
  await moveTo(taskId, 'in_review');
}

function decide(taskId: string, decision: string, body: string) {
  return request(app).post(`/api/tasks/${taskId}/approvals`).set(auth()).send({ decision, body });
}

async function timeline(taskId: string): Promise<string[]> {
  const res = await request(app).get(`/api/tasks/${taskId}/turns`).set(auth());
  return res.body.turns.map((t: { content: string }) => t.content);
}

describe('task approvals', () => {
  it('rejects a decision unless the task is in review', async () => {
    const task = await createTask('Not ready');
    const res = await decide(task.id, 'approved', 'nice');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('not_in_review');
  });

  it('requires a decision and a non-empty comment', async () => {
    const task = await createTask('Strict input');
    await walkToReview(task.id);
    expect((await decide(task.id, 'approved', '   ')).status).toBe(400);
    expect((await decide(task.id, 'maybe', 'x')).status).toBe(400);
  });

  it('approval closes a task without code and stamps the timeline', async () => {
    const task = await createTask('Ship it');
    await walkToReview(task.id);

    const res = await decide(task.id, 'approved', 'Looks good, verified locally.');
    expect(res.status).toBe(201);
    expect(res.body.approval).toMatchObject({ decision: 'approved', fingerprint: null });

    const detail = await request(app).get(`/api/tasks/${task.id}`).set(auth());
    expect(detail.body.task.status).toBe('done');
    expect(detail.body.task.closedAt).not.toBeNull();
    expect(await timeline(task.id)).toContain('[APPROVED] Looks good, verified locally.');

    const listed = await request(app).get(`/api/tasks/${task.id}/approvals`).set(auth());
    expect(listed.body.approvals).toHaveLength(1);
  });

  it('requested changes reopen work and re-wake the lead', async () => {
    const task = await createTask('Needs rework', { leadAgentId: agentId });
    await moveTo(task.id, 'todo');
    await drainRunsForTests();

    await moveTo(task.id, 'in_progress');
    await moveTo(task.id, 'in_review');

    const res = await decide(task.id, 'changes_requested', 'The button is still misaligned on mobile.');
    expect(res.status).toBe(201);
    await drainRunsForTests();

    const detail = await request(app).get(`/api/tasks/${task.id}`).set(auth());
    expect(detail.body.task.status).toBe('in_progress');
    expect(await timeline(task.id)).toContain(
      '[CHANGES REQUESTED] The button is still misaligned on mobile.'
    );

    // The rework wake produced a second run.
    const runs = await request(app).get(`/api/runs?taskId=${task.id}`).set(auth());
    expect(runs.body.runs.length).toBe(2);
    expect(runs.body.runs.every((r: { status: string }) => r.status === 'succeeded')).toBe(true);
  });

  it('scopes approvals to the owning user', async () => {
    const other = await request(app).post('/auth/register').send({
      email: 'approvals-other@example.com',
      username: 'approvalsother',
      password: 'a-strong-password',
    });
    const task = await createTask('Private');
    await walkToReview(task.id);
    const res = await request(app)
      .post(`/api/tasks/${task.id}/approvals`)
      .set({ Authorization: `Bearer ${other.body.token}` })
      .send({ decision: 'approved', body: 'sneaky' });
    expect(res.status).toBe(404);
  });
});
