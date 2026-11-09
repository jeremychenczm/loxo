import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { and, desc, eq, isNull, notInArray } from 'drizzle-orm';
import { db } from '../../db/client';
import {
  EXECUTION_WORKSPACE_TERMINAL_STATUSES,
  executionWorkspaces,
  issueReviews,
  issues,
  projectRepositories,
  projects,
  runChangeSnapshots,
  type ExecutionWorkspace,
  type Issue,
  type ProjectRepository,
  type RunChangeSnapshot,
} from '../../db/schema';
import { badRequest, conflict, notFound } from '../../http/errors';
import { storage } from '../../storage/layout';
import { addSystemComment } from '../issues/comments.service';
import { moveIssue } from '../issues/issues.service';
import type { TurnPermission } from '../runner/runner';
import { issueBranchName } from './branch-name';
import { localGitDriver } from './local-git-driver';
import {
  GitDriverError,
  type BaseDriftReport,
  type WorkingTreeSnapshot,
} from './workspace.types';

const TERMINALS = [...EXECUTION_WORKSPACE_TERMINAL_STATUSES];

/** Translates driver failures into client-visible errors at the API boundary. */
function rethrowGitError(err: unknown): never {
  if (err instanceof GitDriverError) {
    throw badRequest(err.code, err.message);
  }
  throw err;
}

/** Server repositories live in the project workspace. */
function repositoryRoot(userId: string, repository: ProjectRepository): string {
  return storage.projectWorkspace(userId, repository.projectId);
}

export async function getProjectRepository(
  userId: string,
  projectId: string
): Promise<ProjectRepository | null> {
  const [row] = await db
    .select()
    .from(projectRepositories)
    .where(
      and(eq(projectRepositories.projectId, projectId), eq(projectRepositories.userId, userId))
    )
    .limit(1);
  return row ?? null;
}

export interface BindRepositoryInput {
  location: 'server';
  defaultBaseRef?: string;
  branchPrefix?: string;
  cleanupPolicy?: 'manual' | 'after_merge';
}

export async function bindProjectRepository(
  userId: string,
  projectId: string,
  input: BindRepositoryInput
): Promise<ProjectRepository> {
  const [project] = await db
    .select({ id: projects.id, kind: projects.kind })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  if (!project) throw notFound('Project not found');
  if (project.kind === 'default') {
    throw badRequest('default_project', 'The default project cannot enable code execution');
  }

  const baseRef = input.defaultBaseRef?.trim() || 'main';
  const rootPath = storage.projectWorkspace(userId, projectId);
  const info = await localGitDriver
    .inspectRepository({ rootPath, baseRef })
    .catch(rethrowGitError);

  const values = {
    location: 'server' as const,
    defaultBaseRef: baseRef,
    branchPrefix: input.branchPrefix?.trim() || 'swarmdev',
    cleanupPolicy: input.cleanupPolicy ?? ('manual' as const),
    repositoryFingerprint: info.fingerprint,
    updatedAt: new Date(),
  };

  const existing = await getProjectRepository(userId, projectId);
  if (existing) {
    const [updated] = await db
      .update(projectRepositories)
      .set(values)
      .where(eq(projectRepositories.id, existing.id))
      .returning();
    return updated!;
  }
  const [created] = await db
    .insert(projectRepositories)
    .values({ userId, projectId, ...values })
    .returning();
  return created!;
}

export interface RepositoryInspection {
  valid: boolean;
  error?: string;
  root?: string;
  baseRef?: string;
  baseCommit?: string;
  currentBranch?: string | null;
  dirty?: boolean;
}

export async function inspectProjectRepository(
  userId: string,
  projectId: string
): Promise<RepositoryInspection> {
  const repository = await getProjectRepository(userId, projectId);
  if (!repository) throw notFound('Project has no repository binding');
  try {
    const info = await localGitDriver.inspectRepository({
      rootPath: repositoryRoot(userId, repository),
      baseRef: repository.defaultBaseRef,
    });
    return {
      valid: true,
      root: info.root,
      baseRef: info.baseRef,
      baseCommit: info.baseCommit,
      currentBranch: info.currentBranch,
      dirty: info.dirty,
    };
  } catch (err) {
    if (err instanceof GitDriverError) return { valid: false, error: err.message };
    throw err;
  }
}

