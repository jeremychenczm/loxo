import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/client';
import { createApp } from '../src/http/app';
import { addAgentTurn, addSystemTurn } from '../src/modules/tasks/turns.service';

const app = createApp();
let token = '';
let otherToken = '';
let userId = '';
let agentId = '';
let taskId = '';

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  const reg = await request(app).post('/auth/register').send({
    email: 'turns@example.com',
    username: 'turnsuser',
    password: 'a-strong-password',
  });
  token = reg.body.token;
  userId = reg.body.user.id;

  const other = await request(app).post('/auth/register').send({
    email: 'turns-other@example.com',
    username: 'turnsother',
    password: 'a-strong-password',
  });
  otherToken = other.body.token;

  const agent = await request(app)
    .post('/api/agents')
    .set({ Authorization: `Bearer ${token}` })
    .send({ name: 'Speaking agent', runtime: 'api' });
  agentId = agent.body.agent.id;

  const task = await request(app)
    .post('/api/tasks')
    .set({ Authorization: `Bearer ${token}` })
    .send({ title: 'Discussed task' });
  taskId = task.body.task.id;
});

const auth = () => ({ Authorization: `Bearer ${token}` });
const otherAuth = () => ({ Authorization: `Bearer ${otherToken}` });

describe('task turns', () => {
  it('records a human interjection and orders the timeline by seq', async () => {
    const first = await request(app)
      .post(`/api/tasks/${taskId}/turns`)
      .set(auth())
      .send({ content: 'Found the root cause' });
    expect(first.status).toBe(201);
    expect(first.body.turn).toMatchObject({
      kind: 'human',
      authorUserId: userId,
      agentId: null,
      status: 'completed',
      seq: 1,
    });

    await addSystemTurn(userId, taskId, 'Workspace prepared.');
    await request(app).post(`/api/tasks/${taskId}/turns`).set(auth()).send({ content: 'Ship it' });

    const list = await request(app).get(`/api/tasks/${taskId}/turns`).set(auth());
    expect(list.status).toBe(200);
    expect(list.body.turns.map((t: { seq: number }) => t.seq)).toEqual([1, 2, 3]);
    expect(list.body.turns.map((t: { kind: string }) => t.kind)).toEqual(['human', 'system', 'human']);
  });

  it('draws distinct seq values under concurrent appends', async () => {
    const task = await request(app).post('/api/tasks').set(auth()).send({ title: 'Busy timeline' });
    const id = task.body.task.id as string;
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        request(app).post(`/api/tasks/${id}/turns`).set(auth()).send({ content: `note ${i}` })
      )
    );
    const list = await request(app).get(`/api/tasks/${id}/turns`).set(auth());
    expect(list.body.turns.map((t: { seq: number }) => t.seq)).toEqual(
      Array.from({ length: 12 }, (_, i) => i + 1)
    );
  });

  it('rejects empty content', async () => {
    const res = await request(app)
      .post(`/api/tasks/${taskId}/turns`)
      .set(auth())
      .send({ content: '   ' });
    expect(res.status).toBe(400);
  });

  it('records an agent turn with its run and report', async () => {
    const turn = await addAgentTurn(userId, taskId, agentId, 'Progress: tests are green', {
      report: { type: 'progress' },
    });
    expect(turn.kind).toBe('agent');
    expect(turn.agentId).toBe(agentId);
    expect(turn.authorUserId).toBeNull();
    expect(turn.report).toEqual({ type: 'progress' });
  });

  it('rejects a foreign agent as author', async () => {
    const foreignAgent = await request(app)
      .post('/api/agents')
      .set(otherAuth())
      .send({ name: 'Foreign speaker', runtime: 'api' });
    await expect(
      addAgentTurn(userId, taskId, foreignAgent.body.agent.id, 'sneaky')
    ).rejects.toMatchObject({ code: 'invalid_author' });
  });

  it('enforces that the author matches the turn kind', async () => {
    const insert = (kind: string, agent: string | null, author: string | null) =>
      pool.query(
        `INSERT INTO turns (task_id, seq, kind, agent_id, author_user_id) VALUES ($1, $2, $3, $4, $5)`,
        [taskId, 9000 + Math.floor(Math.random() * 1000), kind, agent, author]
      );
    await expect(insert('human', agentId, userId)).rejects.toMatchObject({ code: '23514' });
    await expect(insert('system', null, userId)).rejects.toMatchObject({ code: '23514' });
    await expect(insert('agent', agentId, userId)).rejects.toMatchObject({ code: '23514' });
  });

  it("hides turns on other users' tasks", async () => {
    const res = await request(app).get(`/api/tasks/${taskId}/turns`).set(otherAuth());
    expect(res.status).toBe(404);
    const post = await request(app)
      .post(`/api/tasks/${taskId}/turns`)
      .set(otherAuth())
      .send({ content: 'not my task' });
    expect(post.status).toBe(404);
  });

  it('removes turns with their task', async () => {
    const task = await request(app).post('/api/tasks').set(auth()).send({ title: 'Short-lived' });
    const shortId = task.body.task.id;
    await request(app).post(`/api/tasks/${shortId}/turns`).set(auth()).send({ content: 'soon gone' });
    await request(app).delete(`/api/tasks/${shortId}`).set(auth());

    const { rows } = await pool.query('SELECT count(*) FROM turns WHERE task_id = $1', [shortId]);
    expect(Number(rows[0].count)).toBe(0);
  });
});
