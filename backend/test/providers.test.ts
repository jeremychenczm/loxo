import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { openSecret, sealSecret } from '../src/crypto/secretbox';
import { pool } from '../src/db/client';
import { createApp } from '../src/http/app';

const app = createApp();
let token = '';

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  const res = await request(app).post('/auth/register').send({
    email: 'providers@example.com',
    username: 'provuser',
    password: 'a-strong-password',
  });
  token = res.body.token;
});

const auth = () => ({ Authorization: `Bearer ${token}` });

describe('secretbox', () => {
  it('round-trips plaintext', () => {
    const envelope = sealSecret('sk-test-1234567890');
    expect(envelope).not.toContain('sk-test');
    expect(openSecret(envelope)).toBe('sk-test-1234567890');
  });

  it('produces distinct envelopes per call (random IV)', () => {
    expect(sealSecret('same')).not.toBe(sealSecret('same'));
  });
});

describe('providers API', () => {
  let providerId = '';

  it('requires auth', async () => {
    const res = await request(app).get('/api/providers');
    expect(res.status).toBe(401);
  });

  it('creates a provider and never returns the key', async () => {
    const res = await request(app).post('/api/providers').set(auth()).send({
      name: 'Anthropic main',
      vendor: 'anthropic',
      apiKey: 'sk-ant-secret-key-abcdef',
      models: ['claude-sonnet-5'],
      isDefault: true,
    });
    expect(res.status).toBe(201);
    providerId = res.body.provider.id;
    expect(res.body.provider.apiKeyPrefix).toBe('sk-ant-s…');
    expect(JSON.stringify(res.body)).not.toContain('sk-ant-secret-key-abcdef');

    const [row] = (
      await pool.query('SELECT api_key_encrypted FROM providers WHERE id = $1', [providerId])
    ).rows;
    expect(row.api_key_encrypted).not.toContain('sk-ant-secret-key-abcdef');
  });

  it('rejects unknown vendors', async () => {
    const res = await request(app).post('/api/providers').set(auth()).send({
      name: 'Bad',
      vendor: 'other',
      apiKey: 'whatever-key',
    });
    expect(res.status).toBe(400);
  });

  it('keeps a single default per vendor', async () => {
    const second = await request(app).post('/api/providers').set(auth()).send({
      name: 'Anthropic backup',
      vendor: 'anthropic',
      apiKey: 'sk-ant-second-key-abcdef',
      isDefault: true,
    });
    expect(second.status).toBe(201);

    const list = await request(app).get('/api/providers').set(auth());
    const defaults = list.body.providers.filter(
      (p: { vendor: string; isDefault: boolean }) => p.vendor === 'anthropic' && p.isDefault
    );
    expect(defaults).toHaveLength(1);
    expect(defaults[0].name).toBe('Anthropic backup');
  });

  it('updates and deletes', async () => {
    const patch = await request(app)
      .patch(`/api/providers/${providerId}`)
      .set(auth())
      .send({ name: 'Renamed' });
    expect(patch.status).toBe(200);
    expect(patch.body.provider.name).toBe('Renamed');

    const del = await request(app).delete(`/api/providers/${providerId}`).set(auth());
    expect(del.status).toBe(200);

    const again = await request(app).delete(`/api/providers/${providerId}`).set(auth());
    expect(again.status).toBe(404);
  });

  it('reports runtime health with per-platform readiness', async () => {
    const res = await request(app).get('/api/providers/runtime-health').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.health.platforms.map((p: { platform: string }) => p.platform)).toEqual(['claude-code', 'codex']);
    for (const platform of res.body.health.platforms) {
      expect(platform).toHaveProperty('cli.available');
      expect(platform).toHaveProperty('ready');
      expect(platform.installHint).toBeTruthy();
    }
  });
});
