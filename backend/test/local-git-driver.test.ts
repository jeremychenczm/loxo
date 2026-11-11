import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isManagedBranch,
  isSafeRefName,
  memberSlug,
  workspaceBranchName,
  workspaceLeaf,
} from '../src/modules/code-workspaces/branch-name';
import { localGitDriver } from '../src/modules/code-workspaces/local-git-driver';
import {
  GitDriverError,
  type PrepareWorkspaceResult,
} from '../src/modules/code-workspaces/workspace.types';

const execFileAsync = promisify(execFile);
const T = 30_000;

let sandbox = '';
let repoSeq = 0;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true });
  return stdout.trim();
}

function write(root: string, rel: string, content: string | Buffer): void {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

async function initRepo(): Promise<string> {
  repoSeq += 1;
  const dir = path.join(sandbox, `repo-${repoSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'config', 'user.email', 'fixture@swarmdev.test');
  await git(dir, 'config', 'user.name', 'SwarmDev Fixture');
  await git(dir, 'config', 'commit.gpgsign', 'false');
  await git(dir, 'config', 'core.autocrlf', 'false');
  write(dir, 'README.md', '# fixture\n');
  write(dir, 'src/app.ts', 'export const app = 1;\n');
  write(dir, '.gitignore', 'dist/\n');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'initial');
  return dir;
}

interface Workspace {
  repo: string;
  worktreesRoot: string;
  branch: string;
  result: PrepareWorkspaceResult;
}

async function makeWorkspace(taskId = 'task-a', branch = 'swarmdev/task-1-abc123'): Promise<Workspace> {
  const repo = await initRepo();
  const worktreesRoot = `${repo}-worktrees`;
  const result = await localGitDriver.prepareWorkspace({
    repositoryRoot: repo,
    worktreesRoot,
    leaf: taskId,
    branchName: branch,
    baseRef: 'main',
  });
  expect(result.state).toBe('ready');
  return { repo, worktreesRoot, branch, result };
}

async function commitAll(cwd: string, message: string): Promise<void> {
  await git(cwd, 'add', '-A');
  await git(cwd, 'commit', '-m', message);
}

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    if (err instanceof GitDriverError) return err.code;
    throw err;
  }
}

beforeAll(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmdev-git-'));
});

afterAll(() => {
  fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5 });
});

describe('ref and branch names', () => {
  it('accepts ordinary branch names', () => {
    expect(isSafeRefName('main')).toBe(true);
    expect(isSafeRefName('feature/login-form')).toBe(true);
    expect(isSafeRefName('swarmdev/task-42-a17c92')).toBe(true);
  });

  it('rejects names Git or a shell could misread', () => {
    for (const bad of ['', '-option', 'a..b', 'a b', 'x~1', 'x^2', 'x:y', 'end.lock', 'a\\b', 'a@{b', 'a?', 'a*', '/lead', 'trail/', '.hidden']) {
      expect(isSafeRefName(bad), bad).toBe(false);
    }
  });

  it('names managed branches and worktree leaves per task and member', () => {
    const member = memberSlug('Ada Lovelace (Reviewer)!', 'a17c92f3-0000-4000-8000-000000000000');
    expect(member).toBe('ada-lovelace-reviewer-a17c92');
    expect(memberSlug('***', 'b0b0b0b0-0000-4000-8000-000000000000')).toBe('b0b0b0');
    expect(workspaceBranchName(42, null)).toBe('loxo/t42/integration');
    expect(workspaceBranchName(42, member)).toBe(`loxo/t42/${member}`);
    expect(workspaceLeaf('task-uuid', 'integration', null)).toBe('task-uuid/integration');
    expect(workspaceLeaf('task-uuid', 'member', member)).toBe(`task-uuid/member-${member}`);
  });

  it('treats only loxo/ branches as managed', () => {
    expect(isManagedBranch('loxo/t1/integration')).toBe(true);
    for (const other of ['main', 'feature/loxo', 'loxo', 'loxo/../main', '-loxo/x']) {
      expect(isManagedBranch(other), other).toBe(false);
    }
  });
});

describe('inspectRepository', () => {
  it('reports repository facts for a clean checkout', { timeout: T }, async () => {
    const repo = await initRepo();
    const info = await localGitDriver.inspectRepository({ rootPath: repo, baseRef: 'main' });
    expect(info.baseCommit).toBe(await git(repo, 'rev-parse', 'main'));
    expect(info.currentBranch).toBe('main');
    expect(info.dirty).toBe(false);
    expect(info.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('flags a dirty primary checkout but still resolves the committed base', { timeout: T }, async () => {
    const repo = await initRepo();
    write(repo, 'README.md', '# changed\n');
    const info = await localGitDriver.inspectRepository({ rootPath: repo, baseRef: 'main' });
    expect(info.dirty).toBe(true);
    expect(info.baseCommit).toBe(await git(repo, 'rev-parse', 'main'));
  });

  it('rejects a directory that is not a Git repository', { timeout: T }, async () => {
    const dir = path.join(sandbox, 'plain-dir');
    fs.mkdirSync(dir, { recursive: true });
    expect(
      await errorCode(localGitDriver.inspectRepository({ rootPath: dir, baseRef: 'main' }))
    ).toBe('not_a_repository');
  });

  it('rejects a missing base ref', { timeout: T }, async () => {
    const repo = await initRepo();
    expect(
      await errorCode(localGitDriver.inspectRepository({ rootPath: repo, baseRef: 'release' }))
    ).toBe('base_ref_not_branch');
  });

  it('rejects a tag as merge target: base must be a local branch', { timeout: T }, async () => {
    const repo = await initRepo();
    await git(repo, 'tag', 'v1');
    expect(
      await errorCode(localGitDriver.inspectRepository({ rootPath: repo, baseRef: 'v1' }))
    ).toBe('base_ref_not_branch');
  });

  it('rejects binding a subdirectory instead of the repository root', { timeout: T }, async () => {
    const repo = await initRepo();
    expect(
      await errorCode(
        localGitDriver.inspectRepository({ rootPath: path.join(repo, 'src'), baseRef: 'main' })
      )
    ).toBe('not_a_repository');
  });
});

describe('prepareWorkspace', () => {
  it('creates an isolated worktree on the task branch', { timeout: T }, async () => {
    const ws = await makeWorkspace();
    expect(ws.result.reused).toBe(false);
    expect(ws.result.headCommit).toBe(ws.result.baseCommit);
    expect(fs.existsSync(path.join(ws.result.worktreePath, 'README.md'))).toBe(true);
    expect(await git(ws.result.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(ws.branch);
  });

  it('reuses a valid existing workspace idempotently', { timeout: T }, async () => {
    const ws = await makeWorkspace();
    const again = await localGitDriver.prepareWorkspace({
      repositoryRoot: ws.repo,
      worktreesRoot: ws.worktreesRoot,
      leaf: 'task-a',
      branchName: ws.branch,
      baseRef: 'main',
      baseCommit: ws.result.baseCommit,
    });
    expect(again.reused).toBe(true);
    expect(again.state).toBe('ready');
    expect(again.worktreePath).toBe(ws.result.worktreePath);
  });

  it('creates from the committed base even when the primary checkout is dirty', { timeout: T }, async () => {
    const repo = await initRepo();
    write(repo, 'README.md', '# uncommitted edit\n');
    const result = await localGitDriver.prepareWorkspace({
      repositoryRoot: repo,
      worktreesRoot: `${repo}-worktrees`,
      leaf: 'task-a',
      branchName: 'swarmdev/task-1-abc123',
      baseRef: 'main',
    });
    expect(result.state).toBe('ready');
    const content = fs.readFileSync(path.join(result.worktreePath, 'README.md'), 'utf8');
    expect(content).toBe('# fixture\n');
  });

  it('keeps concurrent tasks in separate worktrees', { timeout: T }, async () => {
    const ws = await makeWorkspace();
    const second = await localGitDriver.prepareWorkspace({
      repositoryRoot: ws.repo,
      worktreesRoot: ws.worktreesRoot,
      leaf: 'task-b',
      branchName: 'swarmdev/task-2-def456',
      baseRef: 'main',
    });
    expect(second.state).toBe('ready');
    expect(second.worktreePath).not.toBe(ws.result.worktreePath);
    write(ws.result.worktreePath, 'only-in-a.txt', 'a\n');
    expect(fs.existsSync(path.join(second.worktreePath, 'only-in-a.txt'))).toBe(false);
  });

  it('reports an existing branch without a worktree as needing reconciliation', { timeout: T }, async () => {
    const repo = await initRepo();
    await git(repo, 'branch', 'swarmdev/task-9-stray');
    const result = await localGitDriver.prepareWorkspace({
      repositoryRoot: repo,
      worktreesRoot: `${repo}-worktrees`,
      leaf: 'task-9',
      branchName: 'swarmdev/task-9-stray',
      baseRef: 'main',
    });
    expect(result.state).toBe('error');
    expect(result.error).toMatch(/reconciliation/i);
  });

  it('refuses to overwrite an unrelated occupied directory', { timeout: T }, async () => {
    const repo = await initRepo();
    const worktreesRoot = `${repo}-worktrees`;
    write(path.join(worktreesRoot, 'task-a'), 'keep.txt', 'not ours\n');
    const result = await localGitDriver.prepareWorkspace({
      repositoryRoot: repo,
      worktreesRoot,
      leaf: 'task-a',
      branchName: 'swarmdev/task-1-abc123',
      baseRef: 'main',
    });
    expect(result.state).toBe('error');
    expect(result.error).toMatch(/unrelated/i);
    expect(fs.readFileSync(path.join(worktreesRoot, 'task-a', 'keep.txt'), 'utf8')).toBe('not ours\n');
  });

  it('adopts an empty directory left at the worktree path', { timeout: T }, async () => {
    const repo = await initRepo();
    const worktreesRoot = `${repo}-worktrees`;
    fs.mkdirSync(path.join(worktreesRoot, 'task-a'), { recursive: true });
    const result = await localGitDriver.prepareWorkspace({
      repositoryRoot: repo,
      worktreesRoot,
      leaf: 'task-a',
      branchName: 'swarmdev/task-1-abc123',
      baseRef: 'main',
    });
    expect(result.state).toBe('ready');
  });
});

describe('change capture', () => {
  it('reports a clean tree with the stable empty fingerprint', { timeout: T }, async () => {
    const a = await makeWorkspace();
    const b = await makeWorkspace();
    const snapA = await localGitDriver.captureChanges({
      worktreePath: a.result.worktreePath,
      beforeHead: a.result.baseCommit,
      baseCommit: a.result.baseCommit,
    });
    const snapB = await localGitDriver.captureChanges({
      worktreePath: b.result.worktreePath,
      beforeHead: b.result.baseCommit,
      baseCommit: b.result.baseCommit,
    });
    expect(snapA.changedFiles).toBe(0);
    expect(snapA.patch.length).toBe(0);
    expect(snapA.trackedChanges).toBe(false);
    expect(snapA.summary).toEqual({ files: [], untracked: [] });
    expect(snapA.fingerprint).toBe(snapB.fingerprint);

    const before = await localGitDriver.snapshotWorkingTree({ worktreePath: a.result.worktreePath });
    expect(before.head).toBe(a.result.baseCommit);
    expect(before.summary).toEqual({ files: [], untracked: [] });
  });

  it('captures tracked and staged modifications', { timeout: T }, async () => {
    const ws = await makeWorkspace();
    const wt = ws.result.worktreePath;
    write(wt, 'README.md', '# fixture\nmore\n');
    write(wt, 'src/app.ts', 'export const app = 2;\n');
    await git(wt, 'add', 'src/app.ts');

    const snap = await localGitDriver.captureChanges({
      worktreePath: wt,
      beforeHead: ws.result.baseCommit,
      baseCommit: ws.result.baseCommit,
    });
    const paths = snap.summary.files.map((f) => f.path).sort();
    expect(paths).toEqual(['README.md', 'src/app.ts']);
    expect(snap.summary.files.every((f) => f.status === 'modified')).toBe(true);
    expect(snap.additions).toBeGreaterThan(0);
    expect(snap.trackedChanges).toBe(true);
    expect(snap.patch.toString('utf8')).toContain('README.md');
  });

  it('captures commits the agent created after the run started', { timeout: T }, async () => {
    const ws = await makeWorkspace();
    const wt = ws.result.worktreePath;
    write(wt, 'src/feature.ts', 'export const feature = true;\n');
    await commitAll(wt, 'add feature');
    write(wt, 'src/feature.ts', 'export const feature = false;\n');
    await commitAll(wt, 'flip feature');

    const snap = await localGitDriver.captureChanges({
      worktreePath: wt,
      beforeHead: ws.result.baseCommit,
      baseCommit: ws.result.baseCommit,
    });
    expect(snap.afterHead).not.toBe(ws.result.baseCommit);
    expect(snap.summary.files.map((f) => f.path)).toContain('src/feature.ts');
    expect(snap.trackedChanges).toBe(true);
    expect(snap.patch.length).toBeGreaterThan(0);
  });

  it('captures deletions and renames', { timeout: T }, async () => {
    const ws = await makeWorkspace();
    const wt = ws.result.worktreePath;
    await git(wt, 'rm', 'README.md');
    await git(wt, 'mv', 'src/app.ts', 'src/main.ts');

    const snap = await localGitDriver.captureChanges({
      worktreePath: wt,
      beforeHead: ws.result.baseCommit,
      baseCommit: ws.result.baseCommit,
    });
    const byPath = new Map(snap.summary.files.map((f) => [f.path, f.status]));
    expect(byPath.get('README.md')).toBe('deleted');
    expect(byPath.get('src/main.ts')).toBe('renamed');
  });

  it('lists untracked files separately without flagging tracked changes', { timeout: T }, async () => {
    const ws = await makeWorkspace();
    const wt = ws.result.worktreePath;
    write(wt, 'notes 说明.txt', 'unusual name\n');

    const snap = await localGitDriver.captureChanges({
      worktreePath: wt,
      beforeHead: ws.result.baseCommit,
      baseCommit: ws.result.baseCommit,
    });
    expect(snap.summary.untracked).toEqual(['notes 说明.txt']);
    expect(snap.summary.files).toEqual([]);
    expect(snap.trackedChanges).toBe(false);
    expect(snap.changedFiles).toBe(1);
  });

  it('excludes ignored build output from capture and fingerprint', { timeout: T }, async () => {
    const ws = await makeWorkspace();
    const wt = ws.result.worktreePath;
    const clean = await localGitDriver.captureChanges({
      worktreePath: wt,
      beforeHead: ws.result.baseCommit,
      baseCommit: ws.result.baseCommit,
    });
    write(wt, 'dist/bundle.js', 'generated\n');
    const snap = await localGitDriver.captureChanges({
      worktreePath: wt,
      beforeHead: ws.result.baseCommit,
      baseCommit: ws.result.baseCommit,
    });
    expect(snap.summary.untracked).toEqual([]);
    expect(snap.changedFiles).toBe(0);
    expect(snap.fingerprint).toBe(clean.fingerprint);
  });

  it('records binary files without line counts', { timeout: T }, async () => {
    const ws = await makeWorkspace();
    const wt = ws.result.worktreePath;
    write(wt, 'assets/logo.bin', Buffer.from([0, 1, 2, 3, 0, 255]));
    await commitAll(wt, 'add binary');
    write(wt, 'assets/logo.bin', Buffer.from([9, 8, 7, 0, 1]));

    const snap = await localGitDriver.captureChanges({
      worktreePath: wt,
      beforeHead: ws.result.baseCommit,
      baseCommit: ws.result.baseCommit,
    });
    const entry = snap.summary.files.find((f) => f.path === 'assets/logo.bin');
    expect(entry).toBeDefined();
    expect(entry?.additions).toBe(0);
    expect(entry?.deletions).toBe(0);
  });

  it('truncates oversized patches without failing the capture', { timeout: T }, async () => {
    const ws = await makeWorkspace();
    const wt = ws.result.worktreePath;
    write(wt, 'README.md', `# fixture\n${'line\n'.repeat(200)}`);
    const snap = await localGitDriver.captureChanges({
      worktreePath: wt,
      beforeHead: ws.result.baseCommit,
      baseCommit: ws.result.baseCommit,
      limits: { maxPatchBytes: 64, maxSummaryFiles: 500 },
    });
    expect(snap.patchTruncated).toBe(true);
    expect(snap.patch.length).toBeLessThanOrEqual(64);
    expect(snap.changedFiles).toBe(1);
  });

  it('caps the file summary while keeping full totals', { timeout: T }, async () => {
    const ws = await makeWorkspace();
    const wt = ws.result.worktreePath;
    for (let i = 0; i < 5; i += 1) write(wt, `new-${i}.txt`, `${i}\n`);
    const snap = await localGitDriver.captureChanges({
      worktreePath: wt,
      beforeHead: ws.result.baseCommit,
      baseCommit: ws.result.baseCommit,
      limits: { maxPatchBytes: 2 * 1024 * 1024, maxSummaryFiles: 3 },
    });
    expect(snap.summary.truncated).toBe(true);
    expect(snap.summary.files.length + snap.summary.untracked.length).toBeLessThanOrEqual(3);
    expect(snap.changedFiles).toBe(5);
  });

  it('keeps the fingerprint stable across a checkpoint commit', { timeout: T }, async () => {
    const ws = await makeWorkspace();
    const wt = ws.result.worktreePath;
    write(wt, 'src/app.ts', 'export const app = 3;\n');
    write(wt, 'src/new-module.ts', 'export const fresh = true;\n');

    const beforeCheckpoint = await localGitDriver.captureChanges({
      worktreePath: wt,
      beforeHead: ws.result.baseCommit,
      baseCommit: ws.result.baseCommit,
    });
    await commitAll(wt, 'Task #1: checkpoint');
    const afterCheckpoint = await localGitDriver.captureChanges({
      worktreePath: wt,
      beforeHead: ws.result.baseCommit,
      baseCommit: ws.result.baseCommit,
    });
    expect(afterCheckpoint.fingerprint).toBe(beforeCheckpoint.fingerprint);
    expect(afterCheckpoint.afterHead).not.toBe(beforeCheckpoint.afterHead);

    write(wt, 'src/app.ts', 'export const app = 4;\n');
    const drifted = await localGitDriver.captureChanges({
      worktreePath: wt,
      beforeHead: ws.result.baseCommit,
      baseCommit: ws.result.baseCommit,
    });
    expect(drifted.fingerprint).not.toBe(beforeCheckpoint.fingerprint);
  });
});

