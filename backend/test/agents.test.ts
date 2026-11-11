import AdmZip from 'adm-zip';
import fs from 'node:fs';
import zlib from 'node:zlib';
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
    for (const dir of [paths.workspace, paths.baseline, paths.state]) {
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

describe('agent import', () => {
  function buildZip(entries: Record<string, string>): Buffer {
    const zip = new AdmZip();
    for (const [name, content] of Object.entries(entries)) {
      zip.addFile(name, Buffer.from(content));
    }
    return zip.toBuffer();
  }

  /** Minimal stored-entry zip with an arbitrary (unsanitized) entry name. */
  function craftRawZip(entryName: string, data: Buffer): Buffer {
    const crc = zlib.crc32(data);
    const name = Buffer.from(entryName, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0, 42); // local header offset

    const cdOffset = local.length + name.length + data.length;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(central.length + name.length, 12);
    eocd.writeUInt32LE(cdOffset, 16);

    return Buffer.concat([local, name, data, central, name, eocd]);
  }

  it('imports a zip, detects the runtime, and seeds the baseline', async () => {
    const archive = buildZip({
      '.claude/settings.json': '{}',
      'CLAUDE.md': '# Agent instructions',
      'notes/readme.md': 'hello',
    });

    const res = await request(app)
      .post('/api/agents/import')
      .set(auth())
      .field('name', 'Imported Agent')
      .attach('archive', archive, 'agent.zip');

    expect(res.status).toBe(201);
    expect(res.body.agent.runtime).toBe('claude-code');
    expect(res.body.fileCount).toBe(3);

    const paths = storage.agentPaths(userId, res.body.agent.id);
    expect(fs.existsSync(`${paths.workspace}/notes/readme.md`)).toBe(true);
    expect(fs.existsSync(`${paths.baseline}/CLAUDE.md`)).toBe(true);
  });

  it('reads agent.json metadata when present', async () => {
    const archive = buildZip({
      'agent.json': JSON.stringify({ runtime: 'api', description: 'Hosted helper' }),
      'prompt.md': 'You are helpful.',
    });

    const res = await request(app)
      .post('/api/agents/import')
      .set(auth())
      .field('name', 'API Agent')
      .attach('archive', archive, 'agent.zip');

    expect(res.status).toBe(201);
    expect(res.body.agent.runtime).toBe('api');
    expect(res.body.agent.description).toBe('Hosted helper');
  });

  it('rejects archives with traversal paths', async () => {
    // adm-zip sanitizes names on write, so craft the malicious entry as raw
    // zip bytes the way an attacker's tooling would.
    const res = await request(app)
      .post('/api/agents/import')
      .set(auth())
      .field('name', 'Evil')
      .attach('archive', craftRawZip('../escape.txt', Buffer.from('bad')), 'evil.zip');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('unsafe_archive');
  });

  it('rejects imports whose runtime cannot be resolved', async () => {
    const archive = buildZip({ 'main.py': 'print(1)' });
    const res = await request(app)
      .post('/api/agents/import')
      .set(auth())
      .field('name', 'Mystery')
      .attach('archive', archive, 'mystery.zip');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('unknown_runtime');
  });

  it('imports loose files with relative paths', async () => {
    const res = await request(app)
      .post('/api/agents/import')
      .set(auth())
      .field('name', 'Folder Agent')
      .field('runtime', 'hermes')
      .attach('files', Buffer.from('memories'), { filename: '.hermes/memories.md' })
      .attach('files', Buffer.from('config'), { filename: 'hermes.yaml' });

    expect(res.status).toBe(201);
    expect(res.body.agent.runtime).toBe('hermes');
    expect(res.body.fileCount).toBe(2);
  });
});

describe('agent skills', () => {
  let agentId = '';

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/agents')
      .set(auth())
      .send({ name: 'Skillful', runtime: 'api' });
    agentId = res.body.agent.id;
  });

  it('installs a markdown skill and parses its frontmatter', async () => {
    const skill = ['---', 'name: Web Testing', 'description: Drives browser tests', '---', '', 'Body.'].join('\n');
    const res = await request(app)
      .post(`/api/agents/${agentId}/skills`)
      .set(auth())
      .attach('skill', Buffer.from(skill), 'web-testing.md');

    expect(res.status).toBe(201);
    expect(res.body.skills).toHaveLength(1);
    expect(res.body.skills[0]).toMatchObject({
      name: 'Web Testing',
      description: 'Drives browser tests',
    });
  });

  it('installs every SKILL.md directory from a zip', async () => {
    const zip = new AdmZip();
    zip.addFile('alpha/SKILL.md', Buffer.from('---\nname: Alpha\n---\nA.'));
    zip.addFile('alpha/helper.py', Buffer.from('pass'));
    zip.addFile('beta/SKILL.md', Buffer.from('Beta skill body.'));

    const res = await request(app)
      .post(`/api/agents/${agentId}/skills`)
      .set(auth())
      .attach('skill', zip.toBuffer(), 'skills.zip');

    expect(res.status).toBe(201);
    expect(res.body.skills).toHaveLength(3);
    const names = res.body.skills.map((s: { name: string }) => s.name);
    expect(names).toContain('Alpha');
  });

  it('rejects zips without any SKILL.md', async () => {
    const zip = new AdmZip();
    zip.addFile('readme.md', Buffer.from('nothing'));
    const res = await request(app)
      .post(`/api/agents/${agentId}/skills`)
      .set(auth())
      .attach('skill', zip.toBuffer(), 'nothing.zip');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('no_skill_found');
  });
});