export async function unbindProjectRepository(userId: string, projectId: string): Promise<void> {
  const repository = await getProjectRepository(userId, projectId);
  if (!repository) throw notFound('Project has no repository binding');
  const [active] = await db
    .select({ id: executionWorkspaces.id })
    .from(executionWorkspaces)
    .where(
      and(
        eq(executionWorkspaces.repositoryId, repository.id),
        notInArray(executionWorkspaces.status, TERMINALS)
      )
    )
    .limit(1);
  if (active) {
    throw conflict(
      'workspace_active',
      'Merge, keep, or abandon the active issue workspaces before unbinding the repository'
    );
  }
  await db.delete(projectRepositories).where(eq(projectRepositories.id, repository.id));
}

export async function getIssueWorkspace(
  userId: string,
  issueId: string
): Promise<ExecutionWorkspace | null> {
  const [row] = await db
    .select()
    .from(executionWorkspaces)
    .where(
      and(
        eq(executionWorkspaces.issueId, issueId),
        eq(executionWorkspaces.userId, userId),
        notInArray(executionWorkspaces.status, TERMINALS)
      )
    )
    .limit(1);
  return row ?? null;
}

export async function hasActiveWorkspaces(
  scope: { issueId: string } | { projectId: string }
): Promise<boolean> {
  const filter =
    'issueId' in scope
      ? eq(executionWorkspaces.issueId, scope.issueId)
      : eq(executionWorkspaces.projectId, scope.projectId);
  const [row] = await db
    .select({ id: executionWorkspaces.id })
    .from(executionWorkspaces)
    .where(and(filter, notInArray(executionWorkspaces.status, TERMINALS)))
    .limit(1);
  return row !== undefined;
}

async function updateWorkspace(
  id: string,
  patch: Partial<typeof executionWorkspaces.$inferInsert>
): Promise<ExecutionWorkspace> {
  const [row] = await db
    .update(executionWorkspaces)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(executionWorkspaces.id, id))
    .returning();
  return row!;
}

/** Once cumulative changes existed, a later zero-change observation never resets to ready. */
function ratchetStatus(
  current: ExecutionWorkspace['status'],
  observed: 'ready' | 'dirty'
): 'ready' | 'dirty' {
  return current === 'dirty' && observed === 'ready' ? 'dirty' : observed;
}

export interface ResolvedWorkspace {
  workspace: ExecutionWorkspace;
  repository: ProjectRepository;
}

/**
 * The single entry point for run admission: no repository binding means no
 * code workspace (legacy shared project workspace behavior); a binding means
 * the issue gets its isolated worktree, created or reused idempotently.
 */
export async function resolveExecutionWorkspace(
  userId: string,
  issue: Issue
): Promise<ResolvedWorkspace | null> {
  const repository = await getProjectRepository(userId, issue.projectId);
  if (!repository) return null;
  const workspace = await prepareIssueWorkspace(userId, issue, repository);
  if (workspace.status !== 'ready' && workspace.status !== 'dirty') {
    throw conflict(
      'workspace_unavailable',
      workspace.lastError ?? `Issue workspace is ${workspace.status}; reconcile it before running`
    );
  }
  return { workspace, repository };
}

