import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/client';
import { createApp } from '../src/http/app';
import type { TaskStatus } from '../src/db/schema';
import { ALLOWED_TRANSITIONS } from '../src/modules/tasks/task-transitions';
import { initFixtureRepo, makeSandbox, removeSandbox } from './fixtures/git-repo';

const app = createApp();
let token = '';
let otherToken = '';
let agentId = '';
let userId = '';
let repositoryId = '';
let repoDir = '';
let sandbox = '';

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

  sandbox = makeSandbox('tasks');
  repoDir = await initFixtureRepo(path.join(sandbox, 'home'));
  const repository = await request(app)
    .post('/api/repositories')
    .set({ Authorization: `Bearer ${token}` })
    .send({ rootPath: repoDir });
  repositoryId = repository.body.repository.id;
});

afterAll(() => removeSandbox(sandbox));

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
  it('creates in a chosen repository with backlog status and a number', async () => {
    const task = await create({ title: 'First task', repositoryId });
    expect(task.status).toBe('backlog');
    expect(task.repositoryId).toBe(repositoryId);
    expect(task.number).toBeGreaterThan(0);
  });

  it('creates a task without a repository', async () => {
    const task = await create({ title: 'Quick capture' });
    expect(task.repositoryId).toBeNull();
  });

  it("rejects another user's repository", async () => {
    const foreign = await request(app)
      .post('/api/repositories')
      .set(otherAuth())
      .send({ rootPath: repoDir });
    expect(foreign.status).toBe(201);
    const res = await request(app)
      .post('/api/tasks')
      .set(auth())
      .send({ title: 'Nope', repositoryId: foreign.body.repository.id });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_repository');
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
    const task = await create({ title: 'Happy path', repositoryId });
    for (const status of ['todo', 'in_progress', 'in_review', 'done']) {
      const res = await move(task.id, status);
      expect(res.status).toBe(200);
      expect(res.body.task.status).toBe(status);
    }
    const done = await request(app).get(`/api/tasks/${task.id}`).set(auth());
    expect(done.body.task.closedAt).not.toBeNull();
  });

  it('supports the blocked loop and the review rework path', async () => {
    const task = await create({ title: 'Bumpy path', repositoryId });
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
        const task = await create({ title: `matrix ${from} -> ${to}`, repositoryId });
        for (const step of pathTo[from]) await move(task.id, step);
        const res = await move(task.id, to);
        expect(res.status, `${from} -> ${to} must be rejected`).toBe(400);
        expect(res.body.code).toBe('invalid_transition');
      }
    }
  });

  it('treats a same-status move as a pure reorder', async () => {
    const task = await create({ title: 'Reorder me', repositoryId });
    const res = await move(task.id, 'backlog', 0.5);
    expect(res.status).toBe(200);
    expect(res.body.task.boardOrder).toBe(0.5);
  });
});

async function newAgent(name: string, t = token): Promise<string> {
  const res = await request(app)
    .post('/api/agents')
    .set({ Authorization: `Bearer ${t}` })
    .send({ name, runtime: 'api' });
  return res.body.agent.id;
}

async function patch(id: string, body: Record<string, unknown>) {
  return request(app).patch(`/api/tasks/${id}`).set(auth()).send(body);
}

