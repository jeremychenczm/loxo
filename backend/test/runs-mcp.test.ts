import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/client';
import { createApp } from '../src/http/app';
import { setTaskTurnExecutorForTests } from '../src/modules/runs/task-run';
import { mintRunToken } from '../src/modules/runs/run-token';
import { drainRunsForTests } from '../src/modules/runs/wake';
import type { TurnRequest, TurnResult } from '../src/modules/runner/runner';

const app = createApp();
let token = '';
let agentId = '';

type Executor = (req: TurnRequest) => Promise<TurnResult>;
const succeedQuickly: Executor = async () => ({
  text: 'fallback report',
  sessionRef: null as unknown as string,
  durationMs: 5,
});
let executorImpl: Executor = succeedQuickly;
const pendingReleases: Array<() => void> = [];

/** First invocation parks until release; `invoked` resolves once it is inside. */
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
    email: 'mcp@example.com',
    username: 'mcpuser',
    password: 'a-strong-password',
  });
  token = reg.body.token;

  const agent = await request(app)
    .post('/api/agents')
    .set({ Authorization: `Bearer ${token}` })
    .send({ name: 'Control-plane worker', runtime: 'claude-code' });
  agentId = agent.body.agent.id;
});

afterAll(() => {
  setTaskTurnExecutorForTests(null);
});

afterEach(async () => {
  for (const release of pendingReleases) release();
  pendingReleases.length = 0;
  await drainRunsForTests();
  executorImpl = succeedQuickly;
});

const auth = () => ({ Authorization: `Bearer ${token}` });

/** Creates a task, wakes the agent, and parks the run in `running`. */
async function startHeldRun(title: string) {
  const gated = gatedExecutor();
  const created = await request(app).post('/api/tasks').set(auth()).send({ title });
  const task = created.body.task as { id: string; number: number };
  await request(app).post(`/api/tasks/${task.id}/move`).set(auth()).send({ status: 'todo' });
  await request(app)
    .patch(`/api/tasks/${task.id}`)
    .set(auth())
    .send({ leadAgentId: agentId });
  await gated.invoked;

  const runs = await request(app).get(`/api/runs?taskId=${task.id}`).set(auth());
  const run = runs.body.runs[0] as { id: string; status: string };
  expect(run.status).toBe('running');
  return { task, run, release: gated.release };
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

function callTool(runToken: string, name: string, args: Record<string, unknown> = {}) {
  return mcpCall(runToken, 'tools/call', { name, arguments: args });
}

function toolText(res: request.Response): string {
  expect(res.status).toBe(200);
  expect(res.body.result).toBeDefined();
  return res.body.result.content[0].text as string;
}

describe('MCP control plane', () => {
  it('lists the five control-plane tools', async () => {
    const held = await startHeldRun('Tool listing');
    const res = await mcpCall(mintRunToken(held.run.id), 'tools/list');
    expect(res.status).toBe(200);
    const names = res.body.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual([
      'ask_blocker',
      'comment_on_task',
      'get_task',
      'submit_result',
      'update_task_status',
    ]);
  });

  it('reads the task snapshot through get_task', async () => {
    const held = await startHeldRun('Snapshot target');
    const res = await callTool(mintRunToken(held.run.id), 'get_task');
    const snapshot = JSON.parse(toolText(res));
    expect(snapshot.taskNumber).toBe(held.task.number);
    expect(snapshot.title).toBe('Snapshot target');
    expect(snapshot.status).toBe('todo');
  });

  it('posts progress through comment_on_task and suppresses the fallback report', async () => {
    const held = await startHeldRun('Progress notes');
    const res = await callTool(mintRunToken(held.run.id), 'comment_on_task', {
      body: 'halfway there',
    });
    expect(toolText(res)).toBe('Comment posted');

    held.release();
    await drainRunsForTests();

    const turns = await request(app).get(`/api/tasks/${held.task.id}/turns`).set(auth());
    const agentTurns = turns.body.turns.filter((t: { kind: string }) => t.kind === 'agent');
    // The tool turn is the only one; no duplicate fallback post.
    expect(agentTurns).toHaveLength(1);
    expect(agentTurns[0].content).toBe('halfway there');
    expect(agentTurns[0].runId).toBe(held.run.id);
  });

  it('moves the task through update_task_status and rejects illegal transitions', async () => {
    const held = await startHeldRun('Status moves');
    const runToken = mintRunToken(held.run.id);

    const ok = await callTool(runToken, 'update_task_status', { status: 'in_progress' });
    expect(JSON.parse(toolText(ok)).status).toBe('in_progress');

    const bad = await callTool(runToken, 'update_task_status', { status: 'backlog' });
    expect(bad.status).toBe(200);
    expect(bad.body.result.isError).toBe(true);
    expect(bad.body.result.content[0].text).toContain('invalid_transition');
  });

  it('ask_blocker posts the question and blocks the task', async () => {
    const held = await startHeldRun('Stuck run');
    const runToken = mintRunToken(held.run.id);
    await callTool(runToken, 'update_task_status', { status: 'in_progress' });

    const res = await callTool(runToken, 'ask_blocker', {
      question: 'Which region should this deploy to?',
    });
    expect(JSON.parse(toolText(res)).status).toBe('blocked');

    const turns = await request(app).get(`/api/tasks/${held.task.id}/turns`).set(auth());
    const bodies = turns.body.turns.map((t: { content: string }) => t.content);
    expect(bodies).toContain('[BLOCKER] Which region should this deploy to?');
  });

  it('submit_result posts the report and hands the task to review', async () => {
    const held = await startHeldRun('Finished work');
    const runToken = mintRunToken(held.run.id);
    await callTool(runToken, 'update_task_status', { status: 'in_progress' });

    const res = await callTool(runToken, 'submit_result', {
      summary: 'Implemented and verified. Changed: src/widget.ts',
    });
    expect(JSON.parse(toolText(res)).status).toBe('in_review');

    const detail = await request(app).get(`/api/tasks/${held.task.id}`).set(auth());
    expect(detail.body.task.status).toBe('in_review');
  });

  it('rejects forged, malformed, and settled-run tokens', async () => {
    const held = await startHeldRun('Token gauntlet');
    const good = mintRunToken(held.run.id);

    const forged = `${good.slice(0, -4)}AAAA`;
    expect((await callTool(forged, 'get_task')).status).toBe(401);
    expect((await callTool('garbage', 'get_task')).status).toBe(401);
    expect((await callTool('', 'get_task')).status).toBe(401);

    held.release();
    await drainRunsForTests();

    // Same, correctly signed token — but the run has settled.
    const res = await callTool(good, 'get_task');
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Run is not active');
  });
});
