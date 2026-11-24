import fs from 'node:fs';
import path from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import { integrations, plans, platformOps, tasks, workPackages, workspaces, type Run, type Workspace } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { packageBranchName, workspaceBranchName } from '../src/modules/code-workspaces/branch-name';
import { localGitDriver } from '../src/modules/code-workspaces/local-git-driver';
import { drainRunsForTests, startQueuedRuns } from '../src/modules/runs/wake';
import { conflictOf, mergedBefore } from '../src/modules/workshop/conflicts';
import { BUILT_IN_PLATFORM_OPS } from '../src/modules/workshop/platform-op-kinds';
import {
  requestPlatformOp,
  setPlatformOpHandlerForTests,
  setPlatformRetryBackoffForTests,
} from '../src/modules/workshop/platform-ops';
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

const readApp = (worktree: Workspace) => fs.readFileSync(path.join(worktree.worktreePath, 'app.txt'), 'utf8');
const writeApp = (worktree: Workspace, content: string) => fs.writeFileSync(path.join(worktree.worktreePath, 'app.txt'), content);

async function mergeHead(cwd: string): Promise<string | null> {
  const gitDir = await git(cwd, 'rev-parse', '--absolute-git-dir');
  const file = path.join(gitDir, 'MERGE_HEAD');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null;
}

async function integrationRows(taskId: string) {
  return db
    .select({
      packageKey: integrations.packageKey,
      outcome: integrations.outcome,
      ontoCommit: integrations.ontoCommit,
      packageHead: integrations.packageHead,
      mergeCommit: integrations.mergeCommit,
      conflictFiles: integrations.conflictFiles,
    })
    .from(integrations)
    .where(eq(integrations.taskId, taskId))
    .orderBy(asc(integrations.createdAt));
}

/** api merged into the integration branch, then clash, built from base on the same line, conflicting with it. */
async function conflicted(setup: Awaited<ReturnType<typeof setUp>>) {
  await built(setup, 'api', 'two\n');
  await settled(setup.task.id, setup.integration.id, 'integrate', 'integrate:api', { packageKey: 'api' });
  await git(setup.member.worktreePath, 'checkout', '-q', '--detach', base);
  const clashBranch = await built(setup, 'clash', 'three\n');
  await settled(setup.task.id, setup.integration.id, 'integrate', 'integrate:clash', { packageKey: 'clash' });
  const clash = await pkgRow(setup.task.id, 'clash');
  expect(clash.status).toBe('conflicted');
  return { onto: clash.resolveOnto!, clashHead: clash.headCommit!, clashBranch };
}

