import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/client';
import { createApp } from '../src/http/app';
import { projectRoot } from '../src/modules/projects/projects.service';
import { storage } from '../src/storage/layout';

const app = createApp();
let token = '';
let userId = '';
let agentId = '';

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  const reg = await request(app).post('/auth/register').send({
    email: 'projects@example.com',
    username: 'projectsuser',
    password: 'a-strong-password',
  });
  token = reg.body.token;
  userId = reg.body.user.id;

  const agent = await request(app)
    .post('/api/agents')
    .set({ Authorization: `Bearer ${token}` })
    .send({ name: 'Bound agent', runtime: 'api' });
  agentId = agent.body.agent.id;
});

const auth = () => ({ Authorization: `Bearer ${token}` });

describe('projects', () => {
  let projectId = '';

  it('creates a project with bindings and disk metadata', async () => {
    const res = await request(app)
      .post('/api/projects')
      .set(auth())
      .send({
        name: 'Research hub',
        description: 'All research work',
        agentIds: [agentId],
      });
    expect(res.status).toBe(201);
    projectId = res.body.project.id;
    expect(res.body.project.agentIds).toEqual([agentId]);

    const metaFile = path.join(storage.projectWorkspace(userId, projectId), '.swarmdev-project.json');
    expect(fs.existsSync(metaFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(metaFile, 'utf8')).name).toBe('Research hub');
  });

  it('rejects bindings to agents the user does not own', async () => {
    const res = await request(app)
      .post('/api/projects')
      .set(auth())
      .send({ name: 'Bad bindings', agentIds: [crypto.randomUUID()] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_binding');
  });

  it('orders the list by recency and lets touch reorder it', async () => {
    const second = await request(app)
      .post('/api/projects')
      .set(auth())
      .send({ name: 'Second project' });
    expect(second.status).toBe(201);

    let list = await request(app).get('/api/projects').set(auth());
    expect(list.body.projects[0].name).toBe('Second project');

    const touched = await request(app).post(`/api/projects/${projectId}/open`).set(auth());
    expect(touched.status).toBe(200);

    list = await request(app).get('/api/projects').set(auth());
    expect(list.body.projects[0].id).toBe(projectId);
    // Touch lands at least 1s past the previous maximum.
    const [first, next] = list.body.projects;
    expect(new Date(first.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(next.updatedAt).getTime() + 1000
    );
  });

  it('updates fields and replaces bindings', async () => {
    const res = await request(app)
      .patch(`/api/projects/${projectId}`)
      .set(auth())
      .send({ description: 'Updated intro', agentIds: [] });
    expect(res.status).toBe(200);
    expect(res.body.project.description).toBe('Updated intro');
    expect(res.body.project.agentIds).toEqual([]);
  });

  it('hides foreign projects', async () => {
    const stranger = await request(app).post('/auth/register').send({
      email: 'stranger-projects@example.com',
      username: 'strangerprojects',
      password: 'a-strong-password',
    });
    const res = await request(app)
      .get(`/api/projects/${projectId}`)
      .set({ Authorization: `Bearer ${stranger.body.token}` });
    expect(res.status).toBe(404);
  });

  it('deletes the project and its disk root', async () => {
    const res = await request(app)
      .post('/api/projects')
      .set(auth())
      .send({ name: 'Disposable' });
    const disposableId = res.body.project.id;
    const root = projectRoot(userId, disposableId);
    expect(fs.existsSync(root)).toBe(true);

    const del = await request(app).delete(`/api/projects/${disposableId}`).set(auth());
    expect(del.status).toBe(200);
    expect(fs.existsSync(root)).toBe(false);
  });
});
