import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { runs, type PlatformOp, type Workspace, type WorkspaceStatus } from '../../db/schema';
import { localGitDriver } from '../code-workspaces/local-git-driver';
import { findRepository, getWorkspace } from '../code-workspaces/workspace.service';
import type { PlatformOpHandler } from './platform-ops';

/**
 * Built-in platform operations. Each is redone safely after a crash: it
 * starts from what Git shows, and a step already done is detected and kept.
 * Handlers only observe; the worktree row is updated from their result in the
 * fenced transaction that settles the run.
 */

/** What an operation saw of its worktree, applied to the row when its run settles. */
export interface WorktreeObservation {
  id: string;
  status: WorkspaceStatus;
  headCommit: string | null;
  worktreePath?: string;
  lastError: string | null;
}

/** Operations allowed on a quarantined worktree: they exist to release one. */
export const QUARANTINE_RECOVERY_OPS = ['reset_to_before', 'reconcile_worktree'] as const;

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

export const BUILT_IN_PLATFORM_OPS: Readonly<Record<string, PlatformOpHandler>> = {
  prepare_worktree: prepareWorktree,
  reset_to_before: resetToBefore,
  reconcile_worktree: reconcileWorktree,
  cleanup,
};
