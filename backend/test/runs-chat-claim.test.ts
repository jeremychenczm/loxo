import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/client';
import { createApp } from '../src/http/app';
import { runChatTurn, setTurnExecutorForTests } from '../src/modules/chat/chat.service';
import { setTaskTurnExecutorForTests } from '../src/modules/runs/task-run';
import { drainRunsForTests } from '../src/modules/runs/wake';
import { RunnerError, type TurnRequest, type TurnResult } from '../src/modules/runner/runner';

const app = createApp();
let token = '';
let userId = '';
let agentId = '';
let conversationId = '';

type Executor = (req: TurnRequest) => Promise<TurnResult>;
const quickReply: Executor = async () => ({ text: 'chat reply', durationMs: 5 });
const quickReport: Executor = async () => ({ text: 'task report', durationMs: 5 });
let chatExecutor: Executor = quickReply;
let taskExecutor: Executor = quickReport;
const pendingReleases: Array<() => void> = [];

function gate(target: 'chat' | 'task') {
  let entered!: () => void;
  const invoked = new Promise<void>((resolve) => (entered = resolve));
  let release!: () => void;
  const opened = new Promise<void>((resolve) => (release = resolve));
  let first = true;
  const impl: Executor = async (req) => {
    if (first) {
      first = false;
      entered();
      await opened;
    }
    return target === 'chat' ? quickReply(req) : quickReport(req);
  };
  if (target === 'chat') chatExecutor = impl;
  else taskExecutor = impl;
  pendingReleases.push(release);
  return { invoked, release };
}

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  setTurnExecutorForTests((req) => chatExecutor(req));
  setTaskTurnExecutorForTests((req) => taskExecutor(req));

  const reg = await request(app).post('/auth/register').send({
    email: 'claim@example.com',
    username: 'claimuser',
    password: 'a-strong-password',
  });
  token = reg.body.token;
  userId = reg.body.user.id;

  const agent = await request(app)
    .post('/api/agents')
    .set({ Authorization: `Bearer ${token}` })
    .send({ name: 'Shared worker', runtime: 'claude-code' });
  agentId = agent.body.agent.id;

  const conversation = await request(app)
    .post('/api/conversations')
    .set({ Authorization: `Bearer ${token}` })
    .send({ agentId });
  conversationId = conversation.body.conversation.id;
});

afterAll(() => {
  setTurnExecutorForTests(null);
  setTaskTurnExecutorForTests(null);
});

afterEach(async () => {
  for (const release of pendingReleases) release();
  pendingReleases.length = 0;
  await drainRunsForTests();
  chatExecutor = quickReply;
  taskExecutor = quickReport;
});

const auth = () => ({ Authorization: `Bearer ${token}` });

async function wakeableTask(title: string) {
  const created = await request(app).post('/api/tasks').set(auth()).send({ title });
  const task = created.body.task as { id: string };
  await request(app).post(`/api/tasks/${task.id}/move`).set(auth()).send({ status: 'todo' });
  return task;
}

async function runsFor(taskId: string) {
  const res = await request(app).get(`/api/runs?taskId=${taskId}`).set(auth());
  return res.body.runs as Array<{ status: string }>;
}

describe('shared agent claim', () => {
  it('rejects a chat turn while a task run holds the agent', async () => {
    const gated = gate('task');
    const task = await wakeableTask('Chat blocker');
    await request(app)
      .patch(`/api/tasks/${task.id}`)
      .set(auth())
      .send({ leadAgentId: agentId, memberAgentIds: [agentId] });
    await gated.invoked;

    await expect(runChatTurn(userId, conversationId, 'quick question')).rejects.toMatchObject({
      code: 'agent_busy',
    });

    gated.release();
    await drainRunsForTests();

    // Freed agent takes chat turns again.
    const outcome = await runChatTurn(userId, conversationId, 'and now?');
    expect(outcome.reply.content).toBe('chat reply');
  });

  it('parks an assignment wake behind a chat turn and promotes it afterwards', async () => {
    const gated = gate('chat');
    const chatPromise = runChatTurn(userId, conversationId, 'long think');
    await gated.invoked;

    const task = await wakeableTask('Queued behind chat');
    await request(app)
      .patch(`/api/tasks/${task.id}`)
      .set(auth())
      .send({ leadAgentId: agentId, memberAgentIds: [agentId] });
    expect((await runsFor(task.id))[0]!.status).toBe('queued');

    gated.release();
    await chatPromise;
    await drainRunsForTests();

    expect((await runsFor(task.id))[0]!.status).toBe('succeeded');
  });

  it('releases the claim when the chat turn fails', async () => {
    chatExecutor = async () => {
      throw new RunnerError('CLI unavailable', 'cli_failed');
    };
    const outcome = await runChatTurn(userId, conversationId, 'does this work?');
    expect(outcome.reply.role).toBe('system');

    const agent = await request(app).get(`/api/agents/${agentId}`).set(auth());
    expect(agent.body.agent.status).toBe('error');

    // The claim is free again: a wake starts immediately.
    chatExecutor = quickReply;
    const task = await wakeableTask('After chat failure');
    await request(app)
      .patch(`/api/tasks/${task.id}`)
      .set(auth())
      .send({ leadAgentId: agentId, memberAgentIds: [agentId] });
    await drainRunsForTests();
    expect((await runsFor(task.id))[0]!.status).toBe('succeeded');
  });
});
