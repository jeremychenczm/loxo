import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import { repositories } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { registerLiveMergeOperationForTests } from '../src/modules/code-workspaces/workspace.service';
import { recordApproval } from '../src/modules/tasks/approvals.service';
import { setTaskTurnExecutorForTests } from '../src/modules/runs/task-run';
import { drainRunsForTests, requestWake } from '../src/modules/runs/wake';
import type { TurnRequest } from '../src/modules/runner/runner';
import { git, initFixtureRepo, makeSandbox, removeSandbox } from './fixtures/git-repo';

const app = createApp();
const T = 30_000;

let token = '';
let userId = '';
let workerId = '';
let sandbox = '';
let repoDir = '';
let repositoryId = '';

let onTurn: (req: TurnRequest) => void = () => {};

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

function finalize(taskId: string, action: 'merge' | 'keep-branch', body: object = {}) {
  return request(app).post(`/api/tasks/${taskId}/workspace/${action}`).set(auth()).send(body);
}

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  setTaskTurnExecutorForTests(async (req) => {
    onTurn(req);
    return { text: 'stub output', durationMs: 5 };
  });

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
  setTaskTurnExecutorForTests(null);
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
  it('rejects finalization while a live merge holds the lock', { timeout: T }, async () => {
    const task = await workedTask('Lock holder', (ws) => {
      fs.writeFileSync(path.join(ws, 'd.txt'), 'd\n');
    });
    await approve(task.id);

    const liveOp = crypto.randomUUID();
    registerLiveMergeOperationForTests(liveOp);
    const ws = await workspaceOf(task.id);
    await db
      .update(repositories)
      .set({
        activeMergeWorkspaceId: ws!.id,
        activeMergeOperationId: liveOp,
        activeMergePreHead: await git(repoDir, 'rev-parse', 'HEAD'),
        activeMergeStartedAt: new Date(),
      })
      .where(eq(repositories.id, repositoryId));

    const res = await finalize(task.id, 'merge', { confirmCheckpoint: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('merge_in_progress');

    // Cleanup: release the fake lock and finish the task.
    await db
      .update(repositories)
      .set({
        activeMergeWorkspaceId: null,
        activeMergeOperationId: null,
        activeMergePreHead: null,
        activeMergeStartedAt: null,
      })
      .where(eq(repositories.id, repositoryId));
    const ok = await finalize(task.id, 'merge', { confirmCheckpoint: true });
    expect(ok.status).toBe(200);
  });

  it('recovers a stale lock whose merge never started, then proceeds', { timeout: T }, async () => {
    const task = await workedTask('Stale lock recovery', (ws) => {
      fs.writeFileSync(path.join(ws, 'e.txt'), 'e\n');
    });
    await approve(task.id);

    const ws = await workspaceOf(task.id);
    await db
      .update(repositories)
      .set({
        activeMergeWorkspaceId: ws!.id,
        activeMergeOperationId: crypto.randomUUID(), // never registered as live
        activeMergePreHead: await git(repoDir, 'rev-parse', 'HEAD'),
        activeMergeStartedAt: new Date(Date.now() - 60_000),
      })
      .where(eq(repositories.id, repositoryId));

    const res = await finalize(task.id, 'merge', { confirmCheckpoint: true });
    expect(res.status).toBe(200);
    expect(res.body.workspace.status).toBe('merged');
  });
});

describe('keep branch and abandon', () => {
  it('keep-branch retains the branch, removes the worktree, and completes the task', { timeout: T }, async () => {
    const task = await workedTask('Keep this branch', (ws) => {
      fs.writeFileSync(path.join(ws, 'kept.txt'), 'kept\n');
    });
    await approve(task.id);

    const res = await finalize(task.id, 'keep-branch', { confirmCheckpoint: true });
    expect(res.status).toBe(200);
    expect(res.body.workspace.status).toBe('retained');
    expect(res.body.taskStatus).toBe('done');
    expect(fs.existsSync(res.body.workspace.worktreePath)).toBe(false);
    const branches = await git(repoDir, 'branch', '--list', res.body.workspace.branchName);
    expect(branches).toContain(res.body.workspace.branchName);
    // Retained work is not on the base branch.
    expect(fs.existsSync(path.join(repoDir, 'kept.txt'))).toBe(false);
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

    const res = await request(app)
      .post(`/api/tasks/${task.id}/workspace/abandon`)
      .set(auth())
      .send({ confirmDiscard: true });
    expect(res.status).toBe(200);
    expect(res.body.workspace.status).toBe('abandoned');
    expect(res.body.taskStatus).toBe('cancelled');
    expect(fs.existsSync(res.body.workspace.worktreePath)).toBe(false);
    expect(await taskStatus(task.id)).toBe('cancelled');
  });
});
