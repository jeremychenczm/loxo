import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import { humanRequests, platformOps, runs, tasks, workspaces, type Run, type Workspace } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { localGitDriver } from '../src/modules/code-workspaces/local-git-driver';
import { admitRun } from '../src/modules/runs/runs.service';
import { drainRunsForTests, promoteQueuedRun, startQueuedRuns } from '../src/modules/runs/wake';
import { BUILT_IN_PLATFORM_OPS } from '../src/modules/workshop/platform-op-kinds';
import {
  PLATFORM_IDENTITY,
  queuePlatformRun,
  requestPlatformOp,
  setPlatformOpHandlerForTests,
  setPlatformRetryBackoffForTests,
  workshopGitReady,
} from '../src/modules/workshop/platform-ops';
import { git, initFixtureRepo, makeSandbox, removeSandbox } from './fixtures/git-repo';

/**
 * The built-in platform operations against a real repository: each starts
 * from what Git shows, so redoing it after a crash is safe, and what it saw
 * lands on the worktree row when its run settles.
 */
const app = createApp();
const T = 60_000;
let token = '';
let userId = '';
let repositoryId = '';
let repoDir = '';
let sandbox = '';
let base = '';
let counter = 0;

const auth = () => ({ Authorization: `Bearer ${token}` });

async function newTask(): Promise<string> {
  const res = await request(app)
    .post('/api/tasks')
    .set(auth())
    .send({ title: `Ops ${++counter}`, playbook: 'build', repositoryId });
  return res.body.task.id;
}

/** A worktree row as the engine creates it before the worktree exists. */
async function worktreeRow(taskId: string, branch: string | null, status: Workspace['status'] = 'preparing'): Promise<Workspace> {
  const [row] = await db
    .insert(workspaces)
    .values({
      userId,
      taskId,
      repositoryId,
      kind: branch ? 'member' : 'review',
      worktreePath: path.join(sandbox, 'worktrees', `wt-${++counter}`),
      branchName: branch,
      currentBranch: branch,
      baseRef: 'main',
      baseCommit: base,
      status,
    })
    .returning();
  return row!;
}

async function runOp(taskId: string, workspaceId: string | null, kind: string, opKey: string, args: Record<string, unknown> = {}) {
  const { op, run } = await db.transaction((tx) =>
    requestPlatformOp(tx, { userId, taskId, opKey, kind, args, workspaceId })
  );
  return { op, run: run! };
}

const ws = async (id: string) => (await db.select().from(workspaces).where(eq(workspaces.id, id)))[0]!;
const opRow = async (id: string) => (await db.select().from(platformOps).where(eq(platformOps.id, id)))[0]!;

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  setPlatformRetryBackoffForTests(0);
  const reg = await request(app).post('/auth/register').send({
    email: 'op-kinds@example.com',
    username: 'opkinds',
    password: 'a-strong-password',
  });
  token = reg.body.token;
  userId = reg.body.user.id;
  sandbox = makeSandbox('op-kinds');
  repoDir = await initFixtureRepo(path.join(sandbox, 'repo'), { 'README.md': '# ops\n', 'app.txt': 'one\n' });
  base = await git(repoDir, 'rev-parse', 'HEAD');
  const repo = await request(app).post('/api/repositories').set(auth()).send({ rootPath: repoDir });
  repositoryId = repo.body.repository.id;
});

afterEach(async () => {
  await drainRunsForTests();
});

afterAll(() => {
  setPlatformRetryBackoffForTests(null);
  setPlatformOpHandlerForTests('always_fails', null);
  removeSandbox(sandbox);
});

