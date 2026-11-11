import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/client';
import { createApp } from '../src/http/app';
import { addAgentComment } from '../src/modules/tasks/comments.service';

const app = createApp();
let token = '';
let otherToken = '';
let userId = '';
let agentId = '';
let taskId = '';

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  const reg = await request(app).post('/auth/register').send({
    email: 'comments@example.com',
    username: 'commentsuser',
    password: 'a-strong-password',
  });
  token = reg.body.token;
  userId = reg.body.user.id;

  const other = await request(app).post('/auth/register').send({
    email: 'comments-other@example.com',
    username: 'commentsother',
    password: 'a-strong-password',
  });
  otherToken = other.body.token;

  const agent = await request(app)
    .post('/api/agents')
    .set({ Authorization: `Bearer ${token}` })
    .send({ name: 'Commenting agent', runtime: 'api' });
  agentId = agent.body.agent.id;

  const task = await request(app)
    .post('/api/tasks')
    .set({ Authorization: `Bearer ${token}` })
    .send({ title: 'Discussed task' });
  taskId = task.body.task.id;
});

const auth = () => ({ Authorization: `Bearer ${token}` });
const otherAuth = () => ({ Authorization: `Bearer ${otherToken}` });

describe('task comments', () => {
  it('posts a human comment and lists it in order', async () => {
    const first = await request(app)
      .post(`/api/tasks/${taskId}/comments`)
      .set(auth())
      .send({ body: 'Found the root cause' });
    expect(first.status).toBe(201);
    expect(first.body.comment.authorType).toBe('human');
    expect(first.body.comment.authorUserId).toBe(userId);

    const second = await request(app)
      .post(`/api/tasks/${taskId}/comments`)
      .set(auth())
      .send({ body: 'Fix is up for review' });
    expect(second.status).toBe(201);

    const list = await request(app).get(`/api/tasks/${taskId}/comments`).set(auth());
    expect(list.status).toBe(200);
    const bodies = list.body.comments.map((c: { body: string }) => c.body);
    expect(bodies.indexOf('Found the root cause')).toBeLessThan(
      bodies.indexOf('Fix is up for review')
    );
  });

  it('rejects an empty body', async () => {
    const res = await request(app)
      .post(`/api/tasks/${taskId}/comments`)
      .set(auth())
      .send({ body: '   ' });
    expect(res.status).toBe(400);
  });

  it('records an agent-authored comment through the service', async () => {
    const comment = await addAgentComment(userId, taskId, agentId, 'Progress: tests are green');
    expect(comment.authorType).toBe('agent');
    expect(comment.authorAgentId).toBe(agentId);
    expect(comment.authorUserId).toBeNull();

    const list = await request(app).get(`/api/tasks/${taskId}/comments`).set(auth());
    expect(
      list.body.comments.some((c: { authorType: string }) => c.authorType === 'agent')
    ).toBe(true);
  });

  it('rejects a foreign agent as author', async () => {
    const foreignAgent = await request(app)
      .post('/api/agents')
      .set(otherAuth())
      .send({ name: 'Foreign commenter', runtime: 'api' });
    await expect(
      addAgentComment(userId, taskId, foreignAgent.body.agent.id, 'sneaky')
    ).rejects.toMatchObject({ code: 'invalid_author' });
  });

  it("hides comments on other users' tasks", async () => {
    const res = await request(app).get(`/api/tasks/${taskId}/comments`).set(otherAuth());
    expect(res.status).toBe(404);
    const post = await request(app)
      .post(`/api/tasks/${taskId}/comments`)
      .set(otherAuth())
      .send({ body: 'not my task' });
    expect(post.status).toBe(404);
  });

  it('removes comments with their task', async () => {
    const task = await request(app)
      .post('/api/tasks')
      .set(auth())
      .send({ title: 'Short-lived' });
    const shortId = task.body.task.id;
    await request(app)
      .post(`/api/tasks/${shortId}/comments`)
      .set(auth())
      .send({ body: 'soon gone' });
    await request(app).delete(`/api/tasks/${shortId}`).set(auth());

    const { rows } = await pool.query('SELECT count(*) FROM task_comments WHERE task_id = $1', [
      shortId,
    ]);
    expect(Number(rows[0].count)).toBe(0);
  });
});
