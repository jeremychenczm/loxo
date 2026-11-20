import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import { repositories, runs } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { setMergeLockTtlForTests } from '../src/modules/code-workspaces/workspace.service';
import { recordApproval } from '../src/modules/tasks/approvals.service';
import { setTaskHostFactoryForTests } from '../src/modules/runs/task-run';
import { scriptedHost, type ScriptedReply, type ScriptedTurn } from './support/scripted-host';
import { drainRunsForTests, requestWake } from '../src/modules/runs/wake';
import { git, initFixtureRepo, makeSandbox, removeSandbox } from './fixtures/git-repo';

const app = createApp();
const T = 30_000;

let token = '';
let userId = '';
let workerId = '';
let sandbox = '';
let repoDir = '';
let repositoryId = '';

let onTurn: (req: ScriptedTurn) => void = () => {};

const auth = () => ({ Authorization: `Bearer ${token}` });

interface TaskRef {
  id: string;
  number: number;
}

async function createTaskIn(title: string): Promise<TaskRef> {
  const res = await request(app).post('/api/tasks').set(auth()).send({ title, repositoryId });
  expect(res.status).toBe(201);
  return res.body.task;
}

async function workedTask(title: string, work: (workspace: string) => void): Promise<TaskRef> {
  const task = await createTaskIn(title);
  onTurn = (req) => work(req.workspace);
  await requestWake(userId, { agentId: workerId, taskId: task.id, trigger: 'manual' });
  await drainRunsForTests();
  for (const status of ['todo', 'in_progress', 'in_review']) {
    const res = await request(app)
      .post(`/api/tasks/${task.id}/move`)
      .set(auth())
      .send({ status });
    expect(res.status).toBe(200);
  }
  await drainRunsForTests();
  return task;
}

async function approve(taskId: string): Promise<void> {
  const approval = await recordApproval(userId, taskId, {
    decision: 'approved',
    body: 'Verified against the captured change set.',
  });
  expect(approval.changeSnapshotId).not.toBeNull();
  expect(approval.fingerprint).toMatch(/^[0-9a-f]{64}$/);
}

async function taskStatus(taskId: string): Promise<string> {
  const res = await request(app).get(`/api/tasks/${taskId}`).set(auth());
  return res.body.task.status;
}

async function workspaceOf(taskId: string) {
  const res = await request(app).get(`/api/tasks/${taskId}/workspace`).set(auth());
  return res.body.workspace as {
    id: string;
    status: string;
    branchName: string;
    worktreePath: string;
  } | null;
}

/** Before-state refs pinned by the task's runs that still exist in the repository. */
async function beforeRefsOf(taskId: string): Promise<string[]> {
  const rows = await db.select({ id: runs.id }).from(runs).where(eq(runs.taskId, taskId));
  const refs = (await git(repoDir, 'for-each-ref', '--format=%(refname)', 'refs/loxo/runs/')).split('\n');
  return refs.filter((ref) => rows.some((r) => ref === `refs/loxo/runs/${r.id}/before`));
}

function finalize(taskId: string, action: 'merge' | 'keep-branch', body: object = {}) {
  return request(app).post(`/api/tasks/${taskId}/workspace/${action}`).set(auth()).send(body);
}

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  setTaskHostFactoryForTests(scriptedHost(async (req) => {
    onTurn(req);
    return { text: 'stub output' };
  }));

  const reg = await request(app).post('/auth/register').send({
    email: 'finalize@example.com',
    username: 'finalizeuser',
    password: 'a-strong-password',
  });
  token = reg.body.token;
  userId = reg.body.user.id;

  const agent = await request(app)
    .post('/api/agents')
    .set(auth())
    .send({ name: 'Finalize Worker', runtime: 'claude-code' });
  workerId = agent.body.agent.id;

  sandbox = makeSandbox('finalize');
  repoDir = await initFixtureRepo(path.join(sandbox, 'repo'), { 'README.md': '# base\n' });

  const created = await request(app).post('/api/repositories').set(auth()).send({ rootPath: repoDir });
  expect(created.status).toBe(201);
  repositoryId = created.body.repository.id;
});

