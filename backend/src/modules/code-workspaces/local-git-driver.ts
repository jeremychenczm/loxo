import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolveInside } from '../../storage/path-safety';
import { assertCommitId, assertManagedBranch, assertManagedRef, assertSafeRefName } from './branch-name';
import { buildChangeSummary, computeChangeFingerprint } from './change-capture';
import {
  parseNameStatusZ,
  parseNulList,
  parseNumstatZ,
  parseStatusZ,
  parseWorktreeList,
} from './git-output';
import {
  DEFAULT_CAPTURE_LIMITS,
  GitDriverError,
  type BaseDriftInput,
  type BaseDriftReport,
  type BeforeRef,
  type BeforeRefInput,
  type CaptureChangesInput,
  type CaptureLimits,
  type CapturedChanges,
  type CheckpointInput,
  type CheckpointResult,
  type CommitAsInput,
  type InterruptedStateCleared,
  type WorkspaceDriver,
  type InspectRepositoryInput,
  type MergeOutcome,
  type MergeWorkspaceInput,
  type PrimaryCheckoutState,
  type PrepareWorkspaceInput,
  type PrepareWorkspaceResult,
  type ReconcileWorkspaceInput,
  type ReconcileWorkspaceResult,
  type RemoveWorkspaceInput,
  type RepositoryInfo,
  type RestoreTreeInput,
  type TreeState,
  type WorkingTreeSnapshot,
  type WorkspaceObservation,
  type GitIdentity,
} from './workspace.types';
import { childEnv } from '../../lib/child-env';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;
/** Patch capture reads full diffs before capping; anything larger fails soft as truncated. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const PLATFORM_IDENTITY = {
  GIT_AUTHOR_NAME: 'Loxo',
  GIT_AUTHOR_EMAIL: 'runs@loxo.invalid',
  GIT_COMMITTER_NAME: 'Loxo',
  GIT_COMMITTER_EMAIL: 'runs@loxo.invalid',
};

type ExecError = NodeJS.ErrnoException & { stderr?: Buffer; stdout?: Buffer };

/** A line that opens or closes a conflict hunk, as git writes them. */
const CONFLICT_MARKER = /^(<{7}|>{7})(?: |\r?$)/m;

/** What merging a package branch came to: the head it was merged onto, the package tip, and the files in conflict. */
export interface PackageMerge {
  result: 'merged' | 'already_merged' | 'conflicted';
  head: string;
  onto: string;
  tip: string;
  /** Null for a conflict, or when the tip was already in without a merge of its own. */
  mergeCommit: string | null;
  conflicts: string[];
}

interface GitOptions {
  env?: Record<string, string>;
  stdin?: string;
}

async function execGit(cwd: string, args: string[], options: GitOptions): Promise<Buffer> {
  const pending = execFileAsync('git', args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
    encoding: 'buffer',
    // No optional locks: read-only commands such as status must not refresh the
    // user's index as a side effect.
    env: childEnv('git', { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...options.env }),
  });
  // Git may exit before reading its input (an early failure, or a command that
  // reads none); the write then fails with EPIPE. The exit status reports the
  // outcome; an unhandled stream error would take the whole process down.
  pending.child.stdin?.on('error', () => {});
  pending.child.stdin?.end(options.stdin ?? '');
  const { stdout } = await pending;
  return stdout;
}

function gitError(err: unknown, cwd: string, args: string[]): GitDriverError {
  const e = err as ExecError;
  if (e.code === 'ENOENT') {
    return new GitDriverError('git_failed', 'Git executable not found on PATH');
  }
  if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return new GitDriverError('output_overflow', `git ${args[0] ?? ''} output exceeded the buffer limit`);
  }
  const stderr = e.stderr?.toString('utf8').trim() ?? '';
  if (/not a git repository/i.test(stderr)) {
    return new GitDriverError('not_a_repository', `${cwd} is not a Git repository`);
  }
  return new GitDriverError('git_failed', `git ${args[0] ?? ''} failed${stderr ? `: ${stderr.slice(0, 500)}` : ''}`);
}

/** Fixed-argument Git execution; never a shell, never client-supplied argv. Exported for tests only. */
export async function runGit(cwd: string, args: string[], options: GitOptions = {}): Promise<Buffer> {
  try {
    return await execGit(cwd, args, options);
  } catch (err) {
    throw gitError(err, cwd, args);
  }
}

/** For commands that answer with exit status 1 (merge-tree reports conflicts that way): the status and the output. */
async function runGitAnswering(cwd: string, args: string[]): Promise<{ status: 0 | 1; stdout: Buffer }> {
  try {
    return { status: 0, stdout: await execGit(cwd, args, {}) };
  } catch (err) {
    // A process that exits nonzero reports its exit status as a number in `code`.
    const e = err as { code?: unknown; stdout?: Buffer };
    if (e.code === 1 && e.stdout) return { status: 1, stdout: e.stdout };
    throw gitError(err, cwd, args);
  }
}

