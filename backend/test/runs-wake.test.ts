import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/client';
import { createApp } from '../src/http/app';
import { setTaskTurnExecutorForTests } from '../src/modules/runs/task-run';
import { drainRunsForTests } from '../src/modules/runs/wake';
import { RunnerError, type TurnRequest, type TurnResult } from '../src/modules/runner/runner';

const app = createApp();
let token = '';
let agentA = '';
let agentB = '';

type Executor = (req: TurnRequest) => Promise<TurnResult>;
const succeedQuickly: Executor = async () => ({
  text: 'stub work report',
  sessionRef: 'sess-stub',
  durationMs: 5,
});
let executorImpl: Executor = succeedQuickly;

/** Gates released even when a test aborts mid-assertion. */
const pendingReleases: Array<() => void> = [];

/**
 * Executor whose first invocation parks until release(); `invoked` resolves
 * once that first call is actually inside the executor, making "the run is
 * really holding the lock now" a deterministic checkpoint.
 */
function gatedExecutor() {
  let entered!: () => void;
  const invoked = new Promise<void>((resolve) => (entered = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let first = true;
  executorImpl = async (req) => {
    if (first) {
      first = false;
      entered();
      await gate;
    }
    return succeedQuickly(req);
  };
  pendingReleases.push(release);
  return { invoked, release };
}

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  setTaskTurnExecutorForTests((req) => executorImpl(req));

  const reg = await request(app).post('/auth/register').send({
    email: 'wake@example.com',
    username: 'wakeuser',
    password: 'a-strong-password',
  });
  token = reg.body.token;

  for (const name of ['Worker A', 'Worker B']) {
    const agent = await request(app)
      .post('/api/agents')
      .set({ Authorization: `Bearer ${token}` })
      .send({ name, runtime: 'claude-code' });
    if (name === 'Worker A') agentA = agent.body.agent.id;
    else agentB = agent.body.agent.id;
  }
});

afterAll(() => {
  setTaskTurnExecutorForTests(null);
});

beforeEach(() => {
  executorImpl = succeedQuickly;
});

afterEach(async () => {
  for (const release of pendingReleases) release();
  pendingReleases.length = 0;
  await drainRunsForTests();
});

const auth = () => ({ Authorization: `Bearer ${token}` });

async function createTask(title: string) {
  const res = await request(app).post('/api/tasks').set(auth()).send({ title });
  expect(res.status).toBe(201);
  return res.body.task as { id: string; number: number };
}

async function moveTo(taskId: string, status: string) {
  const res = await request(app).post(`/api/tasks/${taskId}/move`).set(auth()).send({ status });
  expect(res.status).toBe(200);
  return res.body.task;
}

async function assign(taskId: string, agentId: string) {
  const res = await request(app)
    .patch(`/api/tasks/${taskId}`)
    .set(auth())
    .send({ assignee: { agentId } });
  expect(res.status).toBe(200);
  return res.body.task;
}

async function runsFor(taskId: string) {
  const res = await request(app).get(`/api/runs?taskId=${taskId}`).set(auth());
  expect(res.status).toBe(200);
  return res.body.runs as Array<{
    id: string;
    status: string;
    trigger: string;
    output: string;
    error: string | null;
    sessionRef: string | null;
  }>;
}

async function agentStatus(agentId: string) {
  const res = await request(app).get(`/api/agents/${agentId}`).set(auth());
  return res.body.agent.status as string;
}

