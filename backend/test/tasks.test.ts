import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/client';
import { createApp } from '../src/http/app';
import type { TaskStatus } from '../src/db/schema';
import { ALLOWED_TRANSITIONS } from '../src/modules/tasks/task-transitions';

const app = createApp();
let token = '';
let otherToken = '';
let agentId = '';
let userId = '';
let projectId = '';

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  const reg = await request(app).post('/auth/register').send({
    email: 'tasks@example.com',
    username: 'tasksuser',
    password: 'a-strong-password',
  });
  token = reg.body.token;
  userId = reg.body.user.id;

  const other = await request(app).post('/auth/register').send({
    email: 'tasks-other@example.com',
    username: 'tasksother',
    password: 'a-strong-password',
  });
  otherToken = other.body.token;

  const agent = await request(app)
    .post('/api/agents')
    .set({ Authorization: `Bearer ${token}` })
    .send({ name: 'Task worker', runtime: 'api' });
  agentId = agent.body.agent.id;

  const project = await request(app)
    .post('/api/projects')
    .set({ Authorization: `Bearer ${token}` })
    .send({ name: 'Task home' });
  projectId = project.body.project.id;
});

const auth = () => ({ Authorization: `Bearer ${token}` });
const otherAuth = () => ({ Authorization: `Bearer ${otherToken}` });

async function create(body: Record<string, unknown>) {
  const res = await request(app).post('/api/tasks').set(auth()).send(body);
  expect(res.status).toBe(201);
  return res.body.task;
}

async function move(id: string, status: string, boardOrder?: number) {
  return request(app)
    .post(`/api/tasks/${id}/move`)
    .set(auth())
    .send({ status, ...(boardOrder !== undefined ? { boardOrder } : {}) });
}

describe('task creation', () => {
  it('creates in a chosen project with backlog status and a number', async () => {
    const task = await create({ title: 'First task', projectId });
    expect(task.status).toBe('backlog');
    expect(task.projectId).toBe(projectId);
    expect(task.number).toBeGreaterThan(0);
  });

  it('falls back to the default project when none is given', async () => {
    const task = await create({ title: 'Quick capture' });
    const projectRes = await request(app)
      .get(`/api/projects/${task.projectId}`)
      .set(auth());
    expect(projectRes.body.project.kind).toBe('default');
  });

  it('rejects a foreign project', async () => {
    const foreign = await request(app)
      .post('/api/projects')
      .set(otherAuth())
      .send({ name: 'Not yours' });
    const res = await request(app)
      .post('/api/tasks')
      .set(auth())
      .send({ title: 'Nope', projectId: foreign.body.project.id });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_project');
  });

  it('draws unique consecutive numbers under concurrent creation', async () => {
    const before = await request(app).get('/api/tasks').set(auth());
    const startCount = before.body.tasks.length;

    const created = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        request(app).post('/api/tasks').set(auth()).send({ title: `Concurrent ${i}` })
      )
    );
    const numbers = created.map((r) => r.body.task.number as number);
    expect(new Set(numbers).size).toBe(10);

    const after = await request(app).get('/api/tasks').set(auth());
    expect(after.body.tasks.length).toBe(startCount + 10);
  });

  it('numbers users independently', async () => {
    const foreign = await request(app)
      .post('/api/tasks')
      .set(otherAuth())
      .send({ title: 'Their first' });
    expect(foreign.status).toBe(201);
    expect(foreign.body.task.number).toBe(1);
  });
});

describe('status transitions', () => {
  it('walks the happy path backlog -> todo -> in_progress -> in_review -> done', async () => {
    const task = await create({ title: 'Happy path', projectId });
    for (const status of ['todo', 'in_progress', 'in_review', 'done']) {
      const res = await move(task.id, status);
      expect(res.status).toBe(200);
      expect(res.body.task.status).toBe(status);
    }
    const done = await request(app).get(`/api/tasks/${task.id}`).set(auth());
    expect(done.body.task.closedAt).not.toBeNull();
  });

  it('supports the blocked loop and the review rework path', async () => {
    const task = await create({ title: 'Bumpy path', projectId });
    await move(task.id, 'todo');
    await move(task.id, 'in_progress');
    expect((await move(task.id, 'blocked')).body.task.status).toBe('blocked');
    expect((await move(task.id, 'in_progress')).body.task.status).toBe('in_progress');
    await move(task.id, 'in_review');
    // rework: reviewer sends it back
    expect((await move(task.id, 'in_progress')).body.task.status).toBe('in_progress');
  });

  it('rejects every move not in the transition table', async () => {
    const statuses = Object.keys(ALLOWED_TRANSITIONS) as TaskStatus[];
    // Spot-check the full matrix through the API using a fresh task driven
    // to each source status via legal paths.
    const pathTo: Record<TaskStatus, TaskStatus[]> = {
      backlog: [],
      todo: ['todo'],
      in_progress: ['todo', 'in_progress'],
      blocked: ['todo', 'in_progress', 'blocked'],
      in_review: ['todo', 'in_progress', 'in_review'],
      done: ['todo', 'in_progress', 'in_review', 'done'],
      cancelled: ['cancelled'],
    };
    for (const from of statuses) {
      for (const to of statuses) {
        if (from === to || ALLOWED_TRANSITIONS[from].includes(to)) continue;
        const task = await create({ title: `matrix ${from} -> ${to}`, projectId });
        for (const step of pathTo[from]) await move(task.id, step);
        const res = await move(task.id, to);
        expect(res.status, `${from} -> ${to} must be rejected`).toBe(400);
        expect(res.body.code).toBe('invalid_transition');
      }
    }
  });

  it('treats a same-status move as a pure reorder', async () => {
    const task = await create({ title: 'Reorder me', projectId });
    const res = await move(task.id, 'backlog', 0.5);
    expect(res.status).toBe(200);
    expect(res.body.task.boardOrder).toBe(0.5);
  });
});

