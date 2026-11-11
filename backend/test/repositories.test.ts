import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/client';
import { createApp } from '../src/http/app';
import { storage } from '../src/storage/layout';
import { git, initFixtureRepo, makeSandbox, removeSandbox } from './fixtures/git-repo';

const app = createApp();
const T = 30_000;
let token = '';
let otherToken = '';
let sandbox = '';
let seq = 0;

const auth = (t = token) => ({ Authorization: `Bearer ${t}` });

async function register(email: string, username: string): Promise<string> {
  const res = await request(app)
    .post('/auth/register')
    .send({ email, username, password: 'a-strong-password' });
  return res.body.token;
}

async function freshRepo(): Promise<string> {
  seq += 1;
  return initFixtureRepo(path.join(sandbox, `repo-${seq}`));
}

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  token = await register('repos@example.com', 'reposuser');
  otherToken = await register('repos-other@example.com', 'reposother');
  sandbox = makeSandbox('repositories');
});

afterAll(() => removeSandbox(sandbox));

afterEach(() => {
  delete process.env.REPOSITORY_ROOTS;
});

describe('repository registration', () => {
  it('registers a repository root without touching it', { timeout: T }, async () => {
    const dir = await freshRepo();
    const headBefore = await git(dir, 'rev-parse', 'HEAD');
    const statusBefore = await git(dir, 'status', '--porcelain');

    const res = await request(app).post('/api/repositories').set(auth()).send({ rootPath: dir });
    expect(res.status).toBe(201);
    expect(res.body.repository.name).toBe(path.basename(dir));
    expect(res.body.repository.defaultBranch).toBe('main');
    expect(res.body.repository.checks).toEqual([]);

    expect(await git(dir, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(await git(dir, 'status', '--porcelain')).toBe(statusBefore);
  });

  it('rejects relative, non-repository, nested, and storage paths', { timeout: T }, async () => {
    const relative = await request(app)
      .post('/api/repositories')
      .set(auth())
      .send({ rootPath: 'some/relative/path' });
    expect(relative.body.code).toBe('invalid_path');

    const plain = path.join(sandbox, 'not-a-repo');
    fs.mkdirSync(plain, { recursive: true });
    const notRepo = await request(app).post('/api/repositories').set(auth()).send({ rootPath: plain });
    expect(notRepo.body.code).toBe('not_a_repository');

    const dir = await freshRepo();
    const nested = path.join(dir, 'src');
    fs.mkdirSync(nested, { recursive: true });
    const sub = await request(app).post('/api/repositories').set(auth()).send({ rootPath: nested });
    expect(sub.body.code).toBe('not_a_repository');

    const inside = await request(app)
      .post('/api/repositories')
      .set(auth())
      .send({ rootPath: path.join(storage.root, 'anything') });
    expect(inside.body.code).toBe('invalid_path');
  });

  it('requires the default branch to exist and rejects duplicates', { timeout: T }, async () => {
    const dir = await freshRepo();
    const missing = await request(app)
      .post('/api/repositories')
      .set(auth())
      .send({ rootPath: dir, defaultBranch: 'develop' });
    expect(missing.body.code).toBe('base_ref_not_branch');

    const first = await request(app).post('/api/repositories').set(auth()).send({ rootPath: dir });
    expect(first.status).toBe(201);
    const again = await request(app).post('/api/repositories').set(auth()).send({ rootPath: dir });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('repository_exists');
  });

  it('enforces the configured repository roots', { timeout: T }, async () => {
    const allowedRoot = path.join(sandbox, 'allowed');
    const inside = await initFixtureRepo(path.join(allowedRoot, 'inside'));
    const outside = await freshRepo();
    process.env.REPOSITORY_ROOTS = allowedRoot;

    const rejected = await request(app).post('/api/repositories').set(auth()).send({ rootPath: outside });
    expect(rejected.body.code).toBe('path_not_allowed');
    const accepted = await request(app).post('/api/repositories').set(auth()).send({ rootPath: inside });
    expect(accepted.status).toBe(201);
  });
});

describe('repository settings', () => {
  it('updates name, setup, checks, and a valid default branch', { timeout: T }, async () => {
    const dir = await freshRepo();
    await git(dir, 'branch', 'release');
    const created = await request(app).post('/api/repositories').set(auth()).send({ rootPath: dir });
    const id = created.body.repository.id as string;

    const updated = await request(app)
      .patch(`/api/repositories/${id}`)
      .set(auth())
      .send({
        name: 'Ledger',
        setupCommand: '  npm ci  ',
        checks: [{ name: 'test', command: 'npm test', timeoutSeconds: 300 }],
        defaultBranch: 'release',
      });
    expect(updated.status).toBe(200);
    expect(updated.body.repository).toMatchObject({
      name: 'Ledger',
      setupCommand: 'npm ci',
      defaultBranch: 'release',
      checks: [{ name: 'test', command: 'npm test', timeoutSeconds: 300 }],
    });

    const cleared = await request(app)
      .patch(`/api/repositories/${id}`)
      .set(auth())
      .send({ setupCommand: '' });
    expect(cleared.body.repository.setupCommand).toBeNull();

    const badBranch = await request(app)
      .patch(`/api/repositories/${id}`)
      .set(auth())
      .send({ defaultBranch: 'nope' });
    expect(badBranch.body.code).toBe('base_ref_not_branch');

    const dupChecks = await request(app)
      .patch(`/api/repositories/${id}`)
      .set(auth())
      .send({
        checks: [
          { name: 'test', command: 'a' },
          { name: 'test', command: 'b' },
        ],
      });
    expect(dupChecks.body.code).toBe('invalid_checks');
  });

  it('detects a different repository at the registered path', { timeout: T }, async () => {
    const dir = await freshRepo();
    const created = await request(app).post('/api/repositories').set(auth()).send({ rootPath: dir });
    const id = created.body.repository.id as string;

    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    await initFixtureRepo(dir, { 'OTHER.md': 'another history\n' });

    const res = await request(app).post(`/api/repositories/${id}/inspect`).set(auth());
    expect(res.body.inspection.valid).toBe(true);
    expect(res.body.inspection.sameRepository).toBe(false);
  });

  it('isolates repositories per user and forgets them on delete', { timeout: T }, async () => {
    const dir = await freshRepo();
    const created = await request(app).post('/api/repositories').set(auth()).send({ rootPath: dir });
    const id = created.body.repository.id as string;

    const foreign = await request(app).get(`/api/repositories/${id}`).set(auth(otherToken));
    expect(foreign.status).toBe(404);

    const removed = await request(app).delete(`/api/repositories/${id}`).set(auth());
    expect(removed.status).toBe(200);
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(true);
    const gone = await request(app).get(`/api/repositories/${id}`).set(auth());
    expect(gone.status).toBe(404);
  });
});