describe('git driver additions', () => {
  it('commits under the given identity, not the repository config, and skips empty commits', { timeout: T }, async () => {
    const dir = path.join(sandbox, 'identity');
    await initFixtureRepo(dir);
    fs.writeFileSync(path.join(dir, 'new.txt'), 'x\n');
    const made = await localGitDriver.commitAs({
      worktreePath: dir,
      message: 'checkpoint',
      author: { name: 'Explorer A via Loxo', email: 'agent@loxo.local' },
      committer: PLATFORM_IDENTITY,
    });
    expect(made.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await git(dir, 'log', '-1', '--format=%an <%ae> | %cn <%ce>')).toBe(
      'Explorer A via Loxo <agent@loxo.local> | Loxo <platform@loxo.local>'
    );
    expect((await localGitDriver.commitAs({ worktreePath: dir, message: 'again', author: PLATFORM_IDENTITY })).commit).toBeNull();
  });

  it('clears a stale index lock and an unfinished merge, keeping the merge when asked', { timeout: T }, async () => {
    const dir = path.join(sandbox, 'interrupted');
    await initFixtureRepo(dir, { 'a.txt': 'base\n' });
    await git(dir, 'checkout', '-q', '-b', 'side');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'side\n');
    await git(dir, 'commit', '-qam', 'side');
    await git(dir, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'main\n');
    await git(dir, 'commit', '-qam', 'main');
    await git(dir, 'merge', 'side').catch(() => {});
    const gitDir = path.join(dir, '.git');
    expect(fs.existsSync(path.join(gitDir, 'MERGE_HEAD'))).toBe(true);

    fs.writeFileSync(path.join(gitDir, 'index.lock'), '');
    expect(await localGitDriver.clearInterruptedState(dir, { keepMerge: true })).toEqual({ removedLock: true, abortedMerge: false });
    expect(fs.existsSync(path.join(gitDir, 'MERGE_HEAD'))).toBe(true);
    expect(await localGitDriver.clearInterruptedState(dir)).toEqual({ removedLock: false, abortedMerge: true });
    expect(fs.existsSync(path.join(gitDir, 'MERGE_HEAD'))).toBe(false);
  });

  it('reads a git version new enough for workshops', async () => {
    const version = await localGitDriver.gitVersion();
    expect(version).not.toBeNull();
    expect(await workshopGitReady()).toBe(true);
  });
});

