import path from 'node:path';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/client';
import { createApp } from '../src/http/app';
import { initFixtureRepo, makeSandbox, removeSandbox } from './fixtures/git-repo';

const app = createApp();
let token = '';
let agentId = '';

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  const reg = await request(app).post('/auth/register').send({
    email: 'chatfiling@example.com',
    username: 'filinguser',
    password: 'a-strong-password',
  });
  token = reg.body.token;

  const agent = await request(app)
    .post('/api/agents')
    .set({ Authorization: `Bearer ${token}` })
    .send({ name: 'Ada', runtime: 'claude-code' });
  agentId = agent.body.agent.id;
});

const auth = () => ({ Authorization: `Bearer ${token}` });

async function newConversation(): Promise<string> {
  const res = await request(app)
    .post('/api/conversations')
    .set(auth())
    .send({ agentId, title: `filing-${Date.now()}-${Math.random()}` });
  return res.body.conversation.id;
}

describe('POST /api/conversations/:id/file-task', () => {
  it('creates a backlog task assigned to the chat agent, linked to the conversation', async () => {
    const conversationId = await newConversation();

    const res = await request(app)
      .post(`/api/conversations/${conversationId}/file-task`)
      .set(auth())
      .send({ title: 'Ship the export command', brief: 'CSV first, JSON later.' });

    expect(res.status).toBe(201);
    const task = res.body.task;
    expect(task.status).toBe('backlog');
    expect(task.title).toBe('Ship the export command');
    expect(task.brief).toBe('CSV first, JSON later.');
    expect(task.leadAgentId).toBe(agentId);
    expect(task.memberAgentIds).toEqual([agentId]);
    expect(task.sourceConversationId).toBe(conversationId);
    expect(task.number).toBeGreaterThan(0);
  });

  it('does not enqueue a run: backlog filing must not wake the agent', async () => {
    const conversationId = await newConversation();
    const res = await request(app)
      .post(`/api/conversations/${conversationId}/file-task`)
      .set(auth())
      .send({ title: 'Quiet filing' });

    const runs = await pool.query('SELECT id FROM runs WHERE task_id = $1', [res.body.task.id]);
    expect(runs.rowCount).toBe(0);
  });

  it('leaves a timeline turn on the task', async () => {
    const conversationId = await newConversation();
    const filed = await request(app)
      .post(`/api/conversations/${conversationId}/file-task`)
      .set(auth())
      .send({ title: 'Comment breadcrumb' });

    const turns = await request(app).get(`/api/tasks/${filed.body.task.id}/turns`).set(auth());
    expect(turns.body.turns).toHaveLength(1);
    expect(turns.body.turns[0].kind).toBe('human');
    expect(turns.body.turns[0].content).toContain('Filed from the chat');
  });

  it('posts a system message into the conversation pointing at the task', async () => {
    const conversationId = await newConversation();
    const filed = await request(app)
      .post(`/api/conversations/${conversationId}/file-task`)
      .set(auth())
      .send({ title: 'Chat breadcrumb' });

    const messages = await request(app)
      .get(`/api/conversations/${conversationId}/messages`)
      .set(auth());
    const system = messages.body.messages.filter((m: { role: string }) => m.role === 'system');
    expect(system).toHaveLength(1);
    expect(system[0].content).toContain(`#${filed.body.task.number}`);
    expect(system[0].content).toContain('Chat breadcrumb');
    expect(system[0].meta.taskId).toBe(filed.body.task.id);
    expect(system[0].meta.source).toBe('task_filing');
  });

  it('lets one conversation file several tasks', async () => {
    const conversationId = await newConversation();
    const first = await request(app)
      .post(`/api/conversations/${conversationId}/file-task`)
      .set(auth())
      .send({ title: 'First topic' });
    const second = await request(app)
      .post(`/api/conversations/${conversationId}/file-task`)
      .set(auth())
      .send({ title: 'Second topic' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.task.id).not.toBe(first.body.task.id);
    expect(second.body.task.sourceConversationId).toBe(conversationId);
  });

  it('honors an explicit repository and rejects an unknown one', async () => {
    const sandbox = makeSandbox('filing');
    try {
      const repoDir = await initFixtureRepo(path.join(sandbox, 'target'));
      const repository = await request(app)
        .post('/api/repositories')
        .set(auth())
        .send({ rootPath: repoDir });
      const conversationId = await newConversation();

      const ok = await request(app)
        .post(`/api/conversations/${conversationId}/file-task`)
        .set(auth())
        .send({ title: 'Into a repository', repositoryId: repository.body.repository.id });
      expect(ok.status).toBe(201);
      expect(ok.body.task.repositoryId).toBe(repository.body.repository.id);

      const bad = await request(app)
        .post(`/api/conversations/${conversationId}/file-task`)
        .set(auth())
        .send({ title: 'Nope', repositoryId: '00000000-0000-0000-0000-000000000000' });
      expect(bad.status).toBe(400);
    } finally {
      removeSandbox(sandbox);
    }
  });

  it('rejects an empty title', async () => {
    const conversationId = await newConversation();
    const res = await request(app)
      .post(`/api/conversations/${conversationId}/file-task`)
      .set(auth())
      .send({ title: '   ' });
    expect(res.status).toBe(400);
  });

  it("404s on another user's conversation", async () => {
    const conversationId = await newConversation();
    const other = await request(app).post('/auth/register').send({
      email: 'filing-other@example.com',
      username: 'filingother',
      password: 'a-strong-password',
    });

    const res = await request(app)
      .post(`/api/conversations/${conversationId}/file-task`)
      .set({ Authorization: `Bearer ${other.body.token}` })
      .send({ title: 'Not yours' });
    expect(res.status).toBe(404);
  });

  it('deleting the conversation keeps the task and clears the link', async () => {
    const conversationId = await newConversation();
    const filed = await request(app)
      .post(`/api/conversations/${conversationId}/file-task`)
      .set(auth())
      .send({ title: 'Survives deletion' });

    await request(app).delete(`/api/conversations/${conversationId}`).set(auth());

    const task = await request(app).get(`/api/tasks/${filed.body.task.id}`).set(auth());
    expect(task.status).toBe(200);
    expect(task.body.task.sourceConversationId).toBeNull();
  });
});