describe('lead and members', () => {
  it('creates with a lead, who always heads the roster', async () => {
    const helper = await newAgent('Helper');
    const task = await create({ title: 'Pair work', leadAgentId: agentId, memberAgentIds: [helper] });
    expect(task.leadAgentId).toBe(agentId);
    expect(task.memberAgentIds).toEqual([agentId, helper]);
  });

  it('defaults the lead to the first member', async () => {
    const helper = await newAgent('First in line');
    const task = await create({ title: 'Implicit lead', memberAgentIds: [helper, agentId] });
    expect(task.leadAgentId).toBe(helper);
  });

  it('sets and clears the lead without losing members', async () => {
    const task = await create({ title: 'For the agent' });
    expect(task.leadAgentId).toBeNull();
    expect(task.memberAgentIds).toEqual([]);

    const led = await patch(task.id, { leadAgentId: agentId });
    expect(led.body.task.leadAgentId).toBe(agentId);
    expect(led.body.task.memberAgentIds).toEqual([agentId]);

    const cleared = await patch(task.id, { leadAgentId: null });
    expect(cleared.body.task.leadAgentId).toBeNull();
    expect(cleared.body.task.memberAgentIds).toEqual([agentId]);
  });

  it('replaces the roster and keeps removed members on record', async () => {
    const a = await newAgent('Roster A');
    const b = await newAgent('Roster B');
    const task = await create({ title: 'Rotating crew', memberAgentIds: [a, b] });

    const swapped = await patch(task.id, { memberAgentIds: [b] });
    expect(swapped.body.task.memberAgentIds).toEqual([b]);
    // The previous lead left the roster, so the lead moves to the new first member.
    expect(swapped.body.task.leadAgentId).toBe(b);

    const { rows } = await pool.query(
      'SELECT agent_id, state FROM task_members WHERE task_id = $1 ORDER BY position',
      [task.id]
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        { agent_id: a, state: 'removed' },
        { agent_id: b, state: 'active' },
      ])
    );

    const back = await patch(task.id, { memberAgentIds: [a, b] });
    expect(back.body.task.memberAgentIds).toEqual([a, b]);
    const count = await pool.query('SELECT count(*)::int AS n FROM task_members WHERE task_id = $1', [
      task.id,
    ]);
    expect(count.rows[0].n).toBe(2);
  });

  it('rejects foreign and duplicate members', async () => {
    const foreign = await newAgent('Foreign worker', otherToken);
    const task = await create({ title: 'Stolen labor' });
    const stolen = await patch(task.id, { leadAgentId: foreign });
    expect(stolen.status).toBe(400);
    expect(stolen.body.code).toBe('invalid_members');

    const duplicate = await patch(task.id, { memberAgentIds: [agentId, agentId] });
    expect(duplicate.body.code).toBe('invalid_members');
  });

  it('copies a crew roster at creation', async () => {
    const a = await newAgent('Crew A');
    const b = await newAgent('Crew B');
    const crew = await request(app)
      .post('/api/crews')
      .set(auth())
      .send({ name: 'Builders', agentIds: [a, b] });
    const crewId = crew.body.crew.id as string;

    const task = await create({ title: 'From crew', crewId });
    expect(task.memberAgentIds).toEqual([a, b]);
    expect(task.leadAgentId).toBe(a);

    const led = await create({ title: 'Crew plus lead', crewId, leadAgentId: agentId });
    expect(led.memberAgentIds).toEqual([agentId, a, b]);

    const missing = await request(app)
      .post('/api/tasks')
      .set(auth())
      .send({ title: 'No crew', crewId: '00000000-0000-4000-8000-000000000000' });
    expect(missing.body.code).toBe('invalid_crew');
  });
});

describe('board and isolation', () => {
  it('groups tasks by status ordered by boardOrder', async () => {
    const a = await create({ title: 'Board A', repositoryId });
    const b = await create({ title: 'Board B', repositoryId });
    await move(a.id, 'backlog', 2);
    await move(b.id, 'backlog', 1);

    const res = await request(app).get(`/api/tasks/board?repositoryId=${repositoryId}`).set(auth());
    expect(res.status).toBe(200);
    const backlog = res.body.board.backlog as { id: string }[];
    const posA = backlog.findIndex((i) => i.id === a.id);
    const posB = backlog.findIndex((i) => i.id === b.id);
    expect(posB).toBeLessThan(posA);
    expect(res.body.board.done).toBeInstanceOf(Array);
  });

  it("hides other users' tasks everywhere", async () => {
    const mine = await create({ title: 'Mine only', repositoryId });
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