describe('built-in operations', () => {
  it('prepares a detached worktree at its base and records it when the run settles', { timeout: T }, async () => {
    const taskId = await newTask();
    const row = await worktreeRow(taskId, null);
    const { op, run } = await runOp(taskId, row.id, 'prepare_worktree', `prepare:${row.id}`);
    await startQueuedRuns([run]);
    await drainRunsForTests();
    expect((await opRow(op.id)).status).toBe('done');
    expect(await ws(row.id)).toMatchObject({ status: 'ready', headCommit: base });
    expect(fs.existsSync(row.worktreePath)).toBe(true);
    expect(await git(row.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
  });

  it('prepares a worktree on a new branch, and preparing it again reuses it', { timeout: T }, async () => {
    const taskId = await newTask();
    const branch = `loxo/t${counter}/p/a`;
    const row = await worktreeRow(taskId, branch);
    const { op } = await runOp(taskId, row.id, 'prepare_worktree', `p:${row.id}`);
    const ctx = { run: {} as Run, lease: { assertHeld() {} } as never, signal: new AbortController().signal };
    const first = await BUILT_IN_PLATFORM_OPS.prepare_worktree!(op, ctx);
    // A crash after the worktree was created but before the run settled: the redo finds it and reuses it.
    const again = await BUILT_IN_PLATFORM_OPS.prepare_worktree!(op, ctx);
    expect(again).toEqual(first);
    expect(await git(row.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branch);
  });

  it('clears a stale index lock before redoing an operation', { timeout: T }, async () => {
    const taskId = await newTask();
    const row = await worktreeRow(taskId, null);
    const prepared = await runOp(taskId, row.id, 'prepare_worktree', `prepare:${row.id}`);
    await startQueuedRuns([prepared.run]);
    await drainRunsForTests();

    // A run pinned a before-state, changed a file, and the reset that followed died holding the index lock.
    const [pinnedBy] = await db
      .insert(runs)
      .values({ userId, agentName: 'pin', taskId, trigger: 'manual', status: 'failed' })
      .returning();
    const pinned = await localGitDriver.writeBeforeRef({
      worktreePath: row.worktreePath,
      ref: `refs/loxo/runs/${pinnedBy!.id}/before`,
      message: 'before',
    });
    await db.update(runs).set({ beforeHead: pinned.head, beforeTree: pinned.tree }).where(eq(runs.id, pinnedBy!.id));
    fs.writeFileSync(path.join(row.worktreePath, 'app.txt'), 'changed\n');
    const gitDir = await git(row.worktreePath, 'rev-parse', '--absolute-git-dir');
    fs.writeFileSync(path.join(gitDir, 'index.lock'), '');

    const { op, run } = await runOp(taskId, row.id, 'reset_to_before', `reset:${row.id}`, { runId: pinnedBy!.id });
    // The first execution is the one that died; this run is its retry.
    await db.update(runs).set({ status: 'failed' }).where(eq(runs.id, run.id));
    const retry = await queuePlatformRun(db, userId, op, { attempt: 2, parentRunId: run.id });
    await startQueuedRuns([retry]);
    await drainRunsForTests();
    expect((await opRow(op.id)).status).toBe('done');
    expect(fs.readFileSync(path.join(row.worktreePath, 'app.txt'), 'utf8')).toBe('one\n');
    expect(fs.existsSync(path.join(gitDir, 'index.lock'))).toBe(false);
  });

  it('lets the recovery operations into a quarantined worktree and releases it when they settle', { timeout: T }, async () => {
    const taskId = await newTask();
    const row = await worktreeRow(taskId, null);
    const prepared = await runOp(taskId, row.id, 'prepare_worktree', `prepare:${row.id}`);
    await startQueuedRuns([prepared.run]);
    await drainRunsForTests();
    await db.update(workspaces).set({ status: 'quarantined', lastError: 'lost its owner' }).where(eq(workspaces.id, row.id));

    const other = await runOp(taskId, row.id, 'prepare_worktree', `prepare-again:${row.id}`);
    expect(await admitRun(other.run.id, { instance: 'quarantine-test' })).toBeUndefined();

    const { op, run } = await runOp(taskId, row.id, 'reconcile_worktree', `reconcile:${row.id}`);
    expect(await promoteQueuedRun(run)).toBe(true);
    await drainRunsForTests();
    expect((await opRow(op.id)).status).toBe('done');
    expect(await ws(row.id)).toMatchObject({ status: 'ready', lastError: null });
  });

  it('removes a worktree, and removing it again is a no-op', { timeout: T }, async () => {
    const taskId = await newTask();
    const row = await worktreeRow(taskId, null);
    const prepared = await runOp(taskId, row.id, 'prepare_worktree', `prepare:${row.id}`);
    await startQueuedRuns([prepared.run]);
    await drainRunsForTests();

    const { op, run } = await runOp(taskId, row.id, 'cleanup', `cleanup:${row.id}`);
    await startQueuedRuns([run]);
    await drainRunsForTests();
    expect((await opRow(op.id)).status).toBe('done');
    expect(fs.existsSync(row.worktreePath)).toBe(false);
    const removed = await ws(row.id);
    expect(removed.status).toBe('abandoned');
    expect(removed.abandonedAt).not.toBeNull();

    const redo = await BUILT_IN_PLATFORM_OPS.cleanup!(await opRow(op.id), {
      run: {} as Run,
      lease: { assertHeld() {} } as never,
      signal: new AbortController().signal,
    });
    expect(redo).toMatchObject({ worktree: { status: 'abandoned' } });
  });
});

describe('a failed operation and the person asked about it', () => {
  async function failedOp(): Promise<{ taskId: string; opId: string; requestId: string }> {
    setPlatformOpHandlerForTests('always_fails', async () => {
      throw new Error('cannot read the worktree');
    });
    const taskId = await newTask();
    const { op, run } = await runOp(taskId, null, 'always_fails', `fails:${counter}`);
    await startQueuedRuns([run]);
    await drainRunsForTests();
    const [req] = await db.select().from(humanRequests).where(eq(humanRequests.taskId, taskId));
    return { taskId, opId: op.id, requestId: req!.id };
  }

  it('runs the operation again from its first attempt when the answer is retry', { timeout: T }, async () => {
    const { opId, requestId } = await failedOp();
    setPlatformOpHandlerForTests('always_fails', async () => ({ recovered: true }));
    const res = await request(app).post(`/api/human-requests/${requestId}/answer`).set(auth()).send({ choice: 'retry' });
    expect(res.status).toBe(200);
    await drainRunsForTests();
    expect(await opRow(opId)).toMatchObject({ status: 'done', result: { recovered: true }, attempts: 1 });
  });

  it('cancels the operation and stops the workshop when the answer is stop', { timeout: T }, async () => {
    const { taskId, opId, requestId } = await failedOp();
    await db.update(tasks).set({ phase: 'build' }).where(eq(tasks.id, taskId));
    await request(app).post(`/api/human-requests/${requestId}/answer`).set(auth()).send({ choice: 'stop' });
    expect((await opRow(opId)).status).toBe('cancelled');
    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(task).toMatchObject({ phase: 'stopped', status: 'cancelled' });
  });
});
