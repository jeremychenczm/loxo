import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/client';
import { createApp } from '../src/http/app';
import { setTaskTurnExecutorForTests } from '../src/modules/runs/task-run';
import { mintRunToken } from '../src/modules/runs/run-token';
import { drainRunsForTests, requestWake } from '../src/modules/runs/wake';
import type { TurnRequest, TurnResult } from '../src/modules/runner/runner';
import { addAgentTurn } from '../src/modules/tasks/turns.service';

const app = createApp();
let token = '';
let userId = '';
let workerId = '';
let inspectorId = '';

const REVIEWER_MARK = 'acting as the REVIEWER';

type Executor = (req: TurnRequest) => Promise<TurnResult>;
const quick: Executor = async () => ({ text: 'stub output', durationMs: 5 });
let executorImpl: Executor = quick;
let lastPrompt = '';
let lastPermission: TurnRequest['permission'];
const pendingReleases: Array<() => void> = [];

/** Parks the first REVIEW run (identified by its prompt) until release. */
function gateReviewRun() {
  let entered!: () => void;
  const invoked = new Promise<void>((resolve) => (entered = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let first = true;
  executorImpl = async (req) => {
    if (first && req.prompt.includes(REVIEWER_MARK)) {
      first = false;
      entered();
      await gate;
    }
    return quick(req);
  };
  pendingReleases.push(release);
  return { invoked, release };
}

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  setTaskTurnExecutorForTests((req) => {
    lastPrompt = req.prompt;
    lastPermission = req.permission;
    return executorImpl(req);
  });

  const reg = await request(app).post('/auth/register').send({
    email: 'revrun@example.com',
    username: 'revrunuser',
    password: 'a-strong-password',
  });
  token = reg.body.token;
  userId = reg.body.user.id;

  for (const name of ['Worker', 'Inspector']) {
    const agent = await request(app)
      .post('/api/agents')
      .set({ Authorization: `Bearer ${token}` })
      .send({ name, runtime: 'claude-code' });
    if (name === 'Worker') workerId = agent.body.agent.id;
    else inspectorId = agent.body.agent.id;
  }
});

afterAll(() => {
  setTaskTurnExecutorForTests(null);
});

afterEach(async () => {
  for (const release of pendingReleases) release();
  pendingReleases.length = 0;
  await drainRunsForTests();
  executorImpl = quick;
});

const auth = () => ({ Authorization: `Bearer ${token}` });

async function createTask(title: string) {
  const res = await request(app).post('/api/tasks').set(auth()).send({ title });
  return res.body.task as { id: string; number: number };
}

async function moveTo(taskId: string, status: string) {
  const res = await request(app).post(`/api/tasks/${taskId}/move`).set(auth()).send({ status });
  expect(res.status).toBe(200);
}

/** Non-lead members review; a reviewer-only task has members but no lead. */
async function setRoster(taskId: string, lead: string | undefined, reviewer?: string) {
  const members = [...new Set([lead, reviewer].filter((id): id is string => Boolean(id)))];
  const res = await request(app)
    .patch(`/api/tasks/${taskId}`)
    .set(auth())
    .send({ leadAgentId: lead ?? null, memberAgentIds: members });
  expect(res.status).toBe(200);
}

async function timeline(taskId: string) {
  const res = await request(app).get(`/api/tasks/${taskId}/turns`).set(auth());
  return res.body.turns as Array<{ kind: string; content: string; report: Record<string, unknown> | null }>;
}

async function runsFor(taskId: string) {
  const res = await request(app).get(`/api/runs?taskId=${taskId}`).set(auth());
  return res.body.runs as Array<{ id: string; status: string; trigger: string; agentId: string }>;
}

