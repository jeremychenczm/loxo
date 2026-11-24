import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client';
import {
  runs,
  workPackages,
  type IntegrationOutcome,
  type PlatformOp,
  type WorkPackage,
  type WorkPackageStatus,
  type Workspace,
  type WorkspaceStatus,
} from '../../db/schema';
import { localGitDriver } from '../code-workspaces/local-git-driver';
import { findRepository, getWorkspace } from '../code-workspaces/workspace.service';
import { conflictFilesOf } from './conflicts';
import type { PlatformOpHandler } from './platform-ops';

/**
 * Built-in platform operations. Each is redone safely after a crash: it
 * starts from what Git shows, and a step already done is detected and kept.
 * Handlers only observe; the worktree row is updated from their result in the
 * fenced transaction that settles the run.
 */

/** Who platform commits are made as; never the repository's own git config. */
export const PLATFORM_IDENTITY = { name: 'Loxo', email: 'platform@loxo.local' } as const;

/** What an operation saw of its worktree, applied to the row when its run settles. */
export interface WorktreeObservation {
  id: string;
  status: WorkspaceStatus;
  headCommit: string | null;
  worktreePath?: string;
  /** Set when the operation moved the worktree to another branch. */
  currentBranch?: string | null;
  lastError: string | null;
}

/** What a package operation established, applied to the work package row when its run settles. */
export interface PackageObservation {
  key: string;
  status: WorkPackageStatus;
  branch?: string;
  startCommit?: string;
  headCommit?: string;
  resolves?: number;
  resolveOnto?: string;
}

/** What an integration came to, recorded once per operation when its run settles. */
export interface IntegrationObservation {
  packageKey: string;
  outcome: IntegrationOutcome;
  ontoCommit: string;
  packageHead: string;
  mergeCommit: string | null;
  conflictFiles: string[];
}

/** Operations allowed on a quarantined worktree: they exist to release one. */
export const QUARANTINE_RECOVERY_OPS = ['reset_to_before', 'reconcile_worktree'] as const;

/** Operations that run in a package worktree mid-merge; a redo must not abort that merge. */
export const KEEPS_MERGE_OPS: readonly string[] = ['begin_resolve', 'finish_resolve'];

async function worktreeOf(op: PlatformOp): Promise<{ workspace: Workspace; repositoryRoot: string }> {
  const workspace = op.workspaceId ? await getWorkspace(op.workspaceId) : null;
  if (!workspace) throw new Error(`Operation ${op.kind} has no worktree`);
  const repository = await findRepository(workspace.userId, workspace.repositoryId);
  if (!repository) throw new Error('The task repository was removed');
  return { workspace, repositoryRoot: repository.rootPath };
}

async function reconciled(workspace: Workspace, repositoryRoot: string): Promise<WorktreeObservation> {
  const result = await localGitDriver.reconcileWorkspace({
    repositoryRoot,
    worktreePath: workspace.worktreePath,
    branchName: workspace.currentBranch,
    baseCommit: workspace.baseCommit,
  });
  return { id: workspace.id, status: result.state, headCommit: result.headCommit, lastError: result.error };
}

/**
 * Creates the worktree its row describes: on its current branch, or detached
 * at its base commit. A worktree already registered as expected is reused.
 */
const prepareWorktree: PlatformOpHandler = async (op) => {
  const { workspace, repositoryRoot } = await worktreeOf(op);
  const prepared = await localGitDriver.prepareWorkspace({
    repositoryRoot,
    worktreesRoot: path.dirname(workspace.worktreePath),
    leaf: path.basename(workspace.worktreePath),
    branchName: workspace.currentBranch,
    baseRef: workspace.baseRef,
    baseCommit: workspace.baseCommit,
  });
  if (prepared.state === 'error' || prepared.state === 'missing') {
    throw new Error(prepared.error ?? `Worktree preparation ended ${prepared.state}`);
  }
  const worktree: WorktreeObservation = {
    id: workspace.id,
    status: prepared.state,
    headCommit: prepared.headCommit,
    worktreePath: prepared.worktreePath,
    lastError: null,
  };
  return { worktree };
};

