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
    email: 'reviews@example.com',
    username: 'reviewsuser',
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

async function createTask(title: string) {
  const res = await request(app).post('/api/tasks').set(auth()).send({ title });
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

function review(taskId: string, decision: string, body: string) {
  return request(app)
    .post(`/api/tasks/${taskId}/reviews`)
    .set(auth())
    .send({ decision, body });
}

describe('task reviews', () => {
  it('rejects a review unless the task is in review', async () => {
    const task = await createTask('Not ready');
    const res = await review(task.id, 'approved', 'nice');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('not_in_review');
  });

  it('requires a decision and a non-empty comment', async () => {
    const task = await createTask('Strict input');
    await walkToReview(task.id);
    expect((await review(task.id, 'approved', '   ')).status).toBe(400);
    expect(
      (
        await request(app)
          .post(`/api/tasks/${task.id}/reviews`)
          .set(auth())
          .send({ decision: 'maybe', body: 'x' })
      ).status
    ).toBe(400);
  });

  it('approve closes the task and stamps the timeline', async () => {
    const task = await createTask('Ship it');
    await walkToReview(task.id);

    const res = await review(task.id, 'approved', 'Looks good, verified locally.');
    expect(res.status).toBe(201);
    expect(res.body.review.decision).toBe('approved');
    expect(res.body.review.reviewerType).toBe('human');

    const detail = await request(app).get(`/api/tasks/${task.id}`).set(auth());
    expect(detail.body.task.status).toBe('done');
    expect(detail.body.task.closedAt).not.toBeNull();

    const comments = await request(app).get(`/api/tasks/${task.id}/comments`).set(auth());
    const bodies = comments.body.comments.map((c: { body: string }) => c.body);
    expect(bodies).toContain('[APPROVED] Looks good, verified locally.');

    const listed = await request(app).get(`/api/tasks/${task.id}/reviews`).set(auth());
    expect(listed.body.reviews).toHaveLength(1);
  });

  it('request changes reopens work and re-wakes the assignee', async () => {
    const task = await createTask('Needs rework');
    await request(app)
      .patch(`/api/tasks/${task.id}`)
      .set(auth())
      .send({ assignee: { agentId } });
    await moveTo(task.id, 'todo');
    await drainRunsForTests(); // assignment wake settles

    await moveTo(task.id, 'in_progress');
    await moveTo(task.id, 'in_review');

    const res = await review(task.id, 'changes_requested', 'The button is still misaligned on mobile.');
    expect(res.status).toBe(201);
    await drainRunsForTests();

    const detail = await request(app).get(`/api/tasks/${task.id}`).set(auth());
    expect(detail.body.task.status).toBe('in_progress');

    const comments = await request(app).get(`/api/tasks/${task.id}/comments`).set(auth());
    const bodies = comments.body.comments.map((c: { body: string }) => c.body);
    expect(bodies).toContain('[CHANGES REQUESTED] The button is still misaligned on mobile.');

    // The rework wake produced a second run.
    const runs = await request(app).get(`/api/runs?taskId=${task.id}`).set(auth());
    expect(runs.body.runs.length).toBe(2);
    expect(runs.body.runs.every((r: { status: string }) => r.status === 'succeeded')).toBe(true);
  });

  it('scopes reviews to the owning user', async () => {
    const other = await request(app).post('/auth/register').send({
      email: 'reviews-other@example.com',
      username: 'reviewsother',
      password: 'a-strong-password',
    });
    const task = await createTask('Private');
    await walkToReview(task.id);
    const res = await request(app)
      .post(`/api/tasks/${task.id}/reviews`)
      .set({ Authorization: `Bearer ${other.body.token}` })
      .send({ decision: 'approved', body: 'sneaky' });
    expect(res.status).toBe(404);
  });
});