afterAll(() => {
  setTaskHostFactoryForTests(null);
  removeSandbox(sandbox);
});

afterEach(async () => {
  await drainRunsForTests();
  onTurn = () => {};
});

describe('merge finalization', () => {
  it('requires a snapshot-bound human approval', { timeout: T }, async () => {
    const task = await workedTask('No approval yet', (ws) => {
      fs.writeFileSync(path.join(ws, 'a.txt'), 'a\n');
    });
    const res = await finalize(task.id, 'merge', { confirmCheckpoint: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('approval_required');
  });

  it('requires checkpoint confirmation for uncommitted work, then merges into the base', { timeout: T }, async () => {
    const task = await workedTask('Merge me', (ws) => {
      fs.writeFileSync(path.join(ws, 'ledger.ts'), 'export const ledger = 1;\n');
    });
    await approve(task.id);
    expect(await beforeRefsOf(task.id)).not.toHaveLength(0);

    const unconfirmed = await finalize(task.id, 'merge');
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.body.code).toBe('checkpoint_required');

    const merged = await finalize(task.id, 'merge', { confirmCheckpoint: true });
    expect(merged.status).toBe(200);
    expect(merged.body.workspace.status).toBe('merged');
    expect(merged.body.taskStatus).toBe('done');

    expect(fs.existsSync(path.join(repoDir, 'ledger.ts'))).toBe(true);
    const subject = await git(repoDir, 'log', '-1', '--format=%s');
    expect(subject).toContain(`Merge task #${task.number}`);
    expect(fs.existsSync(merged.body.workspace.worktreePath)).toBe(false);
    const branches = await git(repoDir, 'branch', '--list', merged.body.workspace.branchName);
    expect(branches).toContain(merged.body.workspace.branchName);
    expect(await taskStatus(task.id)).toBe('done');
    expect(await beforeRefsOf(task.id)).toEqual([]);

    const [repo] = await db
      .select()
      .from(repositories)
      .where(eq(repositories.id, repositoryId));
    expect(repo!.activeMergeWorkspaceId).toBeNull();
  });

  it('rejects a merge when the workspace changed after approval', { timeout: T }, async () => {
    const task = await workedTask('Stale approval', (ws) => {
      fs.writeFileSync(path.join(ws, 'b.txt'), 'b1\n');
    });
    await approve(task.id);
    const ws = await workspaceOf(task.id);
    fs.writeFileSync(path.join(ws!.worktreePath, 'b.txt'), 'b2 changed after approval\n');

    const res = await finalize(task.id, 'merge', { confirmCheckpoint: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('stale_approval');
    expect(await taskStatus(task.id)).toBe('in_review');
  });

  it('aborts a conflicted merge, restores the base checkout, and keeps the task in review', { timeout: T }, async () => {
    const task = await workedTask('Conflicting change', (ws) => {
      fs.writeFileSync(path.join(ws, 'README.md'), '# task version\n');
    });
    await approve(task.id);

    fs.writeFileSync(path.join(repoDir, 'README.md'), '# mainline version\n');
    await git(repoDir, 'add', '.');
    await git(repoDir, 'commit', '-m', 'mainline change');

    const res = await finalize(task.id, 'merge', { confirmCheckpoint: true });
    expect(res.status).toBe(200);
    expect(res.body.workspace.status).toBe('conflicted');
    expect(await taskStatus(task.id)).toBe('in_review');

    const restored = fs.readFileSync(path.join(repoDir, 'README.md'), 'utf8').replace(/\r\n/g, '\n');
    expect(restored).toBe('# mainline version\n');
    expect(await git(repoDir, 'status', '--porcelain')).toBe('');
    const ws = await workspaceOf(task.id);
    expect(fs.existsSync(ws!.worktreePath)).toBe(true);
  });

  it('refuses to merge into a wrong or dirty primary checkout', { timeout: T }, async () => {
    const task = await workedTask('Guarded merge', (ws) => {
      fs.writeFileSync(path.join(ws, 'c.txt'), 'c\n');
    });
    await approve(task.id);

    await git(repoDir, 'checkout', '-b', 'sidetrack');
    const wrongBranch = await finalize(task.id, 'merge', { confirmCheckpoint: true });
    expect(wrongBranch.status).toBe(400);
    expect(wrongBranch.body.code).toBe('merge_precondition_failed');
    await git(repoDir, 'checkout', 'main');

    fs.writeFileSync(path.join(repoDir, 'scratch.txt'), 'uncommitted\n');
    const dirty = await finalize(task.id, 'merge', { confirmCheckpoint: true });
    expect(dirty.status).toBe(400);
    expect(dirty.body.code).toBe('merge_precondition_failed');
    fs.rmSync(path.join(repoDir, 'scratch.txt'));

    const ok = await finalize(task.id, 'merge', { confirmCheckpoint: true });
    expect(ok.status).toBe(200);
    expect(ok.body.workspace.status).toBe('merged');
  });
});

describe('merge lock', () => {
  async function lockRow() {
    const [row] = await db
      .select({
        operationId: repositories.activeMergeOperationId,
        owner: repositories.activeMergeOwnerInstance,
        leaseExpiresAt: repositories.activeMergeLeaseExpiresAt,
      })
      .from(repositories)
      .where(eq(repositories.id, repositoryId));
    return row!;
  }

  async function plantLock(workspaceId: string, owner: string, leaseExpiresAt: Date | null) {
    const operationId = crypto.randomUUID();
    await db
      .update(repositories)
      .set({
        activeMergeWorkspaceId: workspaceId,
        activeMergeOperationId: operationId,
        activeMergePreHead: await git(repoDir, 'rev-parse', 'HEAD'),
        activeMergeStartedAt: new Date(Date.now() - 60_000),
        activeMergeOwnerInstance: owner,
        activeMergeLeaseExpiresAt: leaseExpiresAt,
      })
      .where(eq(repositories.id, repositoryId));
    return operationId;
  }

  it('treats a lock under another instance\'s live lease as held', { timeout: T }, async () => {
    const task = await workedTask('Lock holder', (ws) => {
      fs.writeFileSync(path.join(ws, 'd.txt'), 'd\n');
    });
    await approve(task.id);
    const ws = await workspaceOf(task.id);
    // Started a minute ago in another process: age and process-local state say nothing.
    const operationId = await plantLock(ws!.id, 'other-instance', new Date(Date.now() + 60_000));

    const res = await finalize(task.id, 'merge', { confirmCheckpoint: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('merge_in_progress');
    expect(await lockRow()).toMatchObject({ operationId, owner: 'other-instance' });

    // The holder's lease lapses without renewal; now the lock is stale and recoverable.
    await db
      .update(repositories)
      .set({ activeMergeLeaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(repositories.id, repositoryId));
    const ok = await finalize(task.id, 'merge', { confirmCheckpoint: true });
    expect(ok.status).toBe(200);
    expect(ok.body.workspace.status).toBe('merged');
    expect(await lockRow()).toEqual({ operationId: null, owner: null, leaseExpiresAt: null });
  });

  it('recovers a lock taken before leases existed, then proceeds', { timeout: T }, async () => {
    const task = await workedTask('Stale lock recovery', (ws) => {
      fs.writeFileSync(path.join(ws, 'e.txt'), 'e\n');
    });
    await approve(task.id);
    const ws = await workspaceOf(task.id);
    await plantLock(ws!.id, 'crashed-instance', null);

    const res = await finalize(task.id, 'merge', { confirmCheckpoint: true });
    expect(res.status).toBe(200);
    expect(res.body.workspace.status).toBe('merged');
  });

  it('renews the lease through a slow merge and refuses a concurrent one', { timeout: T }, async () => {
    const slow = await workedTask('Slow merge', (ws) => {
      fs.writeFileSync(path.join(ws, 'slow.txt'), 'slow\n');
    });
    const waiting = await workedTask('Waiting merge', (ws) => {
      fs.writeFileSync(path.join(ws, 'waiting.txt'), 'waiting\n');
    });
    await approve(slow.id);
    await approve(waiting.id);

    const hook = path.join(repoDir, '.git', 'hooks', 'post-merge');
    fs.writeFileSync(hook, '#!/bin/sh\nsleep 4\n', { mode: 0o755 });
    // Wide enough that event-loop delays on a loaded machine cannot let the lease lapse between renewals.
    setMergeLockTtlForTests(1_500);
    try {
      let settled: request.Response | null = null;
      const merging = finalize(slow.id, 'merge', { confirmCheckpoint: true }).then((res) => (settled = res));
      let first = await lockRow();
      for (let i = 0; i < 400 && !first.operationId && !settled; i += 1) {
        await new Promise((r) => setTimeout(r, 25));
        first = await lockRow();
      }
      expect(settled, JSON.stringify((settled as request.Response | null)?.body)).toBeNull();
      expect(first.operationId).not.toBeNull();

      // Well past one lease length, the lock is still live because it was renewed.
      await new Promise((r) => setTimeout(r, 2_500));
      const later = await lockRow();
      expect(later.operationId).toBe(first.operationId);
      expect(later.leaseExpiresAt!.getTime()).toBeGreaterThan(first.leaseExpiresAt!.getTime());
      const { rows } = await pool.query<{ now: Date }>('SELECT clock_timestamp() AS now');
      expect(later.leaseExpiresAt!.getTime()).toBeGreaterThan(rows[0]!.now.getTime());

      const refused = await finalize(waiting.id, 'merge', { confirmCheckpoint: true });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('merge_in_progress');

      const merged = await merging;
      expect(merged.status).toBe(200);
      expect(await lockRow()).toEqual({ operationId: null, owner: null, leaseExpiresAt: null });
    } finally {
      setMergeLockTtlForTests(null);
      fs.rmSync(hook, { force: true });
    }
  });
});

describe('keep branch and abandon', () => {
  it('keep-branch retains the branch, removes the worktree, and completes the task', { timeout: T }, async () => {
    const task = await workedTask('Keep this branch', (ws) => {
      fs.writeFileSync(path.join(ws, 'kept.txt'), 'kept\n');
    });
    await approve(task.id);
    expect(await beforeRefsOf(task.id)).not.toHaveLength(0);

    const res = await finalize(task.id, 'keep-branch', { confirmCheckpoint: true });
    expect(res.status).toBe(200);
    expect(res.body.workspace.status).toBe('retained');
    expect(res.body.taskStatus).toBe('done');
    expect(fs.existsSync(res.body.workspace.worktreePath)).toBe(false);
    const branches = await git(repoDir, 'branch', '--list', res.body.workspace.branchName);
    expect(branches).toContain(res.body.workspace.branchName);
    // Retained work is not on the base branch.
    expect(fs.existsSync(path.join(repoDir, 'kept.txt'))).toBe(false);
    expect(await beforeRefsOf(task.id)).toEqual([]);
  });

  it('abandon requires confirmation for dirty work, then cancels the task', { timeout: T }, async () => {
    const task = await workedTask('Abandon me', (ws) => {
      fs.writeFileSync(path.join(ws, 'doomed.txt'), 'doomed\n');
    });

    const refused = await request(app)
      .post(`/api/tasks/${task.id}/workspace/abandon`)
      .set(auth())
      .send({});
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('discard_confirmation_required');
    expect(await beforeRefsOf(task.id)).not.toHaveLength(0);

    const res = await request(app)
      .post(`/api/tasks/${task.id}/workspace/abandon`)
      .set(auth())
      .send({ confirmDiscard: true });
    expect(res.status).toBe(200);
    expect(res.body.workspace.status).toBe('abandoned');
    expect(res.body.taskStatus).toBe('cancelled');
    expect(fs.existsSync(res.body.workspace.worktreePath)).toBe(false);
    expect(await taskStatus(task.id)).toBe('cancelled');
    expect(await beforeRefsOf(task.id)).toEqual([]);
  });
});