describe('base drift', () => {
  it('reports base advancement and divergence', { timeout: T }, async () => {
    const ws = await makeWorkspace();
    const initial = await localGitDriver.reportBaseDrift({
      repositoryRoot: ws.repo,
      baseRef: 'main',
      baseCommit: ws.result.baseCommit,
      branchName: ws.branch,
    });
    expect(initial).toEqual({
      baseIsAncestor: true,
      baseAdvancedBy: 0,
      branchAhead: 0,
      branchBehind: 0,
      diverged: false,
    });

    write(ws.repo, 'README.md', '# fixture\nmainline change\n');
    await commitAll(ws.repo, 'advance main');
    write(ws.result.worktreePath, 'src/app.ts', 'export const app = 9;\n');
    await commitAll(ws.result.worktreePath, 'task work');

    const drift = await localGitDriver.reportBaseDrift({
      repositoryRoot: ws.repo,
      baseRef: 'main',
      baseCommit: ws.result.baseCommit,
      branchName: ws.branch,
    });
    expect(drift.baseIsAncestor).toBe(true);
    expect(drift.baseAdvancedBy).toBe(1);
    expect(drift.branchAhead).toBe(1);
    expect(drift.branchBehind).toBe(1);
    expect(drift.diverged).toBe(true);
  });
});