describe('wake admission', () => {
  it('wakes the agent on assignment, runs, and posts the work report', async () => {
    const task = await createTask('Assignment wake');
    await moveTo(task.id, 'todo');
    await assign(task.id, agentA);
    await drainRunsForTests();

    const [run] = await runsFor(task.id);
    expect(run).toBeDefined();
    expect(run!.status).toBe('succeeded');
    expect(run!.trigger).toBe('assignment');
    expect(run!.output).toBe('stub work report');
    expect(run!.sessionRef).toBe('sess-stub');

    const comments = await request(app).get(`/api/tasks/${task.id}/comments`).set(auth());
    const agentComments = comments.body.comments.filter(
      (c: { authorType: string }) => c.authorType === 'agent'
    );
    expect(agentComments).toHaveLength(1);
    expect(agentComments[0].body).toBe('stub work report');

    const detail = await request(app).get(`/api/tasks/${task.id}`).set(auth());
    expect(detail.body.task.activeRunId).toBeNull();
    expect(await agentStatus(agentA)).toBe('idle');
  });

  it('does not wake while the task sits in backlog', async () => {
    const task = await createTask('Backlog stays quiet');
    await assign(task.id, agentA);
    await drainRunsForTests();
    expect(await runsFor(task.id)).toHaveLength(0);
  });

  it('wakes when a backlog task with an assignee moves to todo', async () => {
    const task = await createTask('Move triggers');
    await assign(task.id, agentA);
    await moveTo(task.id, 'todo');
    await drainRunsForTests();

    const runs = await runsFor(task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('succeeded');
  });

  it('merges a duplicate wake into the active run', async () => {
    const gated = gatedExecutor();

    const task = await createTask('Merge target');
    await moveTo(task.id, 'todo');
    await assign(task.id, agentA);
    await gated.invoked;

    const [running] = await runsFor(task.id);
    expect(running!.status).toBe('running');

    const wake = await request(app).post(`/api/tasks/${task.id}/wake`).set(auth()).send({});
    expect(wake.status).toBe(202);
    expect(wake.body.admitted).toBe('merged');
    expect(wake.body.run.id).toBe(running!.id);

    gated.release();
    await drainRunsForTests();
    expect(await runsFor(task.id)).toHaveLength(1);
  });

  it('parks a second agent behind the task lock and promotes it afterwards', async () => {
    const gated = gatedExecutor();

    const task = await createTask('Lock contention');
    await moveTo(task.id, 'todo');
    await assign(task.id, agentA);
    await gated.invoked;

    await assign(task.id, agentB);

    let runs = await runsFor(task.id);
    expect(runs.map((r) => r.status).sort()).toEqual(['queued', 'running']);

    gated.release();
    await drainRunsForTests();

    runs = await runsFor(task.id);
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.status === 'succeeded')).toBe(true);
    expect(await agentStatus(agentB)).toBe('idle');
  });

  it('serializes one agent across two tasks', async () => {
    const gated = gatedExecutor();

    const first = await createTask('Busy agent 1');
    await moveTo(first.id, 'todo');
    await assign(first.id, agentA);
    await gated.invoked;

    const second = await createTask('Busy agent 2');
    await moveTo(second.id, 'todo');
    await assign(second.id, agentA);

    expect((await runsFor(second.id))[0]!.status).toBe('queued');

    gated.release();
    await drainRunsForTests();

    expect((await runsFor(first.id))[0]!.status).toBe('succeeded');
    expect((await runsFor(second.id))[0]!.status).toBe('succeeded');
  });

  it('marks the run failed, frees the lock, and lets a retry through', async () => {
    executorImpl = async () => {
      throw new RunnerError('CLI exploded', 'cli_failed');
    };

    const task = await createTask('Failure path');
    await moveTo(task.id, 'todo');
    await assign(task.id, agentA);
    await drainRunsForTests();

    const [failed] = await runsFor(task.id);
    expect(failed!.status).toBe('failed');
    expect(failed!.error).toBe('CLI exploded');
    expect(await agentStatus(agentA)).toBe('error');

    executorImpl = succeedQuickly;
    const retry = await request(app).post(`/api/tasks/${task.id}/wake`).set(auth()).send({});
    expect(retry.status).toBe(202);
    expect(retry.body.admitted).toBe('started');
    await drainRunsForTests();

    const runs = await runsFor(task.id);
    expect(runs.some((r) => r.status === 'succeeded')).toBe(true);
    expect(await agentStatus(agentA)).toBe('idle');
  });

  it('rejects a manual wake when no agent is assigned', async () => {
    const task = await createTask('Nobody home');
    const res = await request(app).post(`/api/tasks/${task.id}/wake`).set(auth()).send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('no_agent_assignee');
  });
});
