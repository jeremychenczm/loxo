import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/client';
import { createApp } from '../src/http/app';
import { runChatTurn } from '../src/modules/chat/chat.service';
import { setApiTurnExecutorForTests, type ApiTurnRequest } from '../src/modules/runner/api-turn';
import { storage } from '../src/storage/layout';

const app = createApp();
let token = '';
let userId = '';

const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  const reg = await request(app).post('/auth/register').send({
    email: 'apiagents@example.com',
    username: 'apiagentsuser',
    password: 'a-strong-password',
  });
  token = reg.body.token;
  userId = reg.body.user.id;
});

afterEach(() => {
  setApiTurnExecutorForTests(null);
  delete process.env.API_AGENT_CATALOG;
});

afterAll(() => {
  delete process.env.API_AGENT_CATALOG;
});

describe('API agent catalog', () => {
  it('lists built-in presets with featured entries first', async () => {
    const res = await request(app).get('/api/agent-presets').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.presets.length).toBeGreaterThanOrEqual(3);
    expect(res.body.presets[0].featured).toBe(true);
    const protocols = res.body.presets.map((p: { protocol: string }) => p.protocol);
    expect(protocols).toContain('openai');
    expect(protocols).toContain('anthropic');
  });

  it('filters by search', async () => {
    const res = await request(app).get('/api/agent-presets?search=research').set(auth());
    expect(res.body.presets).toHaveLength(1);
    expect(res.body.presets[0].name).toBe('Research Analyst');
  });

  it('prefers the env-configured catalog and drops invalid entries', async () => {
    process.env.API_AGENT_CATALOG = JSON.stringify([
      {
        id: 'custom-bot',
        name: 'Custom Bot',
        protocol: 'openai',
        model: 'gpt-4o',
        systemPrompt: 'Custom system prompt.',
      },
      { name: 'Broken: no prompt', protocol: 'anthropic', model: 'claude-sonnet-5' },
    ]);

    const res = await request(app).get('/api/agent-presets').set(auth());
    expect(res.body.presets).toHaveLength(1);
    expect(res.body.presets[0].id).toBe('custom-bot');
  });
});

describe('deploy', () => {
  it('creates an api-runtime agent with manifest defaults and a README', async () => {
    const res = await request(app)
      .post('/api/agent-presets/api-writing-companion/deploy')
      .set(auth());
    expect(res.status).toBe(201);

    const agent = res.body.agent;
    expect(agent.runtime).toBe('api');
    expect(agent.model).toBe('claude-sonnet-5');
    expect(agent.manifest.api.protocol).toBe('anthropic');
    expect(agent.manifest.api.systemPrompt).toBeTruthy();
    expect(agent.tags).toContain('api');

    const workspace = storage.agentPaths(userId, agent.id).workspace;
    expect(fs.existsSync(path.join(workspace, 'README.md'))).toBe(true);
  });

  it('404s on unknown presets', async () => {
    const res = await request(app).post('/api/agent-presets/nope/deploy').set(auth());
    expect(res.status).toBe(404);
  });
});

describe('chat turns for API agents', () => {
  async function deployAndConverse(): Promise<{ agentId: string; conversationId: string }> {
    const deployed = await request(app)
      .post('/api/agent-presets/api-research-analyst/deploy')
      .set(auth());
    const agentId = deployed.body.agent.id;
    const conversation = await request(app)
      .post('/api/conversations')
      .set(auth())
      .send({ agentId });
    return { agentId, conversationId: conversation.body.conversation.id };
  }

  it('reports a missing provider as a system message, not a crash', async () => {
    const { conversationId } = await deployAndConverse();
    const outcome = await runChatTurn(userId, conversationId, 'Hello?');
    expect(outcome.reply.role).toBe('system');
    expect(outcome.reply.content).toContain('provider');
  });

  it('runs a streamed turn through the configured provider', async () => {
    const { agentId, conversationId } = await deployAndConverse();

    const provider = await request(app).post('/api/providers').set(auth()).send({
      name: 'OpenAI',
      vendor: 'openai',
      apiKey: 'sk-test-openai-key',
      models: ['gpt-4o-mini'],
    });
    await request(app)
      .patch(`/api/agents/${agentId}/config`)
      .set(auth())
      .send({ providerId: provider.body.provider.id, model: 'gpt-4o-mini' });

    let captured: ApiTurnRequest | null = null;
    setApiTurnExecutorForTests(async (req) => {
      captured = req;
      req.onChunk?.('Streamed ');
      req.onChunk?.('reply');
      return { text: 'Streamed reply', durationMs: 5 };
    });

    const chunks: string[] = [];
    const outcome = await runChatTurn(userId, conversationId, 'Summarize this', {
      onChunk: (t) => chunks.push(t),
    });

    expect(outcome.reply.role).toBe('assistant');
    expect(outcome.reply.content).toBe('Streamed reply');
    expect(chunks.join('')).toBe('Streamed reply');

    expect(captured!.protocol).toBe('openai');
    expect(captured!.model).toBe('gpt-4o-mini');
    expect(captured!.system).toBeTruthy();
    // Previous turns (including the system error above) are filtered/injected correctly.
    const roles = captured!.messages.map((m) => m.role);
    expect(roles[roles.length - 1]).toBe('user');
    expect(captured!.messages[captured!.messages.length - 1]!.content).toBe('Summarize this');
  });
});