export async function prepareIssueWorkspace(
  userId: string,
  issue: Issue,
  boundRepository?: ProjectRepository
): Promise<ExecutionWorkspace> {
  const repository =
    boundRepository ?? (await getProjectRepository(userId, issue.projectId)) ?? undefined;
  if (!repository) throw notFound('Project has no repository binding');
  const root = repositoryRoot(userId, repository);
  const worktreesRoot = storage.projectWorktreesRoot(userId, issue.projectId);

  let row = await getIssueWorkspace(userId, issue.id);
  if (!row) {
    const branchName = issueBranchName(repository.branchPrefix, issue.issueNumber, issue.id);
    const info = await localGitDriver
      .inspectRepository({ rootPath: root, baseRef: repository.defaultBaseRef })
      .catch(rethrowGitError);
    try {
      const [created] = await db
        .insert(executionWorkspaces)
        .values({
          userId,
          projectId: issue.projectId,
          issueId: issue.id,
          repositoryId: repository.id,
          location: 'server',
          worktreePath: path.join(worktreesRoot, issue.id),
          branchName,
          baseRef: repository.defaultBaseRef,
          baseCommit: info.baseCommit,
          status: 'preparing',
        })
        .returning();
      row = created!;
    } catch (err) {
      // Lost the partial-unique-index race; adopt the winner's row.
      const code = (err as { code?: string; cause?: { code?: string } }).code ??
        (err as { cause?: { code?: string } }).cause?.code;
      if (code !== '23505') throw err;
      row = await getIssueWorkspace(userId, issue.id);
      if (!row) throw err;
    }
  }

  try {
    // The row's baseCommit is the immutable creation point: the worktree is
    // created exactly there, and reuse measures changes against it.
    const prepared = await localGitDriver.prepareWorkspace({
      repositoryRoot: root,
      worktreesRoot,
      issueId: issue.id,
      branchName: row.branchName,
      baseRef: row.baseRef,
      baseCommit: row.baseCommit,
    });
    if (prepared.state === 'error' || prepared.state === 'missing') {
      return updateWorkspace(row.id, {
        status: prepared.state,
        lastError: prepared.error,
      });
    }
    return updateWorkspace(row.id, {
      status: ratchetStatus(row.status, prepared.state),
      worktreePath: prepared.worktreePath,
      headCommit: prepared.headCommit,
      preparedAt: row.preparedAt ?? new Date(),
      lastError: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Workspace preparation failed';
    await updateWorkspace(row.id, { status: 'error', lastError: message });
    rethrowGitError(err);
  }
}

export async function reconcileIssueWorkspace(
  userId: string,
  issueId: string
): Promise<ExecutionWorkspace> {
  const row = await getIssueWorkspace(userId, issueId);
  if (!row) throw notFound('Issue has no active workspace');
  const repository = await getProjectRepository(userId, row.projectId);
  if (!repository) throw conflict('repository_unbound', 'The project repository binding is gone');

  const result = await localGitDriver
    .reconcileWorkspace({
      repositoryRoot: repositoryRoot(userId, repository),
      worktreePath: row.worktreePath,
      branchName: row.branchName,
      baseCommit: row.baseCommit,
    })
    .catch(rethrowGitError);

  if (result.state === 'missing') {
    return updateWorkspace(row.id, { status: 'missing', lastError: null });
  }
  if (result.state === 'error') {
    return updateWorkspace(row.id, { status: 'error', lastError: result.error });
  }
  return updateWorkspace(row.id, {
    status: ratchetStatus(row.status, result.state),
    headCommit: result.headCommit,
    lastError: null,
  });
}

export async function snapshotBeforeRun(
  workspace: ExecutionWorkspace
): Promise<WorkingTreeSnapshot> {
  return localGitDriver.snapshotWorkingTree({ worktreePath: workspace.worktreePath });
}

export interface CaptureRunInput {
  runId: string;
  userId: string;
  workspace: ExecutionWorkspace;
  before: WorkingTreeSnapshot;
  permission: TurnPermission;
}

export interface CaptureRunResult {
  snapshot: RunChangeSnapshot;
  policyViolation: boolean;
}

/**
 * Platform-collected evidence after a run settles, regardless of outcome.
 * Agent-authored summaries are never treated as proof.
 */
export async function captureRunChanges(input: CaptureRunInput): Promise<CaptureRunResult> {
  const captured = await localGitDriver.captureChanges({
    worktreePath: input.workspace.worktreePath,
    beforeHead: input.before.head,
    baseCommit: input.workspace.baseCommit,
  });

  let patchStorageKey: string | null = null;
  if (captured.patch.length > 0) {
    const dir = storage.projectCodeArtifacts(input.userId, input.workspace.projectId, input.runId);
    const target = path.join(dir, 'changes.patch');
    fs.writeFileSync(target, captured.patch);
    patchStorageKey = target;
  }

  const policyViolation = input.permission === 'read_only' && captured.trackedChanges;
  const [snapshot] = await db
    .insert(runChangeSnapshots)
    .values({
      runId: input.runId,
      executionWorkspaceId: input.workspace.id,
      beforeHead: input.before.head,
      afterHead: captured.afterHead,
      changedFiles: captured.changedFiles,
      additions: captured.additions,
      deletions: captured.deletions,
      beforeSummaryJson: input.before.summary,
      afterSummaryJson: captured.summary,
      changeFingerprint: captured.fingerprint,
      patchStorageKey,
      patchTruncated: captured.patchTruncated,
      policyViolation,
    })
    .returning();

  const hasChanges = captured.afterHead !== input.workspace.baseCommit || captured.changedFiles > 0;
  await updateWorkspace(input.workspace.id, {
    status: ratchetStatus(input.workspace.status, hasChanges ? 'dirty' : 'ready'),
    headCommit: captured.afterHead,
    lastRunId: input.runId,
  });

  return { snapshot: snapshot!, policyViolation };
}

/** Latest platform-captured snapshot for the issue's active workspace; approval binds to it. */
export async function latestIssueSnapshot(
  userId: string,
  issueId: string
): Promise<RunChangeSnapshot | null> {
  const workspace = await getIssueWorkspace(userId, issueId);
  if (!workspace) return null;
  const [row] = await db
    .select()
    .from(runChangeSnapshots)
    .where(eq(runChangeSnapshots.executionWorkspaceId, workspace.id))
    .orderBy(desc(runChangeSnapshots.capturedAt))
    .limit(1);
  return row ?? null;
}

/** Operation ids of merges currently executing in this process; lock staleness is proven against it. */
const liveMergeOperations = new Set<string>();

/** Test seam: simulate a merge lock held by a live operation. */
export function registerLiveMergeOperationForTests(operationId: string): void {
  liveMergeOperations.add(operationId);
}

async function acquireMergeLock(
  repository: ProjectRepository,
  workspace: ExecutionWorkspace,
  preHead: string
): Promise<string> {
  const operationId = crypto.randomUUID();
  const [locked] = await db
    .update(projectRepositories)
    .set({
      activeMergeWorkspaceId: workspace.id,
      activeMergeOperationId: operationId,
      activeMergePreHead: preHead,
      activeMergeStartedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(projectRepositories.id, repository.id),
        isNull(projectRepositories.activeMergeWorkspaceId)
      )
    )
    .returning({ id: projectRepositories.id });
  if (!locked) {
    throw conflict('merge_in_progress', 'Another merge holds the repository lock');
  }
  liveMergeOperations.add(operationId);
  return operationId;
}

async function releaseMergeLock(repositoryId: string, operationId: string): Promise<void> {
  liveMergeOperations.delete(operationId);
  await db
    .update(projectRepositories)
    .set({
      activeMergeWorkspaceId: null,
      activeMergeOperationId: null,
      activeMergePreHead: null,
      activeMergeStartedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(projectRepositories.id, repositoryId),
        eq(projectRepositories.activeMergeOperationId, operationId)
      )
    );
}

/**
 * Stale-lock recovery: a lock is stale only when its operation id is not
 * live in this process; age alone never authorizes release. Every branch
 * proves the primary checkout's Git state before touching the lock.
 */
async function recoverStaleMergeLock(
  userId: string,
  repository: ProjectRepository
): Promise<ProjectRepository> {
  if (!repository.activeMergeWorkspaceId || !repository.activeMergeOperationId) return repository;
  if (liveMergeOperations.has(repository.activeMergeOperationId)) {
    throw conflict('merge_in_progress', 'Another merge holds the repository lock');
  }

  const root = repositoryRoot(userId, repository);
  const checkout = await localGitDriver.inspectPrimaryCheckout(root);
  const preHead = repository.activeMergePreHead;
  const [workspace] = await db
    .select()
    .from(executionWorkspaces)
    .where(eq(executionWorkspaces.id, repository.activeMergeWorkspaceId))
    .limit(1);

  const clearLock = async () => {
    await db
      .update(projectRepositories)
      .set({
        activeMergeWorkspaceId: null,
        activeMergeOperationId: null,
        activeMergePreHead: null,
        activeMergeStartedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(projectRepositories.id, repository.id));
    return (await getProjectRepository(userId, repository.projectId))!;
  };

  if (checkout.mergeHead === null && preHead !== null && checkout.head === preHead) {
    // The crashed merge never started or already aborted.
    return clearLock();
  }

  if (checkout.mergeHead === null && preHead !== null && checkout.head !== preHead) {
    // Possibly completed before the database update; prove it.
    const provable =
      checkout.clean &&
      checkout.branch === repository.defaultBaseRef &&
      workspace !== undefined &&
      workspace.headCommit !== null &&
      (await isAncestorIn(root, preHead, checkout.head)) &&
      (await isAncestorIn(root, workspace.headCommit, checkout.head));
    if (provable) {
      await updateWorkspace(workspace.id, { status: 'merged', mergedAt: new Date() });
      await moveIssue(userId, workspace.issueId, { status: 'done' }).catch(() => {});
      await addSystemComment(
        userId,
        workspace.issueId,
        'Merge recovered after an interruption: the base branch already contains this workspace.'
      ).catch(() => {});
      return clearLock();
    }
  }

  if (checkout.mergeHead !== null && preHead !== null) {
    // Abort only what is provably ours: on the base ref, ORIG_HEAD matches the
    // recorded pre-merge HEAD, and no live operation owns the merge.
    if (checkout.branch === repository.defaultBaseRef && checkout.origHead === preHead) {
      const merge = await localGitDriver.mergeAbortForRecovery(root, preHead);
      if (merge) {
        if (workspace) await updateWorkspace(workspace.id, { status: 'conflicted' });
        return clearLock();
      }
    }
  }

  if (workspace) {
    await updateWorkspace(workspace.id, {
      status: 'error',
      lastError: 'Merge lock recovery could not prove the primary checkout state; recover manually',
    });
  }
  throw conflict(
    'merge_recovery_failed',
    'A previous merge left the repository in an unprovable state; recover the primary checkout manually'
  );
}

async function isAncestorIn(root: string, ancestor: string, descendant: string): Promise<boolean> {
  return localGitDriver.isAncestor(root, ancestor, descendant);
}

export type FinalizeAction = 'merge' | 'keep_branch';

export interface FinalizeInput {
  action: FinalizeAction;
  /** User saw the uncommitted-change summary and approved a checkpoint commit. */
  confirmCheckpoint?: boolean;
}

export interface FinalizeResult {
  workspace: ExecutionWorkspace;
  issueStatus: string;
}

/**
 * Merge or keep-branch, per 9.5: requires an in-review issue whose latest
 * human approval still matches the workspace content fingerprint. Uncommitted
 * changes become a confirmed checkpoint commit that provably preserves the
 * approved fingerprint.
 */
export async function finalizeIssueWorkspace(
  userId: string,
  issueId: string,
  input: FinalizeInput
): Promise<FinalizeResult> {
  const workspace = await getIssueWorkspace(userId, issueId);
  if (!workspace) throw notFound('Issue has no active workspace');
  if (workspace.status !== 'ready' && workspace.status !== 'dirty') {
    throw conflict('workspace_unavailable', `Workspace is ${workspace.status}; reconcile it first`);
  }
  const [issue] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.userId, userId)))
    .limit(1);
  if (!issue) throw notFound('Issue not found');
  if (issue.status !== 'in_review') {
    throw conflict('not_in_review', 'Finalization requires the issue to be in review');
  }
  let repository = await getProjectRepository(userId, workspace.projectId);
  if (!repository) throw conflict('repository_unbound', 'The project repository binding is gone');

  const approval = await latestHumanApproval(userId, issueId);
  if (!approval?.snapshot) {
    throw conflict('approval_required', 'A human approval bound to a change snapshot is required');
  }

  const root = repositoryRoot(userId, repository);
  const recapture = () =>
    localGitDriver.captureChanges({
      worktreePath: workspace.worktreePath,
      beforeHead: workspace.baseCommit,
      baseCommit: workspace.baseCommit,
    });

  let current = await recapture().catch(rethrowGitError);
  if (current.fingerprint !== approval.snapshot.changeFingerprint) {
    throw conflict(
      'stale_approval',
      'The workspace changed after approval; request a new review before finalizing'
    );
  }

  // Git merge cannot carry uncommitted worktree changes; they become a
  // confirmed checkpoint commit that must preserve the approved fingerprint.
  const uncommitted =
    current.summary.files.length > 0 || current.summary.untracked.length > 0
      ? await localGitDriver
          .snapshotWorkingTree({ worktreePath: workspace.worktreePath })
          .then((s) => s.summary.files.length > 0 || s.summary.untracked.length > 0)
      : false;
  if (uncommitted) {
    if (!input.confirmCheckpoint) {
      throw conflict(
        'checkpoint_required',
        'Uncommitted changes need a confirmed checkpoint commit before finalizing'
      );
    }
    await localGitDriver
      .commitCheckpoint({
        worktreePath: workspace.worktreePath,
        message: `Issue #${issue.issueNumber}: ${issue.title}`,
      })
      .catch(rethrowGitError);
    current = await recapture().catch(rethrowGitError);
    if (current.fingerprint !== approval.snapshot.changeFingerprint) {
      throw conflict(
        'checkpoint_mismatch',
        'The checkpoint commit altered the approved content; finalization aborted'
      );
    }
  }

  if (input.action === 'keep_branch') {
    await localGitDriver
      .removeWorkspace({ repositoryRoot: root, worktreePath: workspace.worktreePath })
      .catch(rethrowGitError);
    const updated = await updateWorkspace(workspace.id, {
      status: 'retained',
      headCommit: current.afterHead,
      retainedAt: new Date(),
    });
    const moved = await moveIssue(userId, issueId, { status: 'done' });
    await addSystemComment(
      userId,
      issueId,
      `Branch ${workspace.branchName} retained; the managed worktree was removed.`
    ).catch(() => {});
    return { workspace: updated, issueStatus: moved.status };
  }

  // Merge path: serialize base-checkout mutation with the repository lock,
  // recovering a provably stale one first.
  if (repository.activeMergeWorkspaceId) {
    repository = await recoverStaleMergeLock(userId, repository);
  }
  const checkout = await localGitDriver.inspectPrimaryCheckout(root);
  const operationId = await acquireMergeLock(repository, workspace, checkout.head);
  try {
    const outcome = await localGitDriver
      .mergeWorkspace({
        repositoryRoot: root,
        baseRef: repository.defaultBaseRef,
        branchName: workspace.branchName,
        message: `Merge issue #${issue.issueNumber}: ${issue.title}`,
      })
      .catch(rethrowGitError);

    if (outcome.result === 'merged') {
      await localGitDriver
        .removeWorkspace({ repositoryRoot: root, worktreePath: workspace.worktreePath })
        .catch((err) => {
          console.error(`Worktree cleanup after merge failed for ${workspace.id}:`, err);
        });
      const updated = await updateWorkspace(workspace.id, {
        status: 'merged',
        headCommit: current.afterHead,
        mergedAt: new Date(),
      });
      const moved = await moveIssue(userId, issueId, { status: 'done' });
      await addSystemComment(
        userId,
        issueId,
        `Merged ${workspace.branchName} into ${repository.defaultBaseRef} (${outcome.newHead.slice(0, 12)}).`
      ).catch(() => {});
      return { workspace: updated, issueStatus: moved.status };
    }

    if (outcome.result === 'conflicted') {
      const updated = await updateWorkspace(workspace.id, {
        status: 'conflicted',
        lastError: `Merge into ${repository.defaultBaseRef} conflicted; the base checkout was restored`,
      });
      await addSystemComment(
        userId,
        issueId,
        `Merge of ${workspace.branchName} conflicted; the base checkout was restored and the issue stays in review.`
      ).catch(() => {});
      return { workspace: updated, issueStatus: issue.status };
    }

    // abort_failed: keep the lock for manual recovery evidence, mark error.
    liveMergeOperations.delete(operationId);
    await updateWorkspace(workspace.id, { status: 'error', lastError: outcome.error });
    throw conflict('merge_recovery_failed', outcome.error);
  } finally {
    if (liveMergeOperations.has(operationId)) {
      await releaseMergeLock(repository.id, operationId);
    }
  }
}