let callId = 0;
function mcpCall(runToken: string, method: string, params?: Record<string, unknown>) {
  callId += 1;
  return request(app)
    .post('/mcp')
    .set({
      Authorization: `Bearer ${runToken}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    })
    .send({ jsonrpc: '2.0', id: callId, method, ...(params ? { params } : {}) });
}

async function seedRejections(taskId: string, count: number) {
  for (let i = 0; i < count; i += 1) {
    await addAgentTurn(userId, taskId, inspectorId, `[CHANGES REQUESTED] seeded rejection ${i + 1}`, {
      report: { type: 'review', decision: 'changes_requested' },
    });
  }
}

describe('reviewer routing', () => {
  it('wakes the reviewer with a review-flavored run when the task enters review', async () => {
    const task = await createTask('Review wake');
    await setRoster(task.id, undefined, inspectorId);
    await moveTo(task.id, 'todo');
    await moveTo(task.id, 'in_progress');
    await moveTo(task.id, 'in_review');
    await drainRunsForTests();

    const runs = await runsFor(task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.trigger).toBe('review');
    expect(runs[0]!.agentId).toBe(inspectorId);
    expect(runs[0]!.status).toBe('succeeded');
    expect(lastPrompt).toContain(REVIEWER_MARK);
    expect(lastPrompt).toContain('do NOT modify any files');
    // Review turns are forced below the agent's own permission ceiling.
    expect(lastPermission).toBe('read_only');
  });

  it('never asks the lead to review its own work', async () => {
    const task = await createTask('Self review');
    await setRoster(task.id, workerId);
    await moveTo(task.id, 'todo');
    await drainRunsForTests();
    await moveTo(task.id, 'in_progress');
    await moveTo(task.id, 'in_review');
    await drainRunsForTests();

    const runs = await runsFor(task.id);
    expect(runs.filter((r) => r.trigger === 'review')).toHaveLength(0);
  });

  it('serves the reviewer toolset and records approval without closing', async () => {
    const gated = gateReviewRun();
    const task = await createTask('Approve recommendation');
    await setRoster(task.id, undefined, inspectorId);
    await moveTo(task.id, 'todo');
    await moveTo(task.id, 'in_progress');
    await moveTo(task.id, 'in_review');
    await gated.invoked;

    const reviewRun = (await runsFor(task.id)).find((r) => r.trigger === 'review')!;
    const runToken = mintRunToken(reviewRun.id);

    const list = await mcpCall(runToken, 'tools/list');
    const names = list.body.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(['comment_on_task', 'get_task', 'submit_review']);

    const res = await mcpCall(runToken, 'tools/call', {
      name: 'submit_review',
      arguments: { decision: 'approved', feedback: 'Verified the output; recommend closing.' },
    });
    const outcome = JSON.parse(res.body.result.content[0].text);
    expect(outcome.halted).toBe(false);
    expect(outcome.status).toBe('in_review');

    const detail = await request(app).get(`/api/tasks/${task.id}`).set(auth());
    expect(detail.body.task.status).toBe('in_review');

    const verdicts = (await timeline(task.id)).filter((t) => t.report?.type === 'review');
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.kind).toBe('agent');
    expect(verdicts[0]!.report).toEqual({ type: 'review', decision: 'approved' });

    // Agent opinions never count as approvals.
    const approvals = await request(app).get(`/api/tasks/${task.id}/approvals`).set(auth());
    expect(approvals.body.approvals).toHaveLength(0);

    gated.release();
  });

  it('agent rejection reopens work and re-wakes the lead', async () => {
    const gated = gateReviewRun();
    const task = await createTask('Reject and rework');
    await setRoster(task.id, workerId, inspectorId);
    await moveTo(task.id, 'todo');
    await moveTo(task.id, 'in_progress');
    await moveTo(task.id, 'in_review');
    await gated.invoked;

    const reviewRun = (await runsFor(task.id)).find((r) => r.trigger === 'review')!;
    const res = await mcpCall(mintRunToken(reviewRun.id), 'tools/call', {
      name: 'submit_review',
      arguments: { decision: 'changes_requested', feedback: 'Tests are missing for the edge case.' },
    });
    expect(JSON.parse(res.body.result.content[0].text).halted).toBe(false);

    gated.release();
    await drainRunsForTests();

    const detail = await request(app).get(`/api/tasks/${task.id}`).set(auth());
    expect(detail.body.task.status).toBe('in_progress');

    const bodies = (await timeline(task.id)).map((t) => t.content);
    expect(bodies).toContain('[CHANGES REQUESTED] Tests are missing for the edge case.');

    const workerRuns = (await runsFor(task.id)).filter((r) => r.agentId === workerId);
    expect(workerRuns.length).toBeGreaterThanOrEqual(2); // initial + rework
  });

  it('stops waking the reviewer once the automated-cycle fuse blows', async () => {
    const task = await createTask('Fuse blown');
    await setRoster(task.id, undefined, inspectorId);
    await seedRejections(task.id, 3);
    await moveTo(task.id, 'todo');
    await moveTo(task.id, 'in_progress');
    await moveTo(task.id, 'in_review');
    await drainRunsForTests();

    expect((await runsFor(task.id)).filter((r) => r.trigger === 'review')).toHaveLength(0);
  });

  it('halts a beyond-cap rejection instead of reopening work', async () => {
    const gated = gateReviewRun();
    const task = await createTask('Halted verdict');
    await setRoster(task.id, undefined, inspectorId);
    await seedRejections(task.id, 3);
    await moveTo(task.id, 'todo');
    await moveTo(task.id, 'in_progress');
    await moveTo(task.id, 'in_review');
    // The hook refuses to wake; wake the reviewer explicitly to exercise the
    // tool-level guard.
    await requestWake(userId, {
      agentId: inspectorId,
      taskId: task.id,
      trigger: 'review',
      reason: 'manual reviewer wake',
    });
    await gated.invoked;

    const reviewRun = (await runsFor(task.id)).find((r) => r.trigger === 'review')!;
    const res = await mcpCall(mintRunToken(reviewRun.id), 'tools/call', {
      name: 'submit_review',
      arguments: { decision: 'changes_requested', feedback: 'Still wrong.' },
    });
    const outcome = JSON.parse(res.body.result.content[0].text);
    expect(outcome.halted).toBe(true);
    expect(outcome.status).toBe('in_review');

    const detail = await request(app).get(`/api/tasks/${task.id}`).set(auth());
    expect(detail.body.task.status).toBe('in_review');

    const bodies = (await timeline(task.id)).map((t) => t.content);
    expect(bodies.some((b: string) => b.startsWith('[REVIEW HALTED]'))).toBe(true);

    gated.release();
  });
});
