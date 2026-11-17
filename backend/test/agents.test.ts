import fs from 'node:fs';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/client';
import { createApp } from '../src/http/app';
import { storage } from '../src/storage/layout';

const app = createApp();
let token = '';
let userId = '';

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  const res = await request(app).post('/auth/register').send({
    email: 'agents@example.com',
    username: 'agentsuser',
    password: 'a-strong-password',
  });
  token = res.body.token;
  userId = res.body.user.id;
});

const auth = () => ({ Authorization: `Bearer ${token}` });

describe('agent CRUD and config', () => {
  let agentId = '';
  let anthropicProviderId = '';
  let openaiProviderId = '';

  beforeAll(async () => {
    const anthropic = await request(app).post('/api/providers').set(auth()).send({
      name: 'Anthropic',
      vendor: 'anthropic',
      apiKey: 'sk-ant-test-key-123',
      models: ['claude-sonnet-5'],
    });
    anthropicProviderId = anthropic.body.provider.id;

    const openai = await request(app).post('/api/providers').set(auth()).send({
      name: 'OpenAI',
      vendor: 'openai',
      apiKey: 'sk-openai-test-key',
    });
    openaiProviderId = openai.body.provider.id;
  });

  it('creates an agent and provisions its directories', async () => {
    const res = await request(app)
      .post('/api/agents')
      .set(auth())
      .send({ name: 'Reviewer', runtime: 'claude-code', tags: ['review'] });
    expect(res.status).toBe(201);
    agentId = res.body.agent.id;

    const paths = storage.agentPaths(userId, agentId);
    for (const dir of [paths.workspace, paths.state]) {
      expect(fs.existsSync(dir)).toBe(true);
    }
  });

  it('rejects a provider whose vendor does not match the runtime', async () => {
    const res = await request(app)
      .patch(`/api/agents/${agentId}/config`)
      .set(auth())
      .send({ providerId: openaiProviderId });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('vendor_mismatch');
  });

  it('rejects a model missing from the provider model list', async () => {
    const res = await request(app)
      .patch(`/api/agents/${agentId}/config`)
      .set(auth())
      .send({ providerId: anthropicProviderId, model: 'gpt-4o' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('unknown_model');
  });

  it('accepts a matching provider and listed model', async () => {
    const res = await request(app)
      .patch(`/api/agents/${agentId}/config`)
      .set(auth())
      .send({ providerId: anthropicProviderId, model: 'claude-sonnet-5' });
    expect(res.status).toBe(200);
    expect(res.body.agent.model).toBe('claude-sonnet-5');
  });

  it('reports diagnostics with cli and provider status', async () => {
    const res = await request(app).get(`/api/agents/${agentId}/diagnostics`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.agent.runtime).toBe('claude-code');
    expect(res.body.cli).toHaveProperty('available');
    expect(res.body.provider).toMatchObject({ vendor: 'anthropic', vendorMatch: true });
  });

  it('deletes the agent and removes its directory tree', async () => {
    const root = storage.agentPaths(userId, agentId).root;
    const res = await request(app).delete(`/api/agents/${agentId}`).set(auth());
    expect(res.status).toBe(200);
    expect(fs.existsSync(root)).toBe(false);

    const gone = await request(app).get(`/api/agents/${agentId}`).set(auth());
    expect(gone.status).toBe(404);
  });
});
