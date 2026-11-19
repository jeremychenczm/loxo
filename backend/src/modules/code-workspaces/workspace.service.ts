import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { and, desc, eq, inArray, isNull, lte, notInArray, or, sql } from 'drizzle-orm';
import { db, type Executor, type Tx } from '../../db/client';
import {
  WORKSPACE_TERMINAL_STATUSES,
  workspaces,
  approvals,
  tasks,
  repositories,
  changeSnapshots,
  runs,
  type Workspace,
  type Task,
  type Repository,
  type ChangeSnapshot,
} from '../../db/schema';
import { badRequest, conflict, notFound } from '../../http/errors';
import { storage } from '../../storage/layout';
import { addSystemTurn } from '../tasks/turns.service';
import { config } from '../../config';
import { crashPoint } from '../ownership/crash-points';
import { fence } from '../ownership/fence';
import { runLeases } from '../ownership/lease';
import { recordBeforeState, TASK_GATE_STATUSES, type RunOwner } from '../runs/runs.service';
import { moveTask } from '../tasks/tasks.service';
import type { TurnPermission } from '../runner/runner';
import { runBeforeRef, workspaceBranchName, workspaceLeaf } from './branch-name';
import { localGitDriver } from './local-git-driver';
import {
  GitDriverError,
  type BaseDriftReport,
  type WorkingTreeSnapshot,
} from './workspace.types';

const TERMINALS = [...WORKSPACE_TERMINAL_STATUSES];

/** Translates driver failures into client-visible errors at the API boundary. */
export function rethrowGitError(err: unknown): never {
  if (err instanceof GitDriverError) {
    throw badRequest(err.code, err.message);
  }
  throw err;
}

/** Repository row by id, scoped to its owner; null when the task has none or it was removed. */
export async function findRepository(
  userId: string,
  repositoryId: string | null
): Promise<Repository | null> {
  if (!repositoryId) return null;
  const [row] = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.id, repositoryId), eq(repositories.userId, userId)))
    .limit(1);
  return row ?? null;
}

/** The task's active integration workspace: the branch that gets delivered. */
export async function getTaskWorkspace(
  userId: string,
  taskId: string
): Promise<Workspace | null> {
  const [row] = await db
    .select()
    .from(workspaces)
    .where(
      and(
        eq(workspaces.taskId, taskId),
        eq(workspaces.userId, userId),
        eq(workspaces.kind, 'integration'),
        notInArray(workspaces.status, TERMINALS)
      )
    )
    .limit(1);
  return row ?? null;
}

export async function hasActiveWorkspaces(
  scope: { taskId: string } | { repositoryId: string }
): Promise<boolean> {
  const filter =
    'taskId' in scope
      ? eq(workspaces.taskId, scope.taskId)
      : eq(workspaces.repositoryId, scope.repositoryId);
  const [row] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(filter, notInArray(workspaces.status, TERMINALS)))
    .limit(1);
  return row !== undefined;
}

async function updateWorkspace(
  id: string,
  patch: Partial<typeof workspaces.$inferInsert>,
  ex: Executor = db
): Promise<Workspace> {
  const [row] = await ex
    .update(workspaces)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(workspaces.id, id))
    .returning();
  return row!;
}

/** Once cumulative changes existed, a later zero-change observation never resets to ready. */
function ratchetStatus(
  current: Workspace['status'],
  observed: 'ready' | 'dirty'
): 'ready' | 'dirty' {
  return current === 'dirty' && observed === 'ready' ? 'dirty' : observed;
}

/**
 * Merging or deleting a worktree under a running agent would race its
 * writes; under an interrupted run it would preempt the pending decision.
 */
async function assertNoRunningRun(taskId: string): Promise<void> {
  const [active] = await db
    .select({ status: runs.status })
    .from(runs)
    .where(and(eq(runs.taskId, taskId), inArray(runs.status, [...TASK_GATE_STATUSES])))
    .limit(1);
  if (active?.status === 'interrupted') {
    throw conflict('run_interrupted', 'An interrupted run is waiting for a decision; answer its retry request first');
  }
  if (active) {
    throw conflict('run_in_progress', 'An agent run is working on this task; wait for it to finish');
  }
}

async function hasInterruptedRun(taskId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.taskId, taskId), eq(runs.status, 'interrupted')))
    .limit(1);
  return row !== undefined;
}