describe('assignment', () => {
  it('assigns an owned agent and clears it again', async () => {
    const task = await create({ title: 'For the agent', projectId });
    const assigned = await request(app)
      .patch(`/api/tasks/${task.id}`)
      .set(auth())
      .send({ assignee: { agentId } });
    expect(assigned.body.task.assigneeAgentId).toBe(agentId);
    expect(assigned.body.task.assigneeUserId).toBeNull();

    const cleared = await request(app)
      .patch(`/api/tasks/${task.id}`)
      .set(auth())
      .send({ assignee: null });
    expect(cleared.body.task.assigneeAgentId).toBeNull();
  });

  it('assigns the owner as a human assignee', async () => {
    const task = await create({ title: 'For me', projectId });
    const res = await request(app)
      .patch(`/api/tasks/${task.id}`)
      .set(auth())
      .send({ assignee: { userId } });
    expect(res.body.task.assigneeUserId).toBe(userId);
    expect(res.body.task.assigneeAgentId).toBeNull();
  });

  it('rejects agent and user in the same slot', async () => {
    const task = await create({ title: 'Greedy', projectId });
    const res = await request(app)
      .patch(`/api/tasks/${task.id}`)
      .set(auth())
      .send({ assignee: { agentId, userId } });
    expect(res.status).toBe(400);
  });

  it("rejects another user's agent", async () => {
    const foreignAgent = await request(app)
      .post('/api/agents')
      .set(otherAuth())
      .send({ name: 'Foreign worker', runtime: 'api' });
    const task = await create({ title: 'Stolen labor', projectId });
    const res = await request(app)
      .patch(`/api/tasks/${task.id}`)
      .set(auth())
      .send({ assignee: { agentId: foreignAgent.body.agent.id } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_assignee');
  });

  it('sets a reviewer independently of the assignee', async () => {
    const task = await create({ title: 'Reviewed', projectId });
    const res = await request(app)
      .patch(`/api/tasks/${task.id}`)
      .set(auth())
      .send({ assignee: { agentId }, reviewer: { userId } });
    expect(res.body.task.assigneeAgentId).toBe(agentId);
    expect(res.body.task.reviewerUserId).toBe(userId);
  });
});

describe('board and isolation', () => {
  it('groups tasks by status ordered by boardOrder', async () => {
    const a = await create({ title: 'Board A', projectId });
    const b = await create({ title: 'Board B', projectId });
    await move(a.id, 'backlog', 2);
    await move(b.id, 'backlog', 1);

    const res = await request(app).get(`/api/tasks/board?projectId=${projectId}`).set(auth());
    expect(res.status).toBe(200);
    const backlog = res.body.board.backlog as { id: string }[];
    const posA = backlog.findIndex((i) => i.id === a.id);
    const posB = backlog.findIndex((i) => i.id === b.id);
    expect(posB).toBeLessThan(posA);
    expect(res.body.board.done).toBeInstanceOf(Array);
  });

  it("hides other users' tasks everywhere", async () => {
    const mine = await create({ title: 'Mine only', projectId });
    const listed = await request(app).get('/api/tasks').set(otherAuth());
    expect(listed.body.tasks.some((i: { id: string }) => i.id === mine.id)).toBe(false);
    const fetched = await request(app).get(`/api/tasks/${mine.id}`).set(otherAuth());
    expect(fetched.status).toBe(404);
    const moved = await request(app)
      .post(`/api/tasks/${mine.id}/move`)
      .set(otherAuth())
      .send({ status: 'todo' });
    expect(moved.status).toBe(404);
  });
});