/** The branch head is a merge of the package head and the integration head, with the resolution as its content and a clean worktree. */
async function expectResolution(cwd: string, expected: { clashHead: string; onto: string; content: string }) {
  expect(await git(cwd, 'rev-parse', 'HEAD^1', 'HEAD^2')).toBe(`${expected.clashHead}\n${expected.onto}`);
  expect(await git(cwd, 'show', 'HEAD:app.txt')).toBe(expected.content);
  expect(await git(cwd, 'status', '--porcelain')).toBe('');
  expect(await mergeHead(cwd)).toBeNull();
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

  it('integrates a package with a merge commit once, and marks a conflict without touching the integration worktree', { timeout: T }, async () => {
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
    // Redone, a merged package is left alone, and its merge is found again.
    expect(await BUILT_IN_PLATFORM_OPS.integrate!(integrated, ctx)).toEqual(integrated.result);
    expect(await git(setup.integration.worktreePath, 'rev-parse', 'HEAD')).toBe(head);

    // A second package from base that changes the same line conflicts.
    await git(setup.member.worktreePath, 'checkout', '-q', '--detach', base);
    await built(setup, 'clash', 'three\n');
    const clashHead = (await pkgRow(setup.task.id, 'clash')).headCommit!;
    const clash = await settled(setup.task.id, setup.integration.id, 'integrate', 'integrate:clash', { packageKey: 'clash' });
    expect(clash.status).toBe('done');
    expect(await pkgRow(setup.task.id, 'clash')).toMatchObject({ status: 'conflicted', resolveOnto: head });
    expect(await git(setup.integration.worktreePath, 'rev-parse', 'HEAD')).toBe(head);
    expect(await git(setup.integration.worktreePath, 'status', '--porcelain')).toBe('');
    expect(await mergeHead(setup.integration.worktreePath)).toBeNull();

    expect(await integrationRows(setup.task.id)).toEqual([
      { packageKey: 'api', outcome: 'merged', ontoCommit: base, packageHead: apiHead, mergeCommit: head, conflictFiles: [] },
      { packageKey: 'clash', outcome: 'conflicted', ontoCommit: head, packageHead: clashHead, mergeCommit: null, conflictFiles: ['app.txt'] },
    ]);
  });

  it('resolves a conflict on the package branch with an explicit two-parent merge, then integrates cleanly', { timeout: T }, async () => {
    const setup = await setUp(['api', 'clash']);
    const { onto, clashHead, clashBranch } = await conflicted(setup);
    // The owner's worktree has moved off the package branch since; the operation puts it back.
    await git(setup.member.worktreePath, 'checkout', '-q', '--detach');

    const begun = await settled(setup.task.id, setup.member.id, 'begin_resolve', 'begin:clash', { packageKey: 'clash' });
    expect(begun.status).toBe('done');
    expect(begun.result).toMatchObject({ conflicts: ['app.txt'] });
    expect(await git(setup.member.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(clashBranch);
    expect(await mergeHead(setup.member.worktreePath)).toBe(onto);
    expect(readApp(setup.member)).toMatch(/^<<<<<<< /m);
    expect(await pkgRow(setup.task.id, 'clash')).toMatchObject({ status: 'resolving' });
    expect(await wsRow(setup.member.id)).toMatchObject({ status: 'dirty', currentBranch: clashBranch, headCommit: clashHead });
    // Redone, the merge under way is kept as it is.
    expect(await BUILT_IN_PLATFORM_OPS.begin_resolve!(begun, ctx)).toEqual(begun.result);
    expect(await mergeHead(setup.member.worktreePath)).toBe(onto);

    // Not while markers remain.
    const finishArgs = { packageKey: 'clash', author: 'Ada' };
    await expect(BUILT_IN_PLATFORM_OPS.finish_resolve!({ ...begun, kind: 'finish_resolve', args: finishArgs }, ctx)).rejects.toThrow(
      /Conflict markers remain in app.txt/
    );

    writeApp(setup.member, 'two and three\n');
    const finished = await settled(setup.task.id, setup.member.id, 'finish_resolve', 'finish:clash', finishArgs);
    expect(finished.status).toBe('done');
    const resolved = await git(setup.member.worktreePath, 'rev-parse', 'HEAD');
    await expectResolution(setup.member.worktreePath, { clashHead, onto, content: 'two and three' });
    expect(await git(setup.member.worktreePath, 'log', '-1', '--format=%an <%ae> | %cn <%ce>')).toBe(
      'Ada via Loxo <platform@loxo.local> | Loxo <platform@loxo.local>'
    );
    expect(await pkgRow(setup.task.id, 'clash')).toMatchObject({ status: 'built', headCommit: resolved, resolves: 1 });

    const again = await settled(setup.task.id, setup.integration.id, 'integrate', 'integrate:clash:r1', { packageKey: 'clash' });
    expect(again.status).toBe('done');
    expect(await git(setup.integration.worktreePath, 'rev-parse', 'HEAD^1', 'HEAD^2')).toBe(`${onto}\n${resolved}`);
    expect(await git(setup.integration.worktreePath, 'show', 'HEAD:app.txt')).toBe('two and three');
    expect(await pkgRow(setup.task.id, 'clash')).toMatchObject({ status: 'integrated' });
    expect((await integrationRows(setup.task.id)).map((r) => `${r.packageKey} ${r.outcome}`)).toEqual([
      'api merged',
      'clash conflicted',
      'clash merged',
    ]);
  });

  it('finds the conflict a resolve is for, and only the packages merged before it', { timeout: T }, async () => {
    const setup = await setUp(['api', 'clash', 'later']);
    const { onto } = await conflicted(setup);
    // Another package goes in after the conflict was found.
    await git(setup.member.worktreePath, 'checkout', '-q', '--detach', base);
    const branch = packageBranchName(setup.task.number, 'later');
    await settled(setup.task.id, setup.member.id, 'branch_package', 'branch:later', { packageKey: 'later', branch, startCommit: base });
    fs.writeFileSync(path.join(setup.member.worktreePath, 'later.txt'), 'later\n');
    await settled(setup.task.id, setup.member.id, 'checkpoint', 'checkpoint:later', { packageKey: 'later', author: 'Ada' });
    await settled(setup.task.id, setup.integration.id, 'integrate', 'integrate:later', { packageKey: 'later' });
    expect(await pkgRow(setup.task.id, 'later')).toMatchObject({ status: 'integrated' });

    const conflict = await conflictOf(await pkgRow(setup.task.id, 'clash'));
    expect(conflict).toMatchObject({ files: ['app.txt'], onto });
    expect((await mergedBefore(setup.task.id, conflict!.id)).map((p) => p.key)).toEqual(['api']);
    // A package not resolving onto that head has no conflict to resolve.
    expect(await conflictOf({ ...(await pkgRow(setup.task.id, 'clash')), resolveOnto: base })).toBeNull();
  });

  it('keeps both parents when a discard to the resolve run before-state lost MERGE_HEAD', { timeout: T }, async () => {
    const setup = await setUp(['api', 'clash']);
    const { onto, clashHead } = await conflicted(setup);
    await settled(setup.task.id, setup.member.id, 'begin_resolve', 'begin:clash', { packageKey: 'clash' });
    const cwd = setup.member.worktreePath;

    // A discard puts the worktree back to the resolve run's before-state: the markers, without MERGE_HEAD.
    const before = await localGitDriver.writeBeforeRef({ worktreePath: cwd, ref: `refs/loxo/tests/${setup.task.id}/before`, message: 'before' });
    writeApp(setup.member, 'half done\n');
    await localGitDriver.restoreTree({ worktreePath: cwd, head: before.head, tree: before.tree });
    expect(await mergeHead(cwd)).toBeNull();
    expect(readApp(setup.member)).toMatch(/^<<<<<<< /m);
    writeApp(setup.member, 'two and three\n');

    const finished = await settled(setup.task.id, setup.member.id, 'finish_resolve', 'finish:clash', { packageKey: 'clash', author: 'Ada' });
    expect(finished.status).toBe('done');
    await expectResolution(cwd, { clashHead, onto, content: 'two and three' });
  });

  it('keeps the owner resolution when the first attempt to commit it dies mid-merge', { timeout: T }, async () => {
    const setup = await setUp(['api', 'clash']);
    const { onto, clashHead } = await conflicted(setup);
    await settled(setup.task.id, setup.member.id, 'begin_resolve', 'begin:clash', { packageKey: 'clash' });
    const cwd = setup.member.worktreePath;
    writeApp(setup.member, 'two and three\n');
    expect(await mergeHead(cwd)).toBe(onto);

    // The first attempt dies; the retry clears what it left, but must not abort the merge the owner resolved.
    let attempts = 0;
    setPlatformOpHandlerForTests('finish_resolve', async (op, c) => {
      attempts += 1;
      if (attempts === 1) throw new Error('killed');
      return BUILT_IN_PLATFORM_OPS.finish_resolve!(op, c);
    });
    try {
      const finished = await settled(setup.task.id, setup.member.id, 'finish_resolve', 'finish:clash', { packageKey: 'clash', author: 'Ada' });
      expect(finished.status).toBe('done');
    } finally {
      setPlatformOpHandlerForTests('finish_resolve', null);
    }
    expect(attempts).toBe(2);
    await expectResolution(cwd, { clashHead, onto, content: 'two and three' });
  });

  it('finishes a resolution whose commit landed before the run died, clearing what the merge left', { timeout: T }, async () => {
    const setup = await setUp(['api', 'clash']);
    const { onto, clashHead, clashBranch } = await conflicted(setup);
    const begun = await settled(setup.task.id, setup.member.id, 'begin_resolve', 'begin:clash', { packageKey: 'clash' });
    const cwd = setup.member.worktreePath;
    writeApp(setup.member, 'two and three\n');
    // The branch moved to the merge, but the run died before clearing the merge state.
    await git(cwd, 'add', '-A');
    const tree = await git(cwd, 'write-tree');
    const commit = await git(cwd, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit-tree', tree, '-p', clashHead, '-p', onto, '-m', 'resolved');
    await git(cwd, 'update-ref', `refs/heads/${clashBranch}`, commit, clashHead);
    expect(await mergeHead(cwd)).toBe(onto);

    const result = await BUILT_IN_PLATFORM_OPS.finish_resolve!({ ...begun, kind: 'finish_resolve', args: { packageKey: 'clash' } }, ctx);
    expect(result).toMatchObject({ package: { status: 'built', headCommit: commit, resolves: 1 } });
    expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(commit);
    expect(await mergeHead(cwd)).toBeNull();
    expect(await git(cwd, 'status', '--porcelain')).toBe('');
  });
});
