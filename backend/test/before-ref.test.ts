import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import { runs } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { runBeforeRef } from '../src/modules/code-workspaces/branch-name';
import { localGitDriver } from '../src/modules/code-workspaces/local-git-driver';
import { getTaskWorkspace, snapshotBeforeRun } from '../src/modules/code-workspaces/workspace.service';
import { GitDriverError } from '../src/modules/code-workspaces/workspace.types';
import { armCrashPointForTests } from '../src/modules/ownership/crash-points';
import { FencedError, fenceRejectionsForTests } from '../src/modules/ownership/fence';
import { admitRun } from '../src/modules/runs/runs.service';
import { setTaskHostFactoryForTests } from '../src/modules/runs/task-run';
import { drainRunsForTests, requestWake } from '../src/modules/runs/wake';
import { git, initFixtureRepo, makeSandbox, removeSandbox } from './fixtures/git-repo';
import { scriptedHost, type ScriptedTurn } from './support/scripted-host';

const app = createApp();
const T = 30_000;
let sandbox = '';
let seq = 0;

function write(root: string, rel: string, content: string): void {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

/** Read-only observation: no optional locks, so status does not refresh the index it is checking. */
async function observeGit(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await promisify(execFile)('git', args, {
    cwd,
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return stdout.trim();
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** A repository with a tracked file under an ignored directory, and a task worktree on it. */
async function makeWorktree(): Promise<{ repo: string; worktree: string }> {
  seq += 1;
  const repo = await initFixtureRepo(path.join(sandbox, `repo-${seq}`), {
    'README.md': '# fixture\n',
    'src/app.ts': 'export const app = 1;\n',
    'old.txt': 'remove me\n',
    '.gitignore': 'dist/\n',
  });
  write(repo, 'dist/keep.txt', 'tracked despite the ignore rule\n');
  await git(repo, 'add', '-f', 'dist/keep.txt');
  await git(repo, 'commit', '-m', 'track an ignored path');
  const prepared = await localGitDriver.prepareWorkspace({
    repositoryRoot: repo,
    worktreesRoot: `${repo}-worktrees`,
    leaf: 'task/integration',
    branchName: `loxo/t${seq}/integration`,
    baseRef: 'main',
  });
  expect(prepared.state).toBe('ready');
  return { repo, worktree: prepared.worktreePath };
}

async function exists(cwd: string, spec: string): Promise<boolean> {
  return git(cwd, 'cat-file', '-e', spec).then(
    () => true,
    () => false
  );
}

function scratchIndexDirs(): string[] {
  return fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('loxo-index-'));
}

beforeAll(() => {
  sandbox = makeSandbox('before-ref');
});

afterAll(() => {
  removeSandbox(sandbox);
});

describe('pinning a worktree before a run', () => {
  it('captures edits, deletions, and untracked files without touching either checkout', { timeout: T }, async () => {
    const { repo, worktree } = await makeWorktree();
    write(worktree, 'README.md', '# edited, not staged\n');
    write(worktree, 'src/app.ts', 'export const app = 2;\n');
    await git(worktree, 'add', 'src/app.ts');
    write(worktree, 'src/app.ts', 'export const app = 3;\n');
    fs.rmSync(path.join(worktree, 'old.txt'));
    write(worktree, 'notes/new.md', 'untracked\n');
    write(worktree, 'dist/build.js', 'ignored\n');
    write(worktree, 'dist/keep.txt', 'tracked and edited\n');

    const indexFile = path.resolve(worktree, await git(worktree, 'rev-parse', '--git-path', 'index'));
    const observe = async () => ({
      index: sha256(indexFile),
      staged: await observeGit(worktree, 'diff', '--cached', '--name-only'),
      status: await observeGit(worktree, 'status', '--porcelain=v1', '--untracked-files=all'),
      head: await observeGit(worktree, 'rev-parse', 'HEAD'),
      primaryStatus: await observeGit(repo, 'status', '--porcelain=v1', '--untracked-files=all'),
      primaryHead: await observeGit(repo, 'rev-parse', 'HEAD'),
      stashes: await observeGit(repo, 'stash', 'list'),
    });
    const before = await observe();
    const scratchBefore = scratchIndexDirs();

    const ref = runBeforeRef(crypto.randomUUID());
    const pinned = await localGitDriver.writeBeforeRef({ worktreePath: worktree, ref, message: 'test pin' });

    expect(await git(repo, 'rev-parse', ref)).toBe(pinned.commit);
    expect(await git(repo, 'rev-parse', `${ref}^`)).toBe(before.head);
    expect(pinned.head).toBe(before.head);
    expect(await git(repo, 'rev-parse', `${ref}^{tree}`)).toBe(pinned.tree);
    expect(await git(repo, 'show', `${ref}:README.md`)).toBe('# edited, not staged');
    expect(await git(repo, 'show', `${ref}:src/app.ts`)).toBe('export const app = 3;');
    expect(await git(repo, 'show', `${ref}:notes/new.md`)).toBe('untracked');
    expect(await git(repo, 'show', `${ref}:dist/keep.txt`)).toBe('tracked and edited');
    expect(await exists(repo, `${ref}:old.txt`)).toBe(false);
    expect(await exists(repo, `${ref}:dist/build.js`)).toBe(false);

    expect(await observe()).toEqual(before);
    expect(before.staged).toBe('src/app.ts');
    expect(scratchIndexDirs()).toEqual(scratchBefore);
  });

  it('hashes equal content to the same tree and any non-ignored change to a new one', { timeout: T }, async () => {
    const { worktree } = await makeWorktree();
    const first = await localGitDriver.snapshotTree(worktree);
    expect((await localGitDriver.snapshotTree(worktree)).tree).toBe(first.tree);
    expect(first.tree).toBe(await git(worktree, 'rev-parse', 'HEAD^{tree}'));

    write(worktree, 'dist/output.js', 'ignored build output\n');
    expect((await localGitDriver.snapshotTree(worktree)).tree).toBe(first.tree);

    write(worktree, 'scratch.md', 'new\n');
    const changed = await localGitDriver.snapshotTree(worktree);
    expect(changed.tree).not.toBe(first.tree);
    expect(changed.head).toBe(first.head);

    fs.rmSync(path.join(worktree, 'scratch.md'));
    expect((await localGitDriver.snapshotTree(worktree)).tree).toBe(first.tree);
  });

  it('starts from HEAD when the worktree has no index, keeping tracked ignored files', { timeout: T }, async () => {
    const { worktree } = await makeWorktree();
    fs.rmSync(path.resolve(worktree, await git(worktree, 'rev-parse', '--git-path', 'index')));
    const state = await localGitDriver.snapshotTree(worktree);
    expect(state.tree).toBe(await git(worktree, 'rev-parse', 'HEAD^{tree}'));
  });

  it('writes and deletes only refs under refs/loxo/', { timeout: T }, async () => {
    const { repo, worktree } = await makeWorktree();
    const kept = runBeforeRef(crypto.randomUUID());
    const dropped = runBeforeRef(crypto.randomUUID());
    for (const ref of [kept, dropped]) {
      await localGitDriver.writeBeforeRef({ worktreePath: worktree, ref, message: 'pin' });
    }

    await localGitDriver.deleteManagedRefs(repo, [dropped, runBeforeRef(crypto.randomUUID())]);
    expect(await git(repo, 'for-each-ref', '--format=%(refname)', 'refs/loxo/')).toBe(kept);

    const codeOf = (promise: Promise<unknown>) =>
      promise.then(
        () => undefined,
        (err: unknown) => (err instanceof GitDriverError ? err.code : 'other')
      );
    expect(await codeOf(localGitDriver.deleteManagedRefs(repo, ['refs/heads/main']))).toBe('invalid_ref');
    expect(
      await codeOf(localGitDriver.writeBeforeRef({ worktreePath: worktree, ref: 'refs/heads/main', message: 'x' }))
    ).toBe('invalid_ref');
    expect(await git(repo, 'rev-parse', '--verify', 'refs/heads/main')).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('runs record their before-state', () => {
  let token = '';
  let userId = '';
  let repoDir = '';
  let repositoryId = '';
  let behavior: (turn: ScriptedTurn) => Promise<string> = async () => 'done';
  const auth = () => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    await pool.query('TRUNCATE TABLE users CASCADE');
    setTaskHostFactoryForTests(scriptedHost(async (turn) => ({ text: await behavior(turn) })));
    const reg = await request(app)
      .post('/auth/register')
      .send({ email: 'before-ref@example.com', username: 'beforeref', password: 'a-strong-password' });
    token = reg.body.token;
    userId = reg.body.user.id;
    repoDir = await initFixtureRepo(path.join(sandbox, 'run-repo'), { 'README.md': '# ledger\n' });
    const created = await request(app).post('/api/repositories').set(auth()).send({ rootPath: repoDir });
    repositoryId = created.body.repository.id;
  });

  afterAll(() => {
    setTaskHostFactoryForTests(null);
  });

  async function codeTask(name: string) {
    const agent = await request(app).post('/api/agents').set(auth()).send({ name, runtime: 'claude-code' });
    const agentId = agent.body.agent.id as string;
    const task = await request(app)
      .post('/api/tasks')
      .set(auth())
      .send({ title: `${name} task`, repositoryId, leadAgentId: agentId });
    return { agentId, taskId: task.body.task.id as string };
  }

  async function runOnce(agentId: string, taskId: string, act: (turn: ScriptedTurn, runId: string) => Promise<string>) {
    behavior = async (turn) => {
      const [run] = await db
        .select({ id: runs.id })
        .from(runs)
        .where(sql`${runs.taskId} = ${taskId} AND ${runs.status} = 'running'`);
      return act(turn, run!.id);
    };
    await requestWake(userId, { agentId, taskId, trigger: 'manual' });
    await drainRunsForTests();
    const [run] = await db
      .select()
      .from(runs)
      .where(eq(runs.taskId, taskId))
      .orderBy(sql`${runs.createdAt} DESC`)
      .limit(1);
    return run!;
  }

  it('pins the worktree as the agent will find it, before the agent starts', { timeout: T }, async () => {
    const { agentId, taskId } = await codeTask('Pinned Worker');
    const first = await runOnce(agentId, taskId, async (turn) => {
      fs.writeFileSync(path.join(turn.workspace, 'draft.md'), 'first draft\n');
      return 'Drafted.';
    });

    let recordedAtStart: string | null = null;
    const second = await runOnce(agentId, taskId, async (turn, runId) => {
      const [row] = await db.select({ tree: runs.beforeTree }).from(runs).where(eq(runs.id, runId));
      recordedAtStart = row!.tree;
      fs.writeFileSync(path.join(turn.workspace, 'second.md'), 'second\n');
      return 'Added a second file.';
    });

    expect(first.status).toBe('succeeded');
    expect(second.status).toBe('succeeded');
    const workspace = (await getTaskWorkspace(userId, taskId))!;
    const head = await git(workspace.worktreePath, 'rev-parse', 'HEAD');
    const secondRef = runBeforeRef(second.id);
    expect(second).toMatchObject({ beforeHead: head, beforeTree: await git(repoDir, 'rev-parse', `${secondRef}^{tree}`) });
    expect(recordedAtStart).toBe(second.beforeTree);
    expect(await git(repoDir, 'show', `${secondRef}:draft.md`)).toBe('first draft');
    expect(await exists(repoDir, `${secondRef}:second.md`)).toBe(false);
    expect(await exists(repoDir, `${runBeforeRef(first.id)}:draft.md`)).toBe(false);
    // The snapshot staged nothing: both files are still untracked, and the primary checkout is clean.
    expect(await git(workspace.worktreePath, 'status', '--porcelain=v1')).toBe('?? draft.md\n?? second.md'.trim());
    expect(await git(repoDir, 'status', '--porcelain=v1')).toBe('');
  });

  it('refuses the record from an owner that lost the run, leaving only the ref', { timeout: T }, async () => {
    const { agentId, taskId } = await codeTask('Stale Pinner');
    await runOnce(agentId, taskId, async () => 'Prepared the workspace.');
    const workspace = (await getTaskWorkspace(userId, taskId))!;
    const [queued] = await db
      .insert(runs)
      .values({ userId, agentId, agentName: 'Stale Pinner', taskId, trigger: 'manual' })
      .returning();
    const admission = await admitRun(queued!.id, { instance: 'old-owner' });
    await db
      .update(runs)
      .set({ ownerInstance: 'new-owner', ownerEpoch: sql`${runs.ownerEpoch} + 1` })
      .where(eq(runs.id, queued!.id));

    const rejections = fenceRejectionsForTests();
    const owner = { runId: queued!.id, epoch: admission!.run.ownerEpoch, instance: 'old-owner' };
    await expect(snapshotBeforeRun(owner, workspace)).rejects.toBeInstanceOf(FencedError);

    expect(fenceRejectionsForTests()).toBe(rejections + 1);
    const [row] = await db.select().from(runs).where(eq(runs.id, queued!.id));
    expect(row).toMatchObject({ beforeHead: null, beforeTree: null, ownerInstance: 'new-owner' });
    expect(await exists(repoDir, runBeforeRef(queued!.id))).toBe(true);
    await db.update(runs).set({ status: 'failed', leaseExpiresAt: null }).where(eq(runs.id, queued!.id));
  });

  it('leaves the before-state unrecorded when the owner dies after writing the ref', { timeout: T }, async () => {
    const { agentId, taskId } = await codeTask('Crashing Pinner');
    let agentStarted = false;
    const disarm = armCrashPointForTests('run.after_before_ref');
    try {
      const run = await runOnce(agentId, taskId, async () => {
        agentStarted = true;
        return 'unreachable';
      });
      expect(agentStarted).toBe(false);
      expect(run).toMatchObject({ status: 'failed', beforeHead: null, beforeTree: null });
      expect(await exists(repoDir, runBeforeRef(run.id))).toBe(true);
    } finally {
      disarm();
    }
  });
});
