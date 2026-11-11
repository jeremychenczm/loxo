import path from 'node:path';
import { fakeAgentCommand } from '@swarmdev/fake-agent';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/client';
import { createApp } from '../src/http/app';
import { AcpHost } from '../src/modules/hosts/acp-host';
import type { PermissionRequest } from '../src/modules/hosts/host.types';
import { createPermissionArbiter } from '../src/modules/hosts/permission-arbiter';
import { makeSandbox, removeSandbox } from './fixtures/git-repo';

const app = createApp();
const T = 30_000;
let token = '';
let otherToken = '';
let taskId = '';
let sandbox = '';

const auth = (t = token) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  const reg = await request(app)
    .post('/auth/register')
    .send({ email: 'arbiter@example.com', username: 'arbiteruser', password: 'a-strong-password' });
  token = reg.body.token;
  const other = await request(app)
    .post('/auth/register')
    .send({ email: 'arbiter-other@example.com', username: 'arbiterother', password: 'a-strong-password' });
  otherToken = other.body.token;
  const task = await request(app).post('/api/tasks').set(auth()).send({ title: 'Guarded work' });
  taskId = task.body.task.id;
  sandbox = makeSandbox('arbiter');
});

afterAll(() => removeSandbox(sandbox));

const push: PermissionRequest = {
  toolCallId: 'push-1',
  title: 'git push origin main',
  toolKind: 'execute',
  paths: [],
  input: { command: 'git push origin main' },
};

async function openRequests() {
  const res = await request(app).get('/api/human-requests?status=open').set(auth());
  return res.body.requests as Array<{ id: string; kind: string; payload: Record<string, unknown>; choices: string[] }>;
}

/** Answers the next open request as soon as it appears. */
async function answerNext(choice: string, note?: string): Promise<string> {
  for (let i = 0; i < 100; i += 1) {
    const [open] = await openRequests();
    if (open) {
      const res = await request(app)
        .post(`/api/human-requests/${open.id}/answer`)
        .set(auth())
        .send({ choice, ...(note ? { note } : {}) });
      expect(res.status).toBe(200);
      return open.id;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('no request appeared');
}

function arbiter(askTimeoutMs = 10_000, withTask = true) {
  return createPermissionArbiter({
    context: { permission: 'full', workspaceRoot: sandbox },
    taskId: withTask ? taskId : null,
    askTimeoutMs,
  });
}

describe('permission arbiter', () => {
  it('decides clear cases without asking anyone', { timeout: T }, async () => {
    const decide = arbiter();
    expect(
      await decide({ ...push, toolCallId: 'r', toolKind: 'read', paths: [path.join(sandbox, 'a.ts')], input: undefined })
    ).toMatchObject({ outcome: 'allow' });
    expect(
      await decide({ ...push, toolCallId: 'o', toolKind: 'edit', paths: [path.resolve('/etc/hosts')], input: undefined })
    ).toMatchObject({ outcome: 'deny', reason: expect.stringContaining('outside the assigned worktree') });
    expect(await openRequests()).toHaveLength(0);
  });

  it('asks a person and follows an approval', { timeout: T }, async () => {
    const pending = arbiter()(push);
    const id = await answerNext('allow', 'release day');
    expect(await pending).toEqual({ outcome: 'allow', reason: 'Approved: release day' });

    const all = await request(app).get(`/api/human-requests?taskId=${taskId}`).set(auth());
    const row = all.body.requests.find((r: { id: string }) => r.id === id);
    expect(row).toMatchObject({
      kind: 'permission',
      status: 'answered',
      choices: ['allow', 'deny'],
      payload: { command: 'git push origin main', rule: 'exec.dangerous' },
      answer: { choice: 'allow', note: 'release day' },
    });
  });

  it('follows a refusal', { timeout: T }, async () => {
    const pending = arbiter()(push);
    await answerNext('deny');
    expect(await pending).toEqual({ outcome: 'deny', reason: 'Denied by a person' });
  });

  it('denies when nobody answers in time and closes the request', { timeout: T }, async () => {
    const decision = await arbiter(800)(push);
    expect(decision).toMatchObject({ outcome: 'deny', reason: expect.stringContaining('No answer within') });
    const all = await request(app).get(`/api/human-requests?taskId=${taskId}&status=expired`).set(auth());
    expect(all.body.requests.length).toBeGreaterThan(0);
    const late = await request(app)
      .post(`/api/human-requests/${all.body.requests[0].id}/answer`)
      .set(auth())
      .send({ choice: 'allow' });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('request_closed');
  });

  it('validates answers and hides requests from other users', { timeout: T }, async () => {
    const pending = arbiter(5000)(push);
    let open: Awaited<ReturnType<typeof openRequests>> = [];
    while (open.length === 0) {
      open = await openRequests();
      await new Promise((r) => setTimeout(r, 50));
    }
    const id = open[0]!.id;
    const bad = await request(app).post(`/api/human-requests/${id}/answer`).set(auth()).send({ choice: 'maybe' });
    expect(bad.body.code).toBe('invalid_choice');
    const foreign = await request(app)
      .post(`/api/human-requests/${id}/answer`)
      .set(auth(otherToken))
      .send({ choice: 'allow' });
    expect(foreign.status).toBe(404);
    const theirs = await request(app).get('/api/human-requests').set(auth(otherToken));
    expect(theirs.body.requests).toHaveLength(0);
    await request(app).post(`/api/human-requests/${id}/answer`).set(auth()).send({ choice: 'deny' });
    await pending;
  });

  it('denies questions that have no task to attach to', { timeout: T }, async () => {
    const decision = await arbiter(10_000, false)(push);
    expect(decision).toMatchObject({ outcome: 'deny', reason: expect.stringContaining('outside a task') });
  });

  it('lets a person approve a live agent request end to end', { timeout: T }, async () => {
    const host = new AcpHost(
      fakeAgentCommand({
        turns: [
          {
            steps: [
              {
                permission: {
                  toolCallId: 'p-live',
                  title: 'git push origin loxo/t1/integration',
                  kind: 'execute',
                  onAllow: [{ say: 'pushed' }],
                  onReject: [{ say: 'not pushed' }],
                },
              },
            ],
          },
        ],
      })
    );
    const session = await host.openSession({ cwd: sandbox, mcpServers: [], arbiter: arbiter() });
    try {
      const pending = session.prompt({ prompt: 'publish the branch' });
      await answerNext('allow');
      expect((await pending).text).toBe('pushed');
    } finally {
      await session.close();
    }
  });
});
