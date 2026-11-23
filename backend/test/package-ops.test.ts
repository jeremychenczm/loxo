import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import { plans, platformOps, tasks, workPackages, workspaces, type Run, type Workspace } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { packageBranchName, workspaceBranchName } from '../src/modules/code-workspaces/branch-name';
import { drainRunsForTests, startQueuedRuns } from '../src/modules/runs/wake';
import { BUILT_IN_PLATFORM_OPS } from '../src/modules/workshop/platform-op-kinds';
import { requestPlatformOp, setPlatformRetryBackoffForTests } from '../src/modules/workshop/platform-ops';
import { git, initFixtureRepo, makeSandbox, removeSandbox } from './fixtures/git-repo';

/**
 * The package operations against a real repository: a package branch made
 * in its owner's worktree, the owner's work checkpointed onto it, and the
 * branch merged into the integration branch. Each is redone safely after a
 * crash, and refuses a state it does not expect.
 */
const app = createApp();
const T = 60_000;
let token = '';
let userId = '';
let repositoryId = '';
let sandbox = '';
let base = '';
let counter = 0;

const auth = () => ({ Authorization: `Bearer ${token}` });
const ctx = { run: {} as Run, lease: { assertHeld() {} } as never, signal: new AbortController().signal };

/** A task with a pinned one-off plan, its integration worktree on the task branch and one member worktree at base. */
async function setUp(keys: string[]) {
  const created = await request(app)
    .post('/api/tasks')
    .set(auth())
    .send({ title: `Packages ${++counter}`, playbook: 'build', repositoryId });
  const [task] = await db.select().from(tasks).where(eq(tasks.id, created.body.task.id));
  const worktree = async (kind: 'integration' | 'member', branch: string | null): Promise<Workspace> => {
    const [row] = await db
      .insert(workspaces)
      .values({
        userId,
        taskId: task!.id,
        repositoryId,
        kind,
        worktreePath: path.join(sandbox, 'worktrees', `${task!.number}-${kind}`),
        branchName: branch,
        currentBranch: branch,
        baseRef: 'main',
        baseCommit: base,
        status: 'preparing',
      })
      .returning();
    const { run } = await op(task!.id, row!.id, 'prepare_worktree', `prepare:${row!.id}`);
    await startQueuedRuns([run]);
    await drainRunsForTests();
    return (await db.select().from(workspaces).where(eq(workspaces.id, row!.id)))[0]!;
  };
  const integration = await worktree('integration', workspaceBranchName(task!.number, null));
  const member = await worktree('member', null);
  const [plan] = await db
    .insert(plans)
    .values({ taskId: task!.id, cycle: 0, version: 1, round: 0, source: 'lead', content: {}, hash: `h${counter}` })
    .returning();
  for (const key of keys) {
    await db.insert(workPackages).values({ taskId: task!.id, planId: plan!.id, key, title: `Package ${key}`, area: key });
  }
  return { task: task!, integration, member };
}

async function op(taskId: string, workspaceId: string, kind: string, opKey: string, args: Record<string, unknown> = {}) {
  const { op: row, run } = await db.transaction((tx) => requestPlatformOp(tx, { userId, taskId, opKey, kind, args, workspaceId }));
  return { op: row, run: run! };
}

async function settled(taskId: string, workspaceId: string, kind: string, opKey: string, args: Record<string, unknown>) {
  const { op: row, run } = await op(taskId, workspaceId, kind, opKey, args);
  await startQueuedRuns([run]);
  await drainRunsForTests();
  return (await db.select().from(platformOps).where(eq(platformOps.id, row.id)))[0]!;
}

const pkgRow = async (taskId: string, key: string) =>
  (await db.select().from(workPackages).where(and(eq(workPackages.taskId, taskId), eq(workPackages.key, key))))[0]!;
const wsRow = async (id: string) => (await db.select().from(workspaces).where(eq(workspaces.id, id)))[0]!;

/** Branches `key` at base in the member worktree, writes `content` to app.txt and checkpoints it. */
async function built(setup: Awaited<ReturnType<typeof setUp>>, key: string, content: string) {
  const branch = packageBranchName(setup.task.number, key);
  await settled(setup.task.id, setup.member.id, 'branch_package', `branch:${key}`, { packageKey: key, branch, startCommit: base });
  fs.writeFileSync(path.join(setup.member.worktreePath, 'app.txt'), content);
  await settled(setup.task.id, setup.member.id, 'checkpoint', `checkpoint:${key}`, { packageKey: key, author: 'Ada' });
  return branch;
}

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  setPlatformRetryBackoffForTests(0);
  const reg = await request(app).post('/auth/register').send({
    email: 'package-ops@example.com',
    username: 'packageops',
    password: 'a-strong-password',
  });
  token = reg.body.token;
  userId = reg.body.user.id;
  sandbox = makeSandbox('package-ops');
  const repoDir = await initFixtureRepo(path.join(sandbox, 'repo'), { 'README.md': '# packages\n', 'app.txt': 'one\n' });
  base = await git(repoDir, 'rev-parse', 'HEAD');
  const repo = await request(app).post('/api/repositories').set(auth()).send({ rootPath: repoDir });
  repositoryId = repo.body.repository.id;
});