describe('removeWorkspace', () => {
  it('refuses to delete uncommitted work without confirmation', { timeout: T }, async () => {
    const ws = await makeWorkspace();
    write(ws.result.worktreePath, 'wip.txt', 'unsaved\n');
    expect(
      await errorCode(
        localGitDriver.removeWorkspace({
          repositoryRoot: ws.repo,
          worktreePath: ws.result.worktreePath,
        })
      )
    ).toBe('dirty_workspace');
    expect(fs.existsSync(path.join(ws.result.worktreePath, 'wip.txt'))).toBe(true);
  });

  it('force-removes a dirty worktree only when explicitly allowed, keeping the branch', { timeout: T }, async () => {
    const ws = await makeWorkspace();
    write(ws.result.worktreePath, 'wip.txt', 'unsaved\n');
    await localGitDriver.removeWorkspace({
      repositoryRoot: ws.repo,
      worktreePath: ws.result.worktreePath,
      allowDirty: true,
    });
    expect(fs.existsSync(ws.result.worktreePath)).toBe(false);
    expect(await git(ws.repo, 'branch', '--list', ws.branch)).toContain(ws.branch);
  });

  it('removes a clean workspace and is idempotent', { timeout: T }, async () => {
    const ws = await makeWorkspace();
    await localGitDriver.removeWorkspace({
      repositoryRoot: ws.repo,
      worktreePath: ws.result.worktreePath,
    });
    expect(fs.existsSync(ws.result.worktreePath)).toBe(false);
    await localGitDriver.removeWorkspace({
      repositoryRoot: ws.repo,
      worktreePath: ws.result.worktreePath,
    });
  });
});