/** Puts a worktree back to the before-state a run pinned; restoring an already restored tree is a no-op. */
const resetToBefore: PlatformOpHandler = async (op) => {
  const { workspace, repositoryRoot } = await worktreeOf(op);
  const runId = typeof op.args.runId === 'string' ? op.args.runId : null;
  const [run] = runId ? await db.select().from(runs).where(eq(runs.id, runId)) : [];
  if (!run?.beforeHead || !run.beforeTree) throw new Error('The run has no before-state to reset to');
  await localGitDriver.restoreTree({ worktreePath: workspace.worktreePath, head: run.beforeHead, tree: run.beforeTree });
  return { worktree: await reconciled(workspace, repositoryRoot) };
};

/** Re-reads a worktree as it is, keeping whatever is there. */
const reconcileWorktree: PlatformOpHandler = async (op) => {
  const { workspace, repositoryRoot } = await worktreeOf(op);
  return { worktree: await reconciled(workspace, repositoryRoot) };
};

/** Removes a worktree the workshop no longer needs, and its branch when asked; removing a missing one is a no-op. */
const cleanup: PlatformOpHandler = async (op) => {
  const { workspace, repositoryRoot } = await worktreeOf(op);
  const deleteBranch = typeof op.args.deleteBranch === 'string' ? op.args.deleteBranch : undefined;
  await localGitDriver.removeWorkspace({
    repositoryRoot,
    worktreePath: workspace.worktreePath,
    allowDirty: true,
    deleteBranch,
  });
  const worktree: WorktreeObservation = { id: workspace.id, status: 'abandoned', headCommit: null, lastError: null };
  return { worktree };
};

async function packageOf(op: PlatformOp): Promise<WorkPackage> {
  const key = typeof op.args.packageKey === 'string' ? op.args.packageKey : '';
  const [pkg] = await db.select().from(workPackages).where(and(eq(workPackages.taskId, op.taskId), eq(workPackages.key, key)));
  if (!pkg) throw new Error(`Package "${key}" does not exist`);
  return pkg;
}

/** Creates the package branch at the start the engine chose and checks it out in the owner's worktree. */
const branchPackage: PlatformOpHandler = async (op) => {
  const { workspace } = await worktreeOf(op);
  const pkg = await packageOf(op);
  const branch = String(op.args.branch);
  const startCommit = String(op.args.startCommit);
  const { head } = await localGitDriver.checkoutPackageBranch({ worktreePath: workspace.worktreePath, branch, startCommit });
  const worktree: WorktreeObservation = { id: workspace.id, status: 'ready', headCommit: head, currentBranch: branch, lastError: null };
  const observed: PackageObservation = { key: pkg.key, status: 'branched', branch, startCommit };
  return { worktree, package: observed };
};

/**
 * Commits what the owner built onto the package branch, authored as the
 * owner via the platform. The build must have left the worktree on that
 * branch, grown from its start; one already committed is taken as it stands.
 */
const checkpoint: PlatformOpHandler = async (op) => {
  const { workspace } = await worktreeOf(op);
  const pkg = await packageOf(op);
  if (!pkg.branch || !pkg.startCommit) throw new Error(`Package "${pkg.key}" has no branch yet`);
  const at = await localGitDriver.packageHead(workspace.worktreePath, pkg.startCommit);
  if (at.branch !== pkg.branch || !at.descends) {
    throw new Error(`The build left the worktree off ${pkg.branch} (on ${at.branch ?? 'a detached HEAD'})`);
  }
  const author = typeof op.args.author === 'string' && op.args.author ? op.args.author : 'A member';
  const { commit } = await localGitDriver.commitAs({
    worktreePath: workspace.worktreePath,
    message: `Package ${pkg.key}: ${pkg.title}`,
    author: { name: `${author} via Loxo`, email: PLATFORM_IDENTITY.email },
    committer: PLATFORM_IDENTITY,
  });
  const head = commit ?? at.head;
  const worktree: WorktreeObservation = { id: workspace.id, status: 'ready', headCommit: head, lastError: null };
  const observed: PackageObservation = { key: pkg.key, status: 'built', headCommit: head };
  return { worktree, package: observed };
};