afterEach(async () => {
  await drainRunsForTests();
});

afterAll(() => {
  setPlatformRetryBackoffForTests(null);
  removeSandbox(sandbox);
});

describe('package operations', () => {
  it('branches a package at its start in the owner worktree, and a redo finds its own branch', { timeout: T }, async () => {
    const setup = await setUp(['api']);
    const branch = packageBranchName(setup.task.number, 'api');
    const args = { packageKey: 'api', branch, startCommit: base };
    const done = await settled(setup.task.id, setup.member.id, 'branch_package', 'branch:api', args);
    expect(done.status).toBe('done');
    expect(await git(setup.member.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branch);
    expect(await wsRow(setup.member.id)).toMatchObject({ currentBranch: branch, headCommit: base, status: 'ready' });
    expect(await pkgRow(setup.task.id, 'api')).toMatchObject({ status: 'branched', branch, startCommit: base });

    // A crash after the branch was made but before the run settled: the redo finds it.
    expect(await BUILT_IN_PLATFORM_OPS.branch_package!(done, ctx)).toEqual(done.result);
    // A branch that moved on is not this operation's to reuse.
    fs.writeFileSync(path.join(setup.member.worktreePath, 'app.txt'), 'moved\n');
    await git(setup.member.worktreePath, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-qam', 'moved');
    await expect(BUILT_IN_PLATFORM_OPS.branch_package!(done, ctx)).rejects.toThrow(/already points at/);
  });

  it('checkpoints the owner work as the owner via the platform, once, and refuses a worktree off its branch', { timeout: T }, async () => {
    const setup = await setUp(['api']);
    const branch = await built(setup, 'api', 'two\n');
    const head = await git(setup.member.worktreePath, 'rev-parse', 'HEAD');
    expect(head).not.toBe(base);
    expect(await git(setup.member.worktreePath, 'log', '-1', '--format=%an <%ae> | %cn <%ce>')).toBe(
      'Ada via Loxo <platform@loxo.local> | Loxo <platform@loxo.local>'
    );
    expect(await git(setup.member.worktreePath, 'status', '--porcelain')).toBe('');
    expect(await pkgRow(setup.task.id, 'api')).toMatchObject({ status: 'built', headCommit: head, branch });

    const [checkpoint] = await db.select().from(platformOps).where(eq(platformOps.opKey, 'checkpoint:api'));
    // Redone on a clean worktree, it takes the branch as it stands.
    expect(await BUILT_IN_PLATFORM_OPS.checkpoint!(checkpoint!, ctx)).toEqual(checkpoint!.result);
    expect(await git(setup.member.worktreePath, 'rev-parse', 'HEAD')).toBe(head);
    // A build that left the branch is refused.
    await git(setup.member.worktreePath, 'checkout', '-q', '--detach');
    await expect(BUILT_IN_PLATFORM_OPS.checkpoint!(checkpoint!, ctx)).rejects.toThrow(/left the worktree off/);
  });

  it('integrates a package with a merge commit once, and refuses a conflict without leaving a merge behind', { timeout: T }, async () => {
    const setup = await setUp(['api', 'clash']);
    const apiBranch = await built(setup, 'api', 'two\n');
    const apiHead = (await pkgRow(setup.task.id, 'api')).headCommit!;
    const integrated = await settled(setup.task.id, setup.integration.id, 'integrate', 'integrate:api', { packageKey: 'api' });
    expect(integrated.status).toBe('done');
    const head = await git(setup.integration.worktreePath, 'rev-parse', 'HEAD');
    expect(await git(setup.integration.worktreePath, 'rev-parse', 'HEAD^1', 'HEAD^2')).toBe(`${base}\n${apiHead}`);
    expect(await git(setup.integration.worktreePath, 'log', '-1', '--format=%an | %cn | %s')).toBe(
      'Loxo | Loxo | Integrate package api: Package api'
    );
    expect(await wsRow(setup.integration.id)).toMatchObject({ headCommit: head });
    expect(await pkgRow(setup.task.id, 'api')).toMatchObject({ status: 'integrated', branch: apiBranch });
    // Redone, a merged package is left alone.
    expect(await BUILT_IN_PLATFORM_OPS.integrate!(integrated, ctx)).toEqual(integrated.result);
    expect(await git(setup.integration.worktreePath, 'rev-parse', 'HEAD')).toBe(head);

    // A second package from base that changes the same line conflicts.
    await git(setup.member.worktreePath, 'checkout', '-q', '--detach', base);
    await built(setup, 'clash', 'three\n');
    const clash = await settled(setup.task.id, setup.integration.id, 'integrate', 'integrate:clash', { packageKey: 'clash' });
    expect(clash.status).toBe('failed');
    expect(clash.error).toMatch(/conflicts with the integration branch/);
    expect(await git(setup.integration.worktreePath, 'rev-parse', 'HEAD')).toBe(head);
    expect(await git(setup.integration.worktreePath, 'status', '--porcelain')).toBe('');
    const gitDir = await git(setup.integration.worktreePath, 'rev-parse', '--absolute-git-dir');
    expect(fs.existsSync(path.join(gitDir, 'MERGE_HEAD'))).toBe(false);
  });
});