export interface AbandonInput {
  /** User explicitly accepted the loss of uncommitted changes. */
  confirmDiscard?: boolean;
}

/**
 * Explicit abandon: discards the managed worktree and cancels an active
 * issue. Cleanup must succeed before any state transitions; done issues
 * cannot be abandoned.
 */
export async function abandonIssueWorkspace(
  userId: string,
  issueId: string,
  input: AbandonInput
): Promise<FinalizeResult> {
  const workspace = await getIssueWorkspace(userId, issueId);
  if (!workspace) throw notFound('Issue has no active workspace');
  const [issue] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.userId, userId)))
    .limit(1);
  if (!issue) throw notFound('Issue not found');
  if (issue.status === 'done') {
    throw conflict('issue_done', 'A completed issue cannot abandon its workspace');
  }
  const repository = await getProjectRepository(userId, workspace.projectId);
  if (!repository) throw conflict('repository_unbound', 'The project repository binding is gone');

  try {
    await localGitDriver.removeWorkspace({
      repositoryRoot: repositoryRoot(userId, repository),
      worktreePath: workspace.worktreePath,
      allowDirty: input.confirmDiscard === true,
    });
  } catch (err) {
    if (err instanceof GitDriverError && err.code === 'dirty_workspace') {
      throw conflict(
        'discard_confirmation_required',
        'The workspace has uncommitted changes; confirm that they may be discarded'
      );
    }
    rethrowGitError(err);
  }

  const updated = await updateWorkspace(workspace.id, {
    status: 'abandoned',
    abandonedAt: new Date(),
  });
  let issueStatus: string = issue.status;
  if (issue.status !== 'cancelled') {
    const moved = await moveIssue(userId, issueId, { status: 'cancelled' });
    issueStatus = moved.status;
  }
  await addSystemComment(
    userId,
    issueId,
    `Workspace abandoned; branch ${workspace.branchName} and its worktree were discarded from management.`
  ).catch(() => {});
  return { workspace: updated, issueStatus };
}

