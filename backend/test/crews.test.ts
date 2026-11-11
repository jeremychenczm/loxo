import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/client';
import { createApp } from '../src/http/app';

const app = createApp();
let token = '';
let otherToken = '';
const agentIds: string[] = [];

const auth = (t = token) => ({ Authorization: `Bearer ${t}` });

async function register(email: string, username: string): Promise<string> {
  const res = await request(app)
    .post('/auth/register')
    .send({ email, username, password: 'a-strong-password' });
  return res.body.token;
}

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  token = await register('crews@example.com', 'crewsuser');
  otherToken = await register('crews-other@example.com', 'crewsother');
  for (const name of ['Ada', 'Grace', 'Linus']) {
    const res = await request(app).post('/api/agents').set(auth()).send({ name, runtime: 'api' });
    agentIds.push(res.body.agent.id);
  }
});

describe('crews', () => {
  let crewId = '';

  it('creates a crew and keeps the roster order', async () => {
    const res = await request(app)
      .post('/api/crews')
      .set(auth())
      .send({ name: 'Backend', agentIds: [agentIds[2], agentIds[0]] });
    expect(res.status).toBe(201);
    expect(res.body.crew.agentIds).toEqual([agentIds[2], agentIds[0]]);
    crewId = res.body.crew.id;

    const list = await request(app).get('/api/crews').set(auth());
    expect(list.body.crews).toHaveLength(1);
    expect(list.body.crews[0].agentIds).toEqual([agentIds[2], agentIds[0]]);
  });

  it('replaces the roster wholesale on update', async () => {
    const res = await request(app)
      .patch(`/api/crews/${crewId}`)
      .set(auth())
      .send({ name: 'Platform', agentIds: [agentIds[0], agentIds[1], agentIds[2]] });
    expect(res.status).toBe(200);
    expect(res.body.crew.name).toBe('Platform');
    expect(res.body.crew.agentIds).toEqual(agentIds);
  });

  it('rejects empty, duplicate, and foreign rosters', async () => {
    const empty = await request(app).post('/api/crews').set(auth()).send({ name: 'X', agentIds: [] });
    expect(empty.status).toBe(400);

    const duplicate = await request(app)
      .post('/api/crews')
      .set(auth())
      .send({ name: 'X', agentIds: [agentIds[0], agentIds[0]] });
    expect(duplicate.body.code).toBe('invalid_roster');

    const foreign = await request(app)
      .post('/api/crews')
      .set(auth(otherToken))
      .send({ name: 'X', agentIds: [agentIds[0]] });
    expect(foreign.body.code).toBe('invalid_roster');
  });

  it('hides crews from other users', async () => {
    const res = await request(app).get(`/api/crews/${crewId}`).set(auth(otherToken));
    expect(res.status).toBe(404);
  });

  it('drops a deleted agent from the roster', async () => {
    await request(app).delete(`/api/agents/${agentIds[1]}`).set(auth());
    const res = await request(app).get(`/api/crews/${crewId}`).set(auth());
    expect(res.body.crew.agentIds).toEqual([agentIds[0], agentIds[2]]);
  });

  it('deletes a crew without touching its agents', async () => {
    const res = await request(app).delete(`/api/crews/${crewId}`).set(auth());
    expect(res.status).toBe(200);
    const agent = await request(app).get(`/api/agents/${agentIds[0]}`).set(auth());
    expect(agent.status).toBe(200);
    const gone = await request(app).get(`/api/crews/${crewId}`).set(auth());
    expect(gone.status).toBe(404);
  });
});