/**
 * Merges a built package into the integration branch with a merge commit,
 * once a trial merge shows it is clean; a package already merged is left
 * alone. A conflict leaves the integration worktree untouched: the package
 * is marked conflicted against the current head, for its owner to resolve.
 */
const integrate: PlatformOpHandler = async (op) => {
  const { workspace } = await worktreeOf(op);
  const pkg = await packageOf(op);
  if (!pkg.branch) throw new Error(`Package "${pkg.key}" has no branch yet`);
  const merged = await localGitDriver.mergePackage({
    worktreePath: workspace.worktreePath,
    branch: pkg.branch,
    message: `Integrate package ${pkg.key}: ${pkg.title}`,
    identity: PLATFORM_IDENTITY,
  });
  const conflicted = merged.result === 'conflicted';
  const worktree: WorktreeObservation = { id: workspace.id, status: 'ready', headCommit: merged.head, lastError: null };
  const observed: PackageObservation = conflicted
    ? { key: pkg.key, status: 'conflicted', resolveOnto: merged.onto }
    : { key: pkg.key, status: 'integrated' };
  const integration: IntegrationObservation = {
    packageKey: pkg.key,
    outcome: conflicted ? 'conflicted' : 'merged',
    ontoCommit: merged.onto,
    packageHead: merged.tip,
    mergeCommit: merged.mergeCommit,
    conflictFiles: merged.conflicts,
  };
  return { worktree, package: observed, integration };
};

/** A package with a conflict to resolve: its branch, head and the integration head it conflicted with. */
function resolvable(pkg: WorkPackage): { branch: string; head: string; onto: string } {
  if (!pkg.branch || !pkg.headCommit || !pkg.resolveOnto) throw new Error(`Package "${pkg.key}" has no conflict to resolve`);
  return { branch: pkg.branch, head: pkg.headCommit, onto: pkg.resolveOnto };
}

/**
 * Puts the owner's worktree on the package branch with the integration head
 * it conflicted with merged in but not committed, conflict markers in place.
 */
const beginResolve: PlatformOpHandler = async (op) => {
  const { workspace } = await worktreeOf(op);
  const pkg = await packageOf(op);
  const { branch, head, onto } = resolvable(pkg);
  const { conflicts } = await localGitDriver.beginPackageMerge({ worktreePath: workspace.worktreePath, branch, head, onto });
  const worktree: WorktreeObservation = { id: workspace.id, status: 'dirty', headCommit: head, currentBranch: branch, lastError: null };
  const observed: PackageObservation = { key: pkg.key, status: 'resolving' };
  return { worktree, package: observed, conflicts };
};

/**
 * Commits the owner's resolution onto the package branch as a merge of the
 * branch head and the integration head, authored as the owner via the
 * platform. The package is built again, one resolve further, and goes back
 * to integration.
 */
const finishResolve: PlatformOpHandler = async (op) => {
  const { workspace } = await worktreeOf(op);
  const pkg = await packageOf(op);
  const { branch, head, onto } = resolvable(pkg);
  const author = typeof op.args.author === 'string' && op.args.author ? op.args.author : 'A member';
  const { commit } = await localGitDriver.finishPackageMerge({
    worktreePath: workspace.worktreePath,
    branch,
    head,
    onto,
    conflicts: await conflictFilesOf(pkg),
    message: `Resolve package ${pkg.key} against the integration branch`,
    author: { name: `${author} via Loxo`, email: PLATFORM_IDENTITY.email },
    committer: PLATFORM_IDENTITY,
  });
  const worktree: WorktreeObservation = { id: workspace.id, status: 'ready', headCommit: commit, lastError: null };
  const observed: PackageObservation = { key: pkg.key, status: 'built', headCommit: commit, resolves: pkg.resolves + 1 };
  return { worktree, package: observed };
};

export const BUILT_IN_PLATFORM_OPS: Readonly<Record<string, PlatformOpHandler>> = {
  prepare_worktree: prepareWorktree,
  branch_package: branchPackage,
  checkpoint,
  integrate,
  begin_resolve: beginResolve,
  finish_resolve: finishResolve,
  reset_to_before: resetToBefore,
  reconcile_worktree: reconcileWorktree,
  cleanup,
};