async function latestHumanApproval(
  userId: string,
  issueId: string
): Promise<{ reviewId: string; snapshot: RunChangeSnapshot | null } | null> {
  const [review] = await db
    .select()
    .from(issueReviews)
    .where(
      and(
        eq(issueReviews.issueId, issueId),
        eq(issueReviews.userId, userId),
        eq(issueReviews.reviewerType, 'human'),
        eq(issueReviews.decision, 'approved')
      )
    )
    .orderBy(desc(issueReviews.createdAt))
    .limit(1);
  if (!review) return null;
  if (!review.changeSnapshotId) return { reviewId: review.id, snapshot: null };
  const [snapshot] = await db
    .select()
    .from(runChangeSnapshots)
    .where(eq(runChangeSnapshots.id, review.changeSnapshotId))
    .limit(1);
  return { reviewId: review.id, snapshot: snapshot ?? null };
}

export interface IssueChangesView {
  workspace: ExecutionWorkspace;
  snapshot: RunChangeSnapshot | null;
  drift: BaseDriftReport | null;
}

export async function getIssueChanges(userId: string, issueId: string): Promise<IssueChangesView> {
  const workspace = await getIssueWorkspace(userId, issueId);
  if (!workspace) throw notFound('Issue has no active workspace');
  const snapshot = await latestIssueSnapshot(userId, issueId);
  const repository = await getProjectRepository(userId, workspace.projectId);

  let drift: BaseDriftReport | null = null;
  if (repository && (workspace.status === 'ready' || workspace.status === 'dirty')) {
    drift = await localGitDriver
      .reportBaseDrift({
        repositoryRoot: repositoryRoot(userId, repository),
        baseRef: workspace.baseRef,
        baseCommit: workspace.baseCommit,
        branchName: workspace.branchName,
      })
      .catch(() => null);
  }
  return { workspace, snapshot, drift };
}