describe('reconcileWorkspace', () => {
  it('derives ready and dirty from Git facts', { timeout: T }, async () => {
    const ws = await makeWorkspace();
    const clean = await localGitDriver.reconcileWorkspace({
      repositoryRoot: ws.repo,
      worktreePath: ws.result.worktreePath,
      branchName: ws.branch,
      baseCommit: ws.result.baseCommit,
    });
    expect(clean.state).toBe('ready');
    expect(clean.recovered).toBe(false);

    write(ws.result.worktreePath, 'wip.txt', 'unsaved\n');
    const dirty = await localGitDriver.reconcileWorkspace({
      repositoryRoot: ws.repo,
      worktreePath: ws.result.worktreePath,
      branchName: ws.branch,
      baseCommit: ws.result.baseCommit,
    });
    expect(dirty.state).toBe('dirty');
  });

  it('re-attaches a worktree deleted out of band, preserving committed work', { timeout: T }, async () => {
    const ws = await makeWorkspace();
    write(ws.result.worktreePath, 'src/app.ts', 'export const app = 5;\n');
    await commitAll(ws.result.worktreePath, 'committed progress');
    fs.rmSync(ws.result.worktreePath, { recursive: true, force: true, maxRetries: 5 });

    const result = await localGitDriver.reconcileWorkspace({
      repositoryRoot: ws.repo,
      worktreePath: ws.result.worktreePath,
      branchName: ws.branch,
      baseCommit: ws.result.baseCommit,
    });
    expect(result.recovered).toBe(true);
    expect(result.state).toBe('dirty');
    const restored = fs.readFileSync(path.join(ws.result.worktreePath, 'src/app.ts'), 'utf8');
    expect(restored).toBe('export const app = 5;\n');
  });

  it('reports missing when both worktree and branch are gone', { timeout: T }, async () => {
    const ws = await makeWorkspace();
    fs.rmSync(ws.result.worktreePath, { recursive: true, force: true, maxRetries: 5 });
    await git(ws.repo, 'worktree', 'prune');
    await git(ws.repo, 'branch', '-D', ws.branch);

    const result = await localGitDriver.reconcileWorkspace({
      repositoryRoot: ws.repo,
      worktreePath: ws.result.worktreePath,
      branchName: ws.branch,
      baseCommit: ws.result.baseCommit,
    });
    expect(result.state).toBe('missing');
  });

  it('reports an unrelated directory at the worktree path as an error', { timeout: T }, async () => {
    const ws = await makeWorkspace();
    fs.rmSync(ws.result.worktreePath, { recursive: true, force: true, maxRetries: 5 });
    await git(ws.repo, 'worktree', 'prune');
    write(ws.result.worktreePath, 'squatter.txt', 'not ours\n');

    const result = await localGitDriver.reconcileWorkspace({
      repositoryRoot: ws.repo,
      worktreePath: ws.result.worktreePath,
      branchName: ws.branch,
      baseCommit: ws.result.baseCommit,
    });
    expect(result.state).toBe('error');
    expect(result.error).toMatch(/unrelated/i);
  });

  it('reports a wrong checked-out branch as an error', { timeout: T }, async () => {
    const ws = await makeWorkspace();
    fs.rmSync(ws.result.worktreePath, { recursive: true, force: true, maxRetries: 5 });
    await git(ws.repo, 'worktree', 'prune');
    await git(ws.repo, 'worktree', 'add', '-b', 'someone-else', ws.result.worktreePath, 'main');

    const result = await localGitDriver.reconcileWorkspace({
      repositoryRoot: ws.repo,
      worktreePath: ws.result.worktreePath,
      branchName: ws.branch,
      baseCommit: ws.result.baseCommit,
    });
    expect(result.state).toBe('error');
    expect(result.error).toMatch(/checked out/i);
  });

  it('flags a rewritten history that dropped the base commit', { timeout: T }, async () => {
    const ws = await makeWorkspace();
    await git(ws.result.worktreePath, 'commit', '--amend', '--allow-empty', '-m', 'rewritten root');

    const result = await localGitDriver.reconcileWorkspace({
      repositoryRoot: ws.repo,
      worktreePath: ws.result.worktreePath,
      branchName: ws.branch,
      baseCommit: ws.result.baseCommit,
    });
    expect(result.state).toBe('error');
    expect(result.error).toMatch(/base commit/i);
  });
});