export interface ResolvedWorkspace {
  workspace: Workspace;
  repository: Repository;
}

/**
 * The single entry point for run admission: a task without a repository has
 * no code workspace; a task with one gets its isolated worktree, created or
 * reused idempotently.
 */
export async function resolveWorkspace(
  userId: string,
  task: Task
): Promise<ResolvedWorkspace | null> {
  const repository = await findRepository(userId, task.repositoryId);
  if (!repository) return null;
  const workspace = await prepareTaskWorkspace(userId, task, repository);
  if (workspace.status !== 'ready' && workspace.status !== 'dirty') {
    throw conflict(
      'workspace_unavailable',
      workspace.lastError ?? `Task workspace is ${workspace.status}; reconcile it before running`
    );
  }
  return { workspace, repository };
}

export async function prepareTaskWorkspace(
  userId: string,
  task: Task,
  boundRepository?: Repository
): Promise<Workspace> {
  const repository = boundRepository ?? (await findRepository(userId, task.repositoryId));
  if (!repository) throw notFound('Task has no repository');
  const root = repository.rootPath;
  const worktreesRoot = storage.worktreesRoot(userId);

  let row = await getTaskWorkspace(userId, task.id);
  // Never lifted by preparing a run: the writer that lost its owner may still be running.
  if (row?.status === 'quarantined') return row;
  if (!row) {
    const branchName = workspaceBranchName(task.number, null);
    const info = await localGitDriver
      .inspectRepository({ rootPath: root, baseRef: repository.defaultBranch })
      .catch(rethrowGitError);
    try {
      const [created] = await db
        .insert(workspaces)
        .values({
          userId,
          taskId: task.id,
          repositoryId: repository.id,
          kind: 'integration',
          worktreePath: path.join(worktreesRoot, workspaceLeaf(task.id, 'integration', null)),
          branchName,
          baseRef: repository.defaultBranch,
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
      row = await getTaskWorkspace(userId, task.id);
      if (!row) throw err;
    }
  }

  try {
    // The row's baseCommit is the immutable creation point: the worktree is
    // created exactly there, and reuse measures changes against it.
    const prepared = await localGitDriver.prepareWorkspace({
      repositoryRoot: root,
      worktreesRoot,
      leaf: workspaceLeaf(task.id, 'integration', null),
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

export async function reconcileTaskWorkspace(
  userId: string,
  taskId: string
): Promise<Workspace> {
  const row = await getTaskWorkspace(userId, taskId);
  if (!row) throw notFound('Task has no active workspace');
  // Lifting this quarantine is the retry decision's job.
  if (row.status === 'quarantined' && (await hasInterruptedRun(taskId))) {
    throw conflict('run_interrupted', 'An interrupted run is waiting for a decision; answer its retry request first');
  }
  const repository = await findRepository(userId, row.repositoryId);
  if (!repository) throw conflict('repository_removed', 'The task repository was removed');

  const result = await localGitDriver
    .reconcileWorkspace({
      repositoryRoot: repository.rootPath,
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

/**
 * The worktree as the run found it: the summary change snapshots report
 * against, plus a ref pinning the full content (untracked files included)
 * for recovery to compare with or restore. Git first, then the fenced row
 * update; an owner that dies between the two leaves a ref the run never
 * recorded, and recovery treats the before-state as unknown.
 */
export async function snapshotBeforeRun(
  owner: RunOwner,
  workspace: Workspace
): Promise<WorkingTreeSnapshot> {
  const snapshot = await localGitDriver.snapshotWorkingTree({ worktreePath: workspace.worktreePath });
  const pinned = await localGitDriver.writeBeforeRef({
    worktreePath: workspace.worktreePath,
    ref: runBeforeRef(owner.runId),
    message: `Before-state of run ${owner.runId}`,
  });
  crashPoint('run.after_before_ref');
  await recordBeforeState(owner, pinned);
  return snapshot;
}

/** Before-state refs outlive the worktree (refs are repository-wide); drop them with it. */
async function dropBeforeRefs(repositoryRoot: string, taskId: string): Promise<void> {
  const rows = await db.select({ id: runs.id }).from(runs).where(eq(runs.taskId, taskId));
  await localGitDriver
    .deleteManagedRefs(repositoryRoot, rows.map((r) => runBeforeRef(r.id)))
    .catch((err) => console.error(`Dropping run before-state refs failed for task ${taskId}:`, err));
}

export interface CaptureRunInput {
  runId: string;
  /** The owner the capture is written as; a run that has moved on refuses it. */
  epoch: number;
  instance: string;
  userId: string;
  workspace: Workspace;
  before: WorkingTreeSnapshot;
  permission: TurnPermission;
  /** Further writes that belong to the capture; they run inside its fenced transaction. */
  onCaptured?: (tx: Tx, result: CaptureRunResult) => Promise<void>;
}

export interface CaptureRunResult {
  snapshot: ChangeSnapshot;
  policyViolation: boolean;
}

/**
 * Platform-collected evidence after a run settles, regardless of outcome.
 * Agent-authored summaries are never treated as proof. Git and file work
 * happens first; the rows are then written in one transaction fenced on the
 * run, so a capture from an owner that lost the run is refused (FencedError)
 * and leaves no snapshot or workspace change. A refused capture may leave its
 * patch file in the run's artifact directory.
 */
export async function captureRunChanges(input: CaptureRunInput): Promise<CaptureRunResult> {
  const captured = await localGitDriver.captureChanges({
    worktreePath: input.workspace.worktreePath,
    beforeHead: input.before.head,
    baseCommit: input.workspace.baseCommit,
  });

  let patchStorageKey: string | null = null;
  if (captured.patch.length > 0) {
    const dir = storage.runArtifacts(input.userId, input.runId);
    const target = path.join(dir, 'changes.patch');
    fs.writeFileSync(target, captured.patch);
    patchStorageKey = target;
  }

  const policyViolation = input.permission === 'read_only' && captured.trackedChanges;
  const hasChanges = captured.afterHead !== input.workspace.baseCommit || captured.changedFiles > 0;
  return db.transaction(async (tx) => {
    await fence(tx, { runId: input.runId, epoch: input.epoch, instance: input.instance }, 'change_capture');
    const [snapshot] = await tx
    .insert(changeSnapshots)
    .values({
      runId: input.runId,
      epoch: input.epoch,
      workspaceId: input.workspace.id,
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

    await updateWorkspace(
      input.workspace.id,
      {
        status: ratchetStatus(input.workspace.status, hasChanges ? 'dirty' : 'ready'),
        headCommit: captured.afterHead,
        lastRunId: input.runId,
      },
      tx
    );
    const result = { snapshot: snapshot!, policyViolation };
    await input.onCaptured?.(tx, result);
    return result;
  });
}

/** What recovery found in the worktree of a run that lost its owner. */
export interface RecoveryInspection {
  /** unknown: the run could write but never recorded a before-state to compare with. */
  worktree: 'unchanged' | 'changed' | 'unknown';
  /** Snapshot columns, ready to insert under the recoverer's fence; null when Git could not read the worktree. */
  snapshot: Omit<typeof changeSnapshots.$inferInsert, 'runId' | 'epoch' | 'kind'> | null;
}

/**
 * Compares the worktree with the run's before-state and captures what is
 * there now, outside any transaction. A worktree Git cannot read counts as
 * changed, since nothing proves otherwise. A run that cannot write and has
 * no before-state counts as unchanged.
 */
export async function inspectWorktreeForRecovery(
  run: { id: string; userId: string; beforeHead: string | null; beforeTree: string | null },
  workspace: Workspace,
  couldWrite: boolean
): Promise<RecoveryInspection> {
  try {
    let worktree: RecoveryInspection['worktree'];
    if (run.beforeHead && run.beforeTree) {
      const now = await localGitDriver.snapshotTree(workspace.worktreePath);
      worktree = now.head === run.beforeHead && now.tree === run.beforeTree ? 'unchanged' : 'changed';
    } else {
      worktree = couldWrite ? 'unknown' : 'unchanged';
    }
    const beforeHead = run.beforeHead ?? workspace.baseCommit;
    const captured = await localGitDriver.captureChanges({
      worktreePath: workspace.worktreePath,
      beforeHead,
      baseCommit: workspace.baseCommit,
    });
    let patchStorageKey: string | null = null;
    if (captured.patch.length > 0) {
      patchStorageKey = path.join(storage.runArtifacts(run.userId, run.id), 'recovery.patch');
      fs.writeFileSync(patchStorageKey, captured.patch);
    }
    return {
      worktree,
      snapshot: {
        workspaceId: workspace.id,
        beforeHead,
        afterHead: captured.afterHead,
        changedFiles: captured.changedFiles,
        additions: captured.additions,
        deletions: captured.deletions,
        afterSummaryJson: captured.summary,
        changeFingerprint: captured.fingerprint,
        patchStorageKey,
        patchTruncated: captured.patchTruncated,
        policyViolation: !couldWrite && captured.trackedChanges,
      },
    };
  } catch (err) {
    console.error(`Recovery could not read the worktree of run ${run.id}:`, err);
    return { worktree: 'changed', snapshot: null };
  }
}

export interface ObservedWorkspace {
  status: 'ready' | 'dirty' | 'missing' | 'error';
  headCommit: string | null;
  lastError: string | null;
}

/**
 * Git side of a retry decision, run before the decision commits and safe to
 * repeat: with `discardTo` the worktree first goes back to the run's
 * before-state. Returns what the workspace looks like afterwards.
 */
export async function settleWorkspaceForDecision(
  userId: string,
  workspace: Workspace,
  discardTo: { head: string; tree: string } | null
): Promise<ObservedWorkspace> {
  const repository = await findRepository(userId, workspace.repositoryId);
  if (!repository) throw conflict('repository_removed', 'The task repository was removed');
  if (discardTo) {
    await localGitDriver.restoreTree({ worktreePath: workspace.worktreePath, ...discardTo }).catch(rethrowGitError);
  }
  const result = await localGitDriver
    .reconcileWorkspace({
      repositoryRoot: repository.rootPath,
      worktreePath: workspace.worktreePath,
      branchName: workspace.branchName,
      baseCommit: workspace.baseCommit,
    })
    .catch(rethrowGitError);
  return { status: result.state, headCommit: result.headCommit, lastError: result.error };
}

/** Releases a quarantined workspace in the observed state; a no-op once it left quarantine. */
export async function leaveQuarantine(tx: Tx, workspaceId: string, observed: ObservedWorkspace): Promise<void> {
  await tx
    .update(workspaces)
    .set({ ...observed, updatedAt: new Date() })
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.status, 'quarantined')));
}

/** Latest platform-captured snapshot for the task's active workspace; approval binds to it. */
export async function latestTaskSnapshot(
  userId: string,
  taskId: string
): Promise<ChangeSnapshot | null> {
  const workspace = await getTaskWorkspace(userId, taskId);
  if (!workspace) return null;
  const [row] = await db
    .select()
    .from(changeSnapshots)
    .where(eq(changeSnapshots.workspaceId, workspace.id))
    .orderBy(desc(changeSnapshots.capturedAt))
    .limit(1);
  return row ?? null;
}

let mergeLockTtlMs = config.runLeaseTtlMs;

/** Test seam: shorten the merge lock lease. */
export function setMergeLockTtlForTests(ms: number | null): void {
  mergeLockTtlMs = ms ?? config.runLeaseTtlMs;
}

const leaseFromNow = () => sql`clock_timestamp() + ${mergeLockTtlMs}::integer * interval '1 millisecond'`;

const CLEARED_LOCK = {
  activeMergeWorkspaceId: null,
  activeMergeOperationId: null,
  activeMergePreHead: null,
  activeMergeStartedAt: null,
  activeMergeOwnerInstance: null,
  activeMergeLeaseExpiresAt: null,
} as const;

/** A merge lock this instance holds; its lease is renewed until it is released or abandoned. */
interface HeldMergeLock {
  repositoryId: string;
  operationId: string;
  stopRenewing(): void;
}

function renewMergeLock(repositoryId: string, operationId: string): () => void {
  const timer = setInterval(() => {
    db.update(repositories)
      .set({ activeMergeLeaseExpiresAt: sql`GREATEST(${repositories.activeMergeLeaseExpiresAt}, ${leaseFromNow()})` })
      .where(and(eq(repositories.id, repositoryId), eq(repositories.activeMergeOperationId, operationId)))
      .catch((err) => console.error(`Merge lock renewal for ${repositoryId} failed:`, err));
  }, Math.max(50, Math.floor(mergeLockTtlMs / 3)));
  timer.unref();
  return () => clearInterval(timer);
}

async function acquireMergeLock(
  repository: Repository,
  workspace: Workspace,
  preHead: string
): Promise<HeldMergeLock> {
  const operationId = crypto.randomUUID();
  const [locked] = await db
    .update(repositories)
    .set({
      activeMergeWorkspaceId: workspace.id,
      activeMergeOperationId: operationId,
      activeMergePreHead: preHead,
      activeMergeStartedAt: new Date(),
      activeMergeOwnerInstance: runLeases.instance,
      activeMergeLeaseExpiresAt: leaseFromNow(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(repositories.id, repository.id),
        isNull(repositories.activeMergeWorkspaceId)
      )
    )
    .returning({ id: repositories.id });
  if (!locked) {
    throw conflict('merge_in_progress', 'Another merge holds the repository lock');
  }
  return { repositoryId: repository.id, operationId, stopRenewing: renewMergeLock(repository.id, operationId) };
}

async function releaseMergeLock(lock: HeldMergeLock): Promise<void> {
  lock.stopRenewing();
  await db
    .update(repositories)
    .set({ ...CLEARED_LOCK, updatedAt: new Date() })
    .where(
      and(
        eq(repositories.id, lock.repositoryId),
        eq(repositories.activeMergeOperationId, lock.operationId)
      )
    );
}

/**
 * Keeps the lock row as evidence for manual recovery but lets its lease lapse
 * now, so the next attempt examines it instead of waiting out the lease.
 */
async function abandonMergeLock(lock: HeldMergeLock): Promise<void> {
  lock.stopRenewing();
  await db
    .update(repositories)
    .set({ activeMergeLeaseExpiresAt: sql`clock_timestamp()`, updatedAt: new Date() })
    .where(
      and(
        eq(repositories.id, lock.repositoryId),
        eq(repositories.activeMergeOperationId, lock.operationId)
      )
    );
}

/**
 * Stale-lock recovery. A lock is stale only once its lease has expired; a
 * live lease means its holder (in any instance) is still merging. The
 * recovering instance first claims the stale lock under a new operation id,
 * so of two instances racing to recover, exactly one proceeds. Every branch
 * then proves the primary checkout's Git state before releasing the lock.
 */
async function recoverStaleMergeLock(
  userId: string,
  repository: Repository
): Promise<Repository> {
  if (!repository.activeMergeWorkspaceId || !repository.activeMergeOperationId) return repository;

  const recoveryId = crypto.randomUUID();
  const [claimed] = await db
    .update(repositories)
    .set({
      activeMergeOperationId: recoveryId,
      activeMergeOwnerInstance: runLeases.instance,
      activeMergeLeaseExpiresAt: leaseFromNow(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(repositories.id, repository.id),
        eq(repositories.activeMergeOperationId, repository.activeMergeOperationId),
        or(
          isNull(repositories.activeMergeLeaseExpiresAt),
          lte(repositories.activeMergeLeaseExpiresAt, sql`clock_timestamp()`)
        )
      )
    )
    .returning({ id: repositories.id });
  if (!claimed) {
    throw conflict('merge_in_progress', 'Another merge holds the repository lock');
  }
  const recovery: HeldMergeLock = { repositoryId: repository.id, operationId: recoveryId, stopRenewing: () => {} };

  const root = repository.rootPath;
  const checkout = await localGitDriver.inspectPrimaryCheckout(root);
  const preHead = repository.activeMergePreHead;
  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, repository.activeMergeWorkspaceId))
    .limit(1);

  const clearLock = async () => {
    await releaseMergeLock(recovery);
    return (await findRepository(userId, repository.id))!;
  };

  if (checkout.mergeHead === null && preHead !== null && checkout.head === preHead) {
    // The crashed merge never started or already aborted.
    return clearLock();
  }

  if (checkout.mergeHead === null && preHead !== null && checkout.head !== preHead) {
    // Possibly completed before the database update; prove it.
    const provable =
      checkout.clean &&
      checkout.branch === repository.defaultBranch &&
      workspace !== undefined &&
      workspace.headCommit !== null &&
      (await isAncestorIn(root, preHead, checkout.head)) &&
      (await isAncestorIn(root, workspace.headCommit, checkout.head));
    if (provable) {
      await updateWorkspace(workspace.id, { status: 'merged', mergedAt: new Date() });
      await dropBeforeRefs(root, workspace.taskId);
      await moveTask(userId, workspace.taskId, { status: 'done' }).catch(() => {});
      await addSystemTurn(
        userId,
        workspace.taskId,
        'Merge recovered after an interruption: the base branch already contains this workspace.'
      ).catch(() => {});
      return clearLock();
    }
  }

  if (checkout.mergeHead !== null && preHead !== null) {
    // Abort only what is provably ours: on the base ref, ORIG_HEAD matches the
    // recorded pre-merge HEAD, and no live operation owns the merge.
    if (checkout.branch === repository.defaultBranch && checkout.origHead === preHead) {
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
  await abandonMergeLock(recovery);
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
  workspace: Workspace;
  taskStatus: string;
}

/**
 * Merge or keep-branch, per 9.5: requires an in-review task whose latest
 * human approval still matches the workspace content fingerprint. Uncommitted
 * changes become a confirmed checkpoint commit that provably preserves the
 * approved fingerprint.
 */
export async function finalizeTaskWorkspace(
  userId: string,
  taskId: string,
  input: FinalizeInput
): Promise<FinalizeResult> {
  const workspace = await getTaskWorkspace(userId, taskId);
  if (!workspace) throw notFound('Task has no active workspace');
  if (workspace.status !== 'ready' && workspace.status !== 'dirty') {
    throw conflict('workspace_unavailable', `Workspace is ${workspace.status}; reconcile it first`);
  }
  await assertNoRunningRun(taskId);
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)))
    .limit(1);
  if (!task) throw notFound('Task not found');
  if (task.status !== 'in_review') {
    throw conflict('not_in_review', 'Finalization requires the task to be in review');
  }
  let repository = await findRepository(userId, workspace.repositoryId);
  if (!repository) throw conflict('repository_removed', 'The task repository was removed');

  const approval = await latestApproval(userId, taskId);
  if (!approval?.fingerprint) {
    throw conflict('approval_required', 'A human approval bound to a change snapshot is required');
  }

  const root = repository.rootPath;
  const recapture = () =>
    localGitDriver.captureChanges({
      worktreePath: workspace.worktreePath,
      beforeHead: workspace.baseCommit,
      baseCommit: workspace.baseCommit,
    });

  let current = await recapture().catch(rethrowGitError);
  if (current.fingerprint !== approval.fingerprint) {
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
        message: `Task #${task.number}: ${task.title}`,
      })
      .catch(rethrowGitError);
    current = await recapture().catch(rethrowGitError);
    if (current.fingerprint !== approval.fingerprint) {
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
    await dropBeforeRefs(root, taskId);
    const updated = await updateWorkspace(workspace.id, {
      status: 'retained',
      headCommit: current.afterHead,
      retainedAt: new Date(),
    });
    const moved = await moveTask(userId, taskId, { status: 'done' });
    await addSystemTurn(
      userId,
      taskId,
      `Branch ${workspace.branchName} retained; the managed worktree was removed.`
    ).catch(() => {});
    return { workspace: updated, taskStatus: moved.status };
  }

  // Merge path: serialize base-checkout mutation with the repository lock,
  // recovering a provably stale one first.
  if (repository.activeMergeWorkspaceId) {
    repository = await recoverStaleMergeLock(userId, repository);
  }
  const checkout = await localGitDriver.inspectPrimaryCheckout(root);
  const lock = await acquireMergeLock(repository, workspace, checkout.head);
  let releaseLock = true;
  try {
    const outcome = await localGitDriver
      .mergeWorkspace({
        repositoryRoot: root,
        baseRef: repository.defaultBranch,
        branchName: workspace.branchName,
        message: `Merge task #${task.number}: ${task.title}`,
      })
      .catch(rethrowGitError);

    if (outcome.result === 'merged') {
      await localGitDriver
        .removeWorkspace({ repositoryRoot: root, worktreePath: workspace.worktreePath })
        .catch((err) => {
          console.error(`Worktree cleanup after merge failed for ${workspace.id}:`, err);
        });
      await dropBeforeRefs(root, taskId);
      const updated = await updateWorkspace(workspace.id, {
        status: 'merged',
        headCommit: current.afterHead,
        mergedAt: new Date(),
      });
      const moved = await moveTask(userId, taskId, { status: 'done' });
      await addSystemTurn(
        userId,
        taskId,
        `Merged ${workspace.branchName} into ${repository.defaultBranch} (${outcome.newHead.slice(0, 12)}).`
      ).catch(() => {});
      return { workspace: updated, taskStatus: moved.status };
    }

    if (outcome.result === 'conflicted') {
      const updated = await updateWorkspace(workspace.id, {
        status: 'conflicted',
        lastError: `Merge into ${repository.defaultBranch} conflicted; the base checkout was restored`,
      });
      await addSystemTurn(
        userId,
        taskId,
        `Merge of ${workspace.branchName} conflicted; the base checkout was restored and the task stays in review.`
      ).catch(() => {});
      return { workspace: updated, taskStatus: task.status };
    }

    // abort_failed: keep the lock for manual recovery evidence, mark error.
    releaseLock = false;
    await abandonMergeLock(lock);
    await updateWorkspace(workspace.id, { status: 'error', lastError: outcome.error });
    throw conflict('merge_recovery_failed', outcome.error);
  } finally {
    if (releaseLock) await releaseMergeLock(lock);
  }
}

export interface AbandonInput {
  /** User explicitly accepted the loss of uncommitted changes. */
  confirmDiscard?: boolean;
}

/**
 * Explicit abandon: discards the managed worktree and cancels an active
 * task. Cleanup must succeed before any state transitions; done tasks
 * cannot be abandoned.
 */
export async function abandonTaskWorkspace(
  userId: string,
  taskId: string,
  input: AbandonInput
): Promise<FinalizeResult> {
  const workspace = await getTaskWorkspace(userId, taskId);
  if (!workspace) throw notFound('Task has no active workspace');
  await assertNoRunningRun(taskId);
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)))
    .limit(1);
  if (!task) throw notFound('Task not found');
  if (task.status === 'done') {
    throw conflict('task_done', 'A completed task cannot abandon its workspace');
  }
  const repository = await findRepository(userId, workspace.repositoryId);
  if (!repository) throw conflict('repository_removed', 'The task repository was removed');

  try {
    await localGitDriver.removeWorkspace({
      repositoryRoot: repository.rootPath,
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
  await dropBeforeRefs(repository.rootPath, taskId);

  const updated = await updateWorkspace(workspace.id, {
    status: 'abandoned',
    abandonedAt: new Date(),
  });
  let taskStatus: string = task.status;
  if (task.status !== 'cancelled') {
    const moved = await moveTask(userId, taskId, { status: 'cancelled' });
    taskStatus = moved.status;
  }
  await addSystemTurn(
    userId,
    taskId,
    `Workspace abandoned; branch ${workspace.branchName} and its worktree were discarded from management.`
  ).catch(() => {});
  return { workspace: updated, taskStatus };
}

/** The newest approving decision; only people record approvals. */
async function latestApproval(
  userId: string,
  taskId: string
): Promise<{ id: string; fingerprint: string | null } | null> {
  const [row] = await db
    .select({ id: approvals.id, fingerprint: approvals.fingerprint })
    .from(approvals)
    .where(
      and(
        eq(approvals.taskId, taskId),
        eq(approvals.userId, userId),
        eq(approvals.decision, 'approved')
      )
    )
    .orderBy(desc(approvals.createdAt))
    .limit(1);
  return row ?? null;
}

export interface TaskChangesView {
  workspace: Workspace;
  snapshot: ChangeSnapshot | null;
  drift: BaseDriftReport | null;
}

export async function getTaskChanges(userId: string, taskId: string): Promise<TaskChangesView> {
  const workspace = await getTaskWorkspace(userId, taskId);
  if (!workspace) throw notFound('Task has no active workspace');
  const snapshot = await latestTaskSnapshot(userId, taskId);
  const repository = await findRepository(userId, workspace.repositoryId);

  let drift: BaseDriftReport | null = null;
  if (repository && (workspace.status === 'ready' || workspace.status === 'dirty')) {
    drift = await localGitDriver
      .reportBaseDrift({
        repositoryRoot: repository.rootPath,
        baseRef: workspace.baseRef,
        baseCommit: workspace.baseCommit,
        branchName: workspace.branchName,
      })
      .catch(() => null);
  }
  return { workspace, snapshot, drift };
}
