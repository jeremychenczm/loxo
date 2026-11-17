import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/client';
import { createApp } from '../src/http/app';
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