/** Everything a user could notice about their primary checkout, read without side effects. */
async function primaryCheckoutState(repo: string) {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files[path.relative(repo, full)] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(repo);
  const quietGit = (...args: string[]) => git(repo, '--no-optional-locks', ...args);
  return {
    head: await quietGit('rev-parse', 'HEAD'),
    branch: await quietGit('symbolic-ref', '--short', 'HEAD'),
    status: await quietGit('status', '--porcelain=v1', '--untracked-files=all'),
    index: crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, '.git', 'index'))).digest('hex'),
    config: fs.readFileSync(path.join(repo, '.git', 'config'), 'utf8'),
    files,
  };
}

async function refList(repo: string): Promise<string[]> {
  const out = await git(repo, 'for-each-ref', '--format=%(refname) %(objectname)');
  return out.split('\n').filter(Boolean).sort();
}

describe('several worktrees on a user repository', () => {
  it('adds and removes task worktrees without touching the primary checkout', { timeout: 60_000 }, async () => {
    const repo = await initRepo();
    // The user is mid-work: an unstaged edit, a staged file, and an untracked one.
    write(repo, 'README.md', '# my unsaved edit\n');
    write(repo, 'staged.txt', 'staged\n');
    await git(repo, 'add', 'staged.txt');
    write(repo, 'scratch.txt', 'untracked\n');

    const before = await primaryCheckoutState(repo);
    const refsBefore = await refList(repo);
    const base = await git(repo, 'rev-parse', 'main');
    const worktreesRoot = `${repo}-loxo`;

    const specs = [
      { leaf: 't7/integration', branchName: 'loxo/t7/integration' },
      { leaf: 't7/member-ada', branchName: 'loxo/t7/ada' },
      { leaf: 't7/member-grace', branchName: 'loxo/t7/grace' },
      { leaf: 't7/review-linus', branchName: null },
    ];
    const prepared = [];
    for (const spec of specs) {
      const result = await localGitDriver.prepareWorkspace({
        repositoryRoot: repo,
        worktreesRoot,
        baseRef: 'main',
        baseCommit: base,
        ...spec,
      });
      expect(result.state, spec.leaf).toBe('ready');
      expect(result.worktreePath).toBe(path.join(worktreesRoot, ...spec.leaf.split('/')));
      prepared.push({ ...spec, path: result.worktreePath });
    }

    // Members work on their own branches; the review checkout sits detached at the base.
    write(prepared[1]!.path, 'api.ts', 'export const api = 1;\n');
    await git(prepared[1]!.path, 'add', '.');
    await git(prepared[1]!.path, 'commit', '-m', 'api package');
    write(prepared[2]!.path, 'ui.ts', 'export const ui = 1;\n');
    expect(await git(prepared[1]!.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('loxo/t7/ada');
    expect(await git(prepared[3]!.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
    expect(await git(prepared[3]!.path, 'rev-parse', 'HEAD')).toBe(base);
    expect(fs.existsSync(path.join(prepared[2]!.path, 'api.ts'))).toBe(false);

    const again = await localGitDriver.prepareWorkspace({
      repositoryRoot: repo,
      worktreesRoot,
      baseRef: 'main',
      baseCommit: base,
      ...specs[3]!,
    });
    expect(again.reused).toBe(true);

    expect(await primaryCheckoutState(repo)).toEqual(before);
    const refsDuring = await refList(repo);
    const added = refsDuring.filter((r) => !refsBefore.includes(r)).map((r) => r.split(' ')[0]);
    expect(added.sort()).toEqual([
      'refs/heads/loxo/t7/ada',
      'refs/heads/loxo/t7/grace',
      'refs/heads/loxo/t7/integration',
    ]);
    expect(refsDuring.filter((r) => !r.startsWith('refs/heads/loxo/'))).toEqual(refsBefore);

    for (const ws of prepared) {
      await localGitDriver.removeWorkspace({
        repositoryRoot: repo,
        worktreePath: ws.path,
        allowDirty: true,
        ...(ws.branchName ? { deleteBranch: ws.branchName } : {}),
      });
      expect(fs.existsSync(ws.path)).toBe(false);
    }

    expect(await primaryCheckoutState(repo)).toEqual(before);
    expect(await refList(repo)).toEqual(refsBefore);
    const listed = await git(repo, 'worktree', 'list', '--porcelain');
    expect(listed.split('\n').filter((l) => l.startsWith('worktree '))).toHaveLength(1);
  });

  it('never deletes a branch outside the managed namespace', { timeout: T }, async () => {
    const ws = await makeWorkspace('task-guard', 'loxo/t8/integration');
    await expect(
      localGitDriver.removeWorkspace({
        repositoryRoot: ws.repo,
        worktreePath: ws.result.worktreePath,
        deleteBranch: 'main',
      })
    ).rejects.toMatchObject({ code: 'unmanaged_branch' });
    expect(await git(ws.repo, 'rev-parse', '--verify', 'refs/heads/main')).toMatch(/^[0-9a-f]{40}$/);
  });
});
