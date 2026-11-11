import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolveInside } from '../../storage/path-safety';
import { assertCommitId, assertManagedBranch, assertSafeRefName } from './branch-name';
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
  type CaptureChangesInput,
  type CaptureLimits,
  type CapturedChanges,
  type CheckpointInput,
  type CheckpointResult,
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
  type WorkingTreeSnapshot,
  type WorkspaceObservation,
} from './workspace.types';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;
/** Patch capture reads full diffs before capping; anything larger fails soft as truncated. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

type ExecError = NodeJS.ErrnoException & { stderr?: Buffer; stdout?: Buffer };

/** Fixed-argument Git execution; never a shell, never client-supplied argv. */
async function runGit(cwd: string, args: string[]): Promise<Buffer> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
      encoding: 'buffer',
      // No optional locks: read-only commands such as status must not refresh the
      // user's index as a side effect.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    });
    return stdout;
  } catch (err) {
    const e = err as ExecError;
    if (e.code === 'ENOENT') {
      throw new GitDriverError('git_failed', 'Git executable not found on PATH');
    }
    if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw new GitDriverError('output_overflow', `git ${args[0] ?? ''} output exceeded the buffer limit`);
    }
    const stderr = e.stderr?.toString('utf8').trim() ?? '';
    if (/not a git repository/i.test(stderr)) {
      throw new GitDriverError('not_a_repository', `${cwd} is not a Git repository`);
    }
    throw new GitDriverError(
      'git_failed',
      `git ${args[0] ?? ''} failed${stderr ? `: ${stderr.slice(0, 500)}` : ''}`
    );
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
    const branchName = assertSafeRefName(input.branchName);
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

    if (!registered) {
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
        `Worktree has branch "${registered.branch ?? '(detached)'}" checked out, expected "${branchName}"`,
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