/** Variant for commands where a nonzero exit is an expected answer, not a failure. */
async function tryGit(cwd: string, args: string[]): Promise<Buffer | null> {
  try {
    return await runGit(cwd, args);
  } catch (err) {
    if (
      err instanceof GitDriverError &&
      (err.code === 'git_failed' || err.code === 'not_a_repository')
    ) {
      return null;
    }
    throw err;
  }
}

function text(out: Buffer): string {
  return out.toString('utf8');
}

function line(out: Buffer): string {
  return text(out).trim();
}

/** Comparable host path: resolved, forward slashes, case-folded on Windows. */
function normalizePath(input: string): string {
  const resolved = path.resolve(input).replace(/\\/g, '/');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  const result = await tryGit(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);
  return result !== null;
}

async function branchCommit(repositoryRoot: string, branch: string): Promise<string | null> {
  const out = await tryGit(repositoryRoot, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${branch}^{commit}`,
  ]);
  return out === null ? null : line(out);
}

export class LocalGitWorkspaceDriver implements WorkspaceDriver {
  async inspectRepository(input: InspectRepositoryInput): Promise<RepositoryInfo> {
    const baseRef = assertSafeRefName(input.baseRef);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(input.rootPath);
    } catch {
      throw new GitDriverError('not_a_repository', `${input.rootPath} does not exist`);
    }
    if (!stat.isDirectory()) {
      throw new GitDriverError('not_a_repository', `${input.rootPath} is not a directory`);
    }

    const toplevel = await tryGit(input.rootPath, ['rev-parse', '--show-toplevel']);
    if (toplevel === null) {
      throw new GitDriverError('not_a_repository', `${input.rootPath} is not a Git repository`);
    }
    const root = line(toplevel);
    if (normalizePath(root) !== normalizePath(input.rootPath)) {
      throw new GitDriverError(
        'not_a_repository',
        `${input.rootPath} is inside a repository rooted at ${root}; bind the repository root`
      );
    }

    const commonDirRaw = line(await runGit(root, ['rev-parse', '--git-common-dir']));
    const commonDir = path.resolve(root, commonDirRaw);

    const baseCommit = await branchCommit(root, baseRef);
    if (baseCommit === null) {
      throw new GitDriverError(
        'base_ref_not_branch',
        `Base ref "${baseRef}" does not resolve to a local branch`
      );
    }

    const currentBranchOut = await tryGit(root, ['symbolic-ref', '--short', '-q', 'HEAD']);
    const status = parseStatusZ(text(await runGit(root, ['status', '--porcelain=v1', '-z'])));
    const rootCommits = line(await runGit(root, ['rev-list', '--max-parents=0', baseCommit]))
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .sort();
    const remote = await tryGit(root, ['config', '--get', 'remote.origin.url']);

    const fingerprint = crypto
      .createHash('sha256')
      .update(
        [
          normalizePath(root),
          normalizePath(commonDir),
          rootCommits.join(','),
          remote === null ? '' : line(remote),
        ].join('\0')
      )
      .digest('hex');

    return {
      root,
      commonDir,
      baseRef,
      baseCommit,
      currentBranch: currentBranchOut === null ? null : line(currentBranchOut),
      dirty: status.length > 0,
      fingerprint,
    };
  }

  async prepareWorkspace(input: PrepareWorkspaceInput): Promise<PrepareWorkspaceResult> {
    const branchName = input.branchName === null ? null : assertSafeRefName(input.branchName);
    const baseRef = assertSafeRefName(input.baseRef);
    const resolvedBase = await branchCommit(input.repositoryRoot, baseRef);
    if (resolvedBase === null) {
      throw new GitDriverError(
        'base_ref_not_branch',
        `Base ref "${baseRef}" does not resolve to a local branch`
      );
    }
    const baseCommit = input.baseCommit ?? resolvedBase;
    const worktreePath = resolveInside(input.worktreesRoot, input.leaf);
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

    const fail = (error: string): PrepareWorkspaceResult => ({
      state: 'error',
      worktreePath,
      branchName,
      headCommit: null,
      hasChanges: false,
      error,
      baseCommit,
      reused: false,
    });

    const worktrees = parseWorktreeList(
      text(await runGit(input.repositoryRoot, ['worktree', 'list', '--porcelain']))
    );
    const registered = worktrees.find((w) => normalizePath(w.path) === normalizePath(worktreePath));
    const existingBranchHead =
      branchName === null ? null : await branchCommit(input.repositoryRoot, branchName);

    if (registered) {
      if (registered.branch !== branchName) {
        return fail(
          `Worktree path is registered to branch "${registered.branch ?? '(detached)'}", expected "${branchName ?? '(detached)'}"`
        );
      }
      if (!fs.existsSync(worktreePath)) {
        return fail('Registered worktree directory is missing; reconciliation required');
      }
      const observed = await this.observeWorktree(worktreePath, branchName, baseCommit);
      return { ...observed, baseCommit, reused: true };
    }

    if (existingBranchHead !== null) {
      return fail(`Branch "${branchName}" exists without a managed worktree; reconciliation required`);
    }

    if (fs.existsSync(worktreePath)) {
      if (fs.readdirSync(worktreePath).length > 0) {
        return fail('An unrelated directory already occupies the worktree path');
      }
      fs.rmdirSync(worktreePath);
    }

    const addArgs =
      branchName === null
        ? ['worktree', 'add', '--detach', worktreePath, baseCommit]
        : ['worktree', 'add', '-b', branchName, worktreePath, baseCommit];
    await runGit(input.repositoryRoot, addArgs);
    return {
      state: 'ready',
      worktreePath,
      branchName,
      headCommit: baseCommit,
      hasChanges: false,
      error: null,
      baseCommit,
      reused: false,
    };
  }

  async snapshotWorkingTree(input: {
    worktreePath: string;
    limits?: CaptureLimits;
  }): Promise<WorkingTreeSnapshot> {
    const limits = input.limits ?? DEFAULT_CAPTURE_LIMITS;
    const head = line(await runGit(input.worktreePath, ['rev-parse', 'HEAD']));
    const { summary } = await this.summarizeDiff(input.worktreePath, head, limits);
    return { head, summary };
  }

  async snapshotTree(worktreePath: string): Promise<TreeState> {
    const head = assertCommitId(line(await runGit(worktreePath, ['rev-parse', 'HEAD'])));
    const tree = await this.withScratchIndex(worktreePath, async (env) => {
      await runGit(worktreePath, ['add', '--all', '--', '.'], { env });
      return line(await runGit(worktreePath, ['write-tree'], { env }));
    });
    return { head, tree };
  }

  async writeBeforeRef(input: BeforeRefInput): Promise<BeforeRef> {
    const ref = assertManagedRef(input.ref);
    const state = await this.snapshotTree(input.worktreePath);
    // A fixed identity: the commit is platform bookkeeping, never delivered,
    // and must not fail on repositories without user.name configured.
    const commit = line(
      await runGit(input.worktreePath, ['commit-tree', state.tree, '-p', state.head, '-m', input.message], {
        env: PLATFORM_IDENTITY,
      })
    );
    await runGit(input.worktreePath, ['update-ref', ref, commit]);
    return { ...state, commit };
  }

  async restoreTree(input: RestoreTreeInput): Promise<void> {
    const head = assertCommitId(input.head);
    const tree = assertCommitId(input.tree);
    const cwd = input.worktreePath;
    // Branch and index back to the pinned HEAD; files created since go, ignored ones stay.
    await runGit(cwd, ['reset', '--hard', '--quiet', head]);
    await runGit(cwd, ['clean', '-f', '-d', '--quiet']);
    // Write the pinned content over the checkout without staging it, so edits
    // and untracked files come back as they were found.
    await this.withScratchIndex(cwd, async (env) => {
      await runGit(cwd, ['read-tree', tree], { env });
      await runGit(cwd, ['checkout-index', '--all', '--force'], { env });
    });
    const deleted = parseNulList(
      text(await runGit(cwd, ['diff', '--name-only', '--no-renames', '--diff-filter=D', '-z', head, tree, '--']))
    );
    for (const rel of deleted) fs.rmSync(resolveInside(cwd, rel), { force: true });

    const now = await this.snapshotTree(cwd);
    if (now.head !== head || now.tree !== tree) {
      throw new GitDriverError('git_failed', 'The worktree did not match its before-state after restoring it');
    }
  }

  async deleteManagedRefs(repositoryRoot: string, refs: string[]): Promise<void> {
    if (refs.length === 0) return;
    const commands = refs.map((ref) => `delete ${assertManagedRef(ref)}\n`).join('');
    await runGit(repositoryRoot, ['update-ref', '--stdin'], { stdin: commands });
  }

  /**
   * Runs `work` against a private copy of the worktree's index, so staging
   * for a snapshot never disturbs what the user or agent has staged. The copy
   * keeps the stat cache, which spares rehashing unchanged files; without an
   * index the scratch one starts from HEAD so tracked-but-ignored files stay in.
   */
  private async withScratchIndex<T>(
    worktreePath: string,
    work: (env: Record<string, string>) => Promise<T>
  ): Promise<T> {
    const realIndex = path.resolve(
      worktreePath,
      line(await runGit(worktreePath, ['rev-parse', '--git-path', 'index']))
    );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loxo-index-'));
    const env = { GIT_INDEX_FILE: path.join(dir, 'index') };
    try {
      if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, env.GIT_INDEX_FILE);
      else await runGit(worktreePath, ['read-tree', 'HEAD'], { env });
      return await work(env);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  async captureChanges(input: CaptureChangesInput): Promise<CapturedChanges> {
    const beforeHead = assertCommitId(input.beforeHead);
    const baseCommit = assertCommitId(input.baseCommit);
    const limits = input.limits ?? DEFAULT_CAPTURE_LIMITS;

    const afterHead = line(await runGit(input.worktreePath, ['rev-parse', 'HEAD']));
    const diff = await this.summarizeDiff(input.worktreePath, beforeHead, limits);

    let patch: Buffer = Buffer.alloc(0);
    let patchTruncated = false;
    try {
      patch = await runGit(input.worktreePath, ['diff', '--binary', '--no-ext-diff', beforeHead, '--']);
      if (patch.length > limits.maxPatchBytes) {
        patch = patch.subarray(0, limits.maxPatchBytes);
        patchTruncated = true;
      }
    } catch (err) {
      // A diff larger than the process buffer degrades to a truncation marker, not a failed run.
      if (!(err instanceof GitDriverError && err.code === 'output_overflow')) throw err;
      patchTruncated = true;
    }

    const trackedVsBase = parseNameStatusZ(
      text(
        await runGit(input.worktreePath, [
          'diff',
          '--name-status',
          '--no-renames',
          '-z',
          baseCommit,
          '--',
        ])
      )
    );
    const fingerprint = await computeChangeFingerprint(
      input.worktreePath,
      trackedVsBase,
      diff.untracked
    );

    return {
      afterHead,
      summary: diff.summary,
      changedFiles: diff.changedFiles,
      additions: diff.additions,
      deletions: diff.deletions,
      patch,
      patchTruncated,
      fingerprint,
      trackedChanges: afterHead !== beforeHead || diff.trackedCount > 0,
    };
  }

  async reportBaseDrift(input: BaseDriftInput): Promise<BaseDriftReport> {
    const baseRef = assertSafeRefName(input.baseRef);
    const branchName = assertSafeRefName(input.branchName);
    const baseCommit = assertCommitId(input.baseCommit);
    const cwd = input.repositoryRoot;

    const baseIsAncestor = await isAncestor(cwd, baseCommit, `refs/heads/${baseRef}`);
    const baseAdvancedBy = Number(
      line(await runGit(cwd, ['rev-list', '--count', `${baseCommit}..refs/heads/${baseRef}`]))
    );
    const leftRight = line(
      await runGit(cwd, [
        'rev-list',
        '--left-right',
        '--count',
        `refs/heads/${baseRef}...refs/heads/${branchName}`,
      ])
    ).split(/\s+/);
    const branchBehind = Number(leftRight[0] ?? '0');
    const branchAhead = Number(leftRight[1] ?? '0');

    return {
      baseIsAncestor,
      baseAdvancedBy,
      branchAhead,
      branchBehind,
      diverged: branchAhead > 0 && branchBehind > 0,
    };
  }

  /** Ancestry proof used by merge-lock recovery. */
  async isAncestor(repositoryRoot: string, ancestor: string, descendant: string): Promise<boolean> {
    return isAncestor(repositoryRoot, ancestor, descendant);
  }

  /**
   * Recovery-only merge abort: runs `git merge --abort` in the primary
   * checkout and returns true only when restoration to the recorded pre-merge
   * HEAD is verified.
   */
  async mergeAbortForRecovery(repositoryRoot: string, preHead: string): Promise<boolean> {
    assertCommitId(preHead);
    await tryGit(repositoryRoot, ['merge', '--abort']);
    const after = await this.inspectPrimaryCheckout(repositoryRoot);
    return after.head === preHead && after.clean && after.mergeHead === null;
  }

  async inspectPrimaryCheckout(repositoryRoot: string): Promise<PrimaryCheckoutState> {
    const branchOut = await tryGit(repositoryRoot, ['symbolic-ref', '--short', '-q', 'HEAD']);
    const head = line(await runGit(repositoryRoot, ['rev-parse', 'HEAD']));
    const status = parseStatusZ(
      text(await runGit(repositoryRoot, ['status', '--porcelain=v1', '-z']))
    );
    const mergeHead = await tryGit(repositoryRoot, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
    const origHead = await tryGit(repositoryRoot, ['rev-parse', '-q', '--verify', 'ORIG_HEAD']);
    return {
      branch: branchOut === null ? null : line(branchOut),
      head,
      clean: status.length === 0,
      mergeHead: mergeHead === null ? null : line(mergeHead),
      origHead: origHead === null ? null : line(origHead),
    };
  }

  /**
   * Stages and commits everything left in the worktree so Git merge can carry
   * it. Uses the repository's configured identity; a missing identity blocks
   * finalization instead of inventing or leaking host identity.
   */
  /**
   * Commits everything in the worktree under explicit identities, never the
   * repository's own git config. Returns a null commit when there is nothing
   * to commit.
   */
  async commitAs(input: CommitAsInput): Promise<CheckpointResult> {
    await runGit(input.worktreePath, ['add', '-A', '--', '.']);
    const staged = await tryGit(input.worktreePath, ['diff', '--cached', '--quiet']);
    if (staged !== null) return { commit: null };
    const committer = input.committer ?? input.author;
    await runGit(input.worktreePath, ['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', input.message], {
      env: {
        GIT_AUTHOR_NAME: input.author.name,
        GIT_AUTHOR_EMAIL: input.author.email,
        GIT_COMMITTER_NAME: committer.name,
        GIT_COMMITTER_EMAIL: committer.email,
      },
    });
    return { commit: line(await runGit(input.worktreePath, ['rev-parse', 'HEAD'])) };
  }

  /**
   * Clears what a git process killed part-way can leave in a worktree: a stale
   * index lock, which fails every later command, and an unfinished merge,
   * unless the caller is keeping one on purpose. Only safe once the process
   * that left them is known to be gone.
   */
  async clearInterruptedState(worktreePath: string, options: { keepMerge?: boolean } = {}): Promise<InterruptedStateCleared> {
    const gitDir = path.resolve(worktreePath, line(await runGit(worktreePath, ['rev-parse', '--git-dir'])));
    const lock = path.join(gitDir, 'index.lock');
    const removedLock = fs.existsSync(lock);
    if (removedLock) fs.rmSync(lock, { force: true });
    let abortedMerge = false;
    if (!options.keepMerge && fs.existsSync(path.join(gitDir, 'MERGE_HEAD'))) {
      await runGit(worktreePath, ['merge', '--abort']);
      abortedMerge = true;
    }
    return { removedLock, abortedMerge };
  }

  /**
   * Puts a clean worktree on a package branch, creating the branch at
   * `startCommit` first. A branch that already exists must point exactly at
   * `startCommit`, so a redo after a crash finds its own work and anything
   * else is refused.
   */
  async checkoutPackageBranch(input: { worktreePath: string; branch: string; startCommit: string }): Promise<{ head: string }> {
    const branch = assertSafeRefName(input.branch);
    const start = assertCommitId(input.startCommit);
    const existing = await tryGit(input.worktreePath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
    if (existing === null) await runGit(input.worktreePath, ['branch', branch, start]);
    else if (line(existing) !== start) {
      throw new GitDriverError('branch_elsewhere', `Branch ${branch} already points at ${line(existing)}, not ${start}`);
    }
    const current = await tryGit(input.worktreePath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (current === null || line(current) !== branch) {
      if (text(await runGit(input.worktreePath, ['status', '--porcelain'])).trim()) {
        throw new GitDriverError('dirty_workspace', `The worktree has uncommitted changes; cannot switch to ${branch}`);
      }
      await runGit(input.worktreePath, ['checkout', '--quiet', branch]);
    }
    return { head: line(await runGit(input.worktreePath, ['rev-parse', 'HEAD'])) };
  }

  /** Where a worktree stands against its package: its branch, HEAD, whether HEAD grew from `startCommit`, and whether it is clean. */
  async packageHead(worktreePath: string, startCommit: string): Promise<{ branch: string | null; head: string; descends: boolean; clean: boolean }> {
    const current = await tryGit(worktreePath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const head = line(await runGit(worktreePath, ['rev-parse', 'HEAD']));
    return {
      branch: current === null ? null : line(current),
      head,
      descends: await isAncestor(worktreePath, assertCommitId(startCommit), head),
      clean: !text(await runGit(worktreePath, ['status', '--porcelain'])).trim(),
    };
  }

  /**
   * Merges a package branch into the worktree's current branch with a merge
   * commit under `identity`, after computing the merge in memory first
   * (`merge-tree`): a conflict is reported with its files and the worktree is
   * never touched. A branch already merged is left alone and its merge commit
   * found in the history.
   */
  async mergePackage(input: { worktreePath: string; branch: string; message: string; identity: GitIdentity }): Promise<PackageMerge> {
    const cwd = input.worktreePath;
    const branch = assertSafeRefName(input.branch);
    const tip = line(await runGit(cwd, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]));
    const onto = line(await runGit(cwd, ['rev-parse', 'HEAD']));
    if (await isAncestor(cwd, tip, onto)) {
      const mergeCommit = await this.mergeOf(cwd, tip);
      const firstParent = mergeCommit ? line(await runGit(cwd, ['rev-parse', `${mergeCommit}^1`])) : onto;
      return { result: 'already_merged', head: onto, onto: firstParent, tip, mergeCommit, conflicts: [] };
    }
    const trial = await runGitAnswering(cwd, ['merge-tree', '--write-tree', '--name-only', '-z', '--no-messages', onto, tip]);
    if (trial.status === 1) {
      const [, ...conflicts] = parseNulList(text(trial.stdout));
      return { result: 'conflicted', head: onto, onto, tip, mergeCommit: null, conflicts };
    }
    try {
      await runGit(cwd, ['-c', 'commit.gpgsign=false', 'merge', '--no-ff', '--no-verify', '-m', input.message, branch], {
        env: {
          GIT_AUTHOR_NAME: input.identity.name,
          GIT_AUTHOR_EMAIL: input.identity.email,
          GIT_COMMITTER_NAME: input.identity.name,
          GIT_COMMITTER_EMAIL: input.identity.email,
        },
      });
    } catch (err) {
      await tryGit(cwd, ['merge', '--abort']);
      throw err;
    }
    const head = line(await runGit(cwd, ['rev-parse', 'HEAD']));
    return { result: 'merged', head, onto, tip, mergeCommit: head, conflicts: [] };
  }

  /** The merge commit on HEAD's first-parent line that brought `tip` in, or null when it came in some other way. */
  private async mergeOf(cwd: string, tip: string): Promise<string | null> {
    const out = text(await runGit(cwd, ['rev-list', '--first-parent', '--merges', '--parents', 'HEAD']));
    for (const entry of out.split('\n')) {
      const [commit, , second] = entry.trim().split(' ');
      if (commit && second === tip) return commit;
    }
    return null;
  }

  /**
   * Starts merging `onto` into a package branch and leaves the conflicts in
   * the worktree for its owner: the branch is checked out (the worktree must
   * be clean to switch), then `merge --no-commit`. Redone after a crash, a
   * merge of `onto` already under way is kept, and anything a killed merge
   * left half-written is reset to the branch head first; the head is
   * committed, so nothing of the owner's is lost.
   */
  async beginPackageMerge(input: { worktreePath: string; branch: string; head: string; onto: string }): Promise<{ conflicts: string[] }> {
    const cwd = input.worktreePath;
    const branch = assertSafeRefName(input.branch);
    const head = assertCommitId(input.head);
    const onto = assertCommitId(input.onto);
    const current = await tryGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (current === null || line(current) !== branch) {
      if (text(await runGit(cwd, ['status', '--porcelain'])).trim()) {
        throw new GitDriverError('dirty_workspace', `The worktree has uncommitted changes; cannot switch to ${branch}`);
      }
      await runGit(cwd, ['checkout', '--quiet', branch]);
    }
    const at = line(await runGit(cwd, ['rev-parse', 'HEAD']));
    if (await isAncestor(cwd, onto, at)) return { conflicts: [] };
    if (at !== head) throw new GitDriverError('branch_elsewhere', `Branch ${branch} is at ${at}, not ${head}`);

    const merging = await tryGit(cwd, ['rev-parse', '--quiet', '--verify', 'MERGE_HEAD']);
    if (merging !== null && line(merging) === onto) return { conflicts: await this.unmergedFiles(cwd) };
    if (merging !== null) await runGit(cwd, ['merge', '--abort']);
    if (text(await runGit(cwd, ['status', '--porcelain'])).trim()) {
      await runGit(cwd, ['reset', '--hard', '--quiet', head]);
      await runGit(cwd, ['clean', '-f', '-d', '--quiet']);
    }
    // Exits nonzero on conflicts, which is the point; MERGE_HEAD tells whether the merge began.
    await tryGit(cwd, ['merge', '--no-commit', '--no-ff', '--no-verify', onto]);
    const begun = await tryGit(cwd, ['rev-parse', '--quiet', '--verify', 'MERGE_HEAD']);
    if (begun === null || line(begun) !== onto) {
      throw new GitDriverError('git_failed', `Could not start merging ${onto} into ${branch}`);
    }
    return { conflicts: await this.unmergedFiles(cwd) };
  }

  private async unmergedFiles(cwd: string): Promise<string[]> {
    return parseNulList(text(await runGit(cwd, ['diff', '--name-only', '--diff-filter=U', '-z'])));
  }

  /**
   * Commits a resolved merge onto the package branch with both parents given
   * explicitly (the branch head and `onto`) and the worktree as its tree, so
   * the result does not depend on MERGE_HEAD surviving a crash or a discard.
   * Refused while any of `conflicts` still holds conflict markers. Redone, a
   * branch already at that merge is taken as it stands; the merge state and
   * index are cleared either way.
   */
  async finishPackageMerge(input: {
    worktreePath: string;
    branch: string;
    head: string;
    onto: string;
    conflicts: string[];
    message: string;
    author: GitIdentity;
    committer: GitIdentity;
  }): Promise<{ commit: string }> {
    const cwd = input.worktreePath;
    const branch = assertSafeRefName(input.branch);
    const head = assertCommitId(input.head);
    const onto = assertCommitId(input.onto);
    const current = await tryGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (current === null || line(current) !== branch) {
      throw new GitDriverError('branch_elsewhere', `The worktree is off ${branch}`);
    }
    const at = line(await runGit(cwd, ['rev-parse', 'HEAD']));
    const parents = line(await runGit(cwd, ['rev-list', '--parents', '-n', '1', at])).split(' ').slice(1);
    const done = parents.length === 2 && parents[0] === head && parents[1] === onto;
    let commit = at;
    if (!done && !(at === head && (await isAncestor(cwd, onto, at)))) {
      if (at !== head) throw new GitDriverError('branch_elsewhere', `Branch ${branch} is at ${at}, not ${head}`);
      const unresolved = this.unresolvedConflicts(cwd, input.conflicts);
      if (unresolved.length > 0) {
        throw new GitDriverError('unresolved_conflicts', `Conflict markers remain in ${unresolved.join(', ')}`);
      }
      const { tree } = await this.snapshotTree(cwd);
      commit = line(
        await runGit(cwd, ['-c', 'commit.gpgsign=false', 'commit-tree', tree, '-p', head, '-p', onto, '-m', input.message], {
          env: {
            GIT_AUTHOR_NAME: input.author.name,
            GIT_AUTHOR_EMAIL: input.author.email,
            GIT_COMMITTER_NAME: input.committer.name,
            GIT_COMMITTER_EMAIL: input.committer.email,
          },
        })
      );
      await runGit(cwd, ['update-ref', `refs/heads/${branch}`, commit, head]);
    }
    if ((await tryGit(cwd, ['rev-parse', '--quiet', '--verify', 'MERGE_HEAD'])) !== null) {
      await runGit(cwd, ['merge', '--quit']);
    }
    // The tree came from the worktree, so matching the index to the new head leaves it clean.
    await runGit(cwd, ['reset', '--quiet']);
    return { commit };
  }

  /** Which of `files` still hold conflict markers in the worktree. */
  unresolvedConflicts(worktreePath: string, files: string[]): string[] {
    return files.filter((rel) => {
      const target = resolveInside(worktreePath, rel);
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return false;
      return CONFLICT_MARKER.test(fs.readFileSync(target, 'utf8'));
    });
  }

  /** The installed git version, or null when git cannot be run. */
  async gitVersion(): Promise<[number, number, number] | null> {
    const out = await tryGit(process.cwd(), ['--version']);
    const match = out ? /(\d+)\.(\d+)\.(\d+)/.exec(text(out)) : null;
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  }

  async commitCheckpoint(input: CheckpointInput): Promise<CheckpointResult> {
    const name = await tryGit(input.worktreePath, ['config', 'user.name']);
    const email = await tryGit(input.worktreePath, ['config', 'user.email']);
    if (name === null || email === null || !line(name) || !line(email)) {
      throw new GitDriverError(
        'git_identity_missing',
        'Configure git user.name and user.email before finalizing'
      );
    }
    await runGit(input.worktreePath, ['add', '-A', '--', '.']);
    const staged = await tryGit(input.worktreePath, ['diff', '--cached', '--quiet']);
    if (staged !== null) return { commit: null };
    await runGit(input.worktreePath, ['commit', '-m', input.message]);
    return { commit: line(await runGit(input.worktreePath, ['rev-parse', 'HEAD'])) };
  }

  /**
   * Merges the task branch into the registered primary checkout. The caller
   * verifies preconditions and holds the repository merge lock; this method
   * re-verifies the checkout immediately before mutating it.
   */
  async mergeWorkspace(input: MergeWorkspaceInput): Promise<MergeOutcome> {
    const baseRef = assertSafeRefName(input.baseRef);
    const branchName = assertSafeRefName(input.branchName);
    const checkout = await this.inspectPrimaryCheckout(input.repositoryRoot);
    if (checkout.branch !== baseRef) {
      throw new GitDriverError(
        'merge_precondition_failed',
        `The primary checkout is on "${checkout.branch ?? '(detached)'}", not "${baseRef}"; check out the base branch manually`
      );
    }
    if (!checkout.clean) {
      throw new GitDriverError(
        'merge_precondition_failed',
        'The primary checkout has uncommitted changes; commit or stash them before merging'
      );
    }

    const preHead = checkout.head;
    const merge = await tryGit(input.repositoryRoot, [
      'merge',
      '--no-ff',
      '-m',
      input.message,
      branchName,
    ]);
    if (merge !== null) {
      return {
        result: 'merged',
        newHead: line(await runGit(input.repositoryRoot, ['rev-parse', 'HEAD'])),
        preHead,
      };
    }

    // Conflict path: abort, then prove the checkout was restored.
    const abort = await tryGit(input.repositoryRoot, ['merge', '--abort']);
    const after = await this.inspectPrimaryCheckout(input.repositoryRoot);
    if (abort !== null && after.head === preHead && after.clean && after.mergeHead === null) {
      return { result: 'conflicted', preHead };
    }
    return {
      result: 'abort_failed',
      preHead,
      error: 'Merge abort could not restore the primary checkout; manual recovery required',
    };
  }

  async removeWorkspace(input: RemoveWorkspaceInput): Promise<void> {
    if (fs.existsSync(input.worktreePath)) {
      const status = parseStatusZ(
        text(await runGit(input.worktreePath, ['status', '--porcelain=v1', '-z']))
      );
      if (status.length > 0 && !input.allowDirty) {
        throw new GitDriverError(
          'dirty_workspace',
          'Worktree has uncommitted changes; removal requires explicit confirmation'
        );
      }
      const args = input.allowDirty
        ? ['worktree', 'remove', '--force', input.worktreePath]
        : ['worktree', 'remove', input.worktreePath];
      await runGit(input.repositoryRoot, args);
    }
    await runGit(input.repositoryRoot, ['worktree', 'prune']);
    if (input.deleteBranch) {
      const branch = assertManagedBranch(input.deleteBranch);
      if ((await branchCommit(input.repositoryRoot, branch)) !== null) {
        await runGit(input.repositoryRoot, ['branch', '-D', branch]);
      }
    }
  }

  async reconcileWorkspace(input: ReconcileWorkspaceInput): Promise<ReconcileWorkspaceResult> {
    const branchName = input.branchName === null ? null : assertSafeRefName(input.branchName);
    const baseCommit = assertCommitId(input.baseCommit);
    const { repositoryRoot, worktreePath } = input;
    let recovered = false;

    const fail = (error: string, state: 'missing' | 'error'): ReconcileWorkspaceResult => ({
      state,
      worktreePath,
      branchName,
      headCommit: null,
      hasChanges: false,
      error: state === 'missing' ? null : error,
      recovered,
    });

    const findRegistered = async () => {
      const worktrees = parseWorktreeList(
        text(await runGit(repositoryRoot, ['worktree', 'list', '--porcelain']))
      );
      return worktrees.find((w) => normalizePath(w.path) === normalizePath(worktreePath));
    };

    let registered = await findRegistered();
    if (registered && !fs.existsSync(worktreePath)) {
      // Directory deleted out of band; drop the stale registration, then recover from the branch.
      await runGit(repositoryRoot, ['worktree', 'prune']);
      registered = undefined;
    }

    if (!registered && fs.existsSync(worktreePath)) {
      const dotGit = path.join(worktreePath, '.git');
      if (fs.existsSync(dotGit)) {
        // Likely lost registration (moved metadata, interrupted add); repair re-links it.
        await tryGit(repositoryRoot, ['worktree', 'repair', worktreePath]);
        registered = await findRegistered();
        if (registered) recovered = true;
      }
      if (!registered) {
        if (fs.readdirSync(worktreePath).length > 0) {
          return fail('An unrelated directory occupies the worktree path', 'error');
        }
        fs.rmdirSync(worktreePath);
      }
    }

    if (!registered && branchName === null) {
      return fail('Detached worktree is gone', 'missing');
    }
    if (!registered && branchName !== null) {
      const branchHead = await branchCommit(repositoryRoot, branchName);
      if (branchHead === null) {
        return fail('Worktree and branch are both gone', 'missing');
      }
      // Branch survived a crash or out-of-band deletion; committed work is recoverable.
      await runGit(repositoryRoot, ['worktree', 'prune']);
      await runGit(repositoryRoot, ['worktree', 'add', worktreePath, branchName]);
      recovered = true;
      registered = await findRegistered();
    }

    if (registered && registered.branch !== branchName) {
      return fail(
        `Worktree has branch "${registered.branch ?? '(detached)'}" checked out, expected "${branchName ?? '(detached)'}"`,
        'error'
      );
    }

    if (!(await isAncestor(worktreePath, baseCommit, 'HEAD'))) {
      return fail('Workspace history no longer contains the base commit', 'error');
    }

    const observed = await this.observeWorktree(worktreePath, branchName, baseCommit);
    return { ...observed, branchName, recovered };
  }

  private async observeWorktree(
    worktreePath: string,
    branchName: string | null,
    baseCommit: string
  ): Promise<WorkspaceObservation> {
    const head = line(await runGit(worktreePath, ['rev-parse', 'HEAD']));
    const status = parseStatusZ(
      text(await runGit(worktreePath, ['status', '--porcelain=v1', '-z']))
    );
    const hasChanges = head !== baseCommit || status.length > 0;
    return {
      state: hasChanges ? 'dirty' : 'ready',
      worktreePath,
      branchName,
      headCommit: head,
      hasChanges,
      error: null,
    };
  }

  private async summarizeDiff(worktreePath: string, sinceCommit: string, limits: CaptureLimits) {
    const untracked = parseNulList(
      text(await runGit(worktreePath, ['ls-files', '--others', '--exclude-standard', '-z']))
    );
    const nameStatus = parseNameStatusZ(
      text(await runGit(worktreePath, ['diff', '--name-status', '-z', sinceCommit, '--']))
    );
    const numstat = parseNumstatZ(
      text(await runGit(worktreePath, ['diff', '--numstat', '-z', sinceCommit, '--']))
    );
    const totals = buildChangeSummary(nameStatus, numstat, untracked, limits);
    return { ...totals, untracked, trackedCount: nameStatus.length };
  }
}

export const localGitDriver = new LocalGitWorkspaceDriver();
