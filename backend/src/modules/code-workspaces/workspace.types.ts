import type { ChangeSummary } from '../../db/schema';

export type GitDriverErrorCode =
  | 'not_a_repository'
  | 'unmanaged_branch'
  | 'base_ref_not_branch'
  | 'invalid_ref'
  | 'dirty_workspace'
  | 'git_identity_missing'
  | 'merge_precondition_failed'
  | 'branch_elsewhere'
  | 'unresolved_conflicts'
  | 'output_overflow'
  | 'git_failed';

/** Driver-level failure; services translate codes into HTTP errors. */
export class GitDriverError extends Error {
  constructor(
    readonly code: GitDriverErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'GitDriverError';
  }
}

export interface InspectRepositoryInput {
  rootPath: string;
  baseRef: string;
}

export interface RepositoryInfo {
  root: string;
  commonDir: string;
  baseRef: string;
  baseCommit: string;
  currentBranch: string | null;
  dirty: boolean;
  /** Stable identity (root, common dir, root commits, origin URL); a change invalidates workspace reuse. */
  fingerprint: string;
}

export interface PrepareWorkspaceInput {
  repositoryRoot: string;
  /** Managed root for task worktrees; the leaf must stay inside it. */
  worktreesRoot: string;
  /** Relative path under worktreesRoot, e.g. `<taskId>/integration`. */
  leaf: string;
  /** Null checks out a detached HEAD at the base, for read-only review checkouts. */
  branchName: string | null;
  baseRef: string;
  /**
   * Immutable creation point recorded when the workspace was first prepared.
   * Supplied on reuse so cumulative changes are measured against the original
   * base, not the base ref's current head.
   */
  baseCommit?: string;
}

export type ObservedWorkspaceState = 'ready' | 'dirty' | 'missing' | 'error';

/** Observable Git and filesystem facts only; task status lives on the task. */
export interface WorkspaceObservation {
  state: ObservedWorkspaceState;
  worktreePath: string;
  branchName: string | null;
  headCommit: string | null;
  /** Cumulative changes exist relative to the workspace base commit. */
  hasChanges: boolean;
  error: string | null;
}

export interface PrepareWorkspaceResult extends WorkspaceObservation {
  /** Resolution of the base at creation; on reuse this echoes the supplied baseCommit. */
  baseCommit: string;
  reused: boolean;
}

export interface ReconcileWorkspaceInput {
  repositoryRoot: string;
  worktreePath: string;
  /** Null for a detached worktree, which has no branch to recover from. */
  branchName: string | null;
  baseCommit: string;
}

export interface ReconcileWorkspaceResult extends WorkspaceObservation {
  branchName: string | null;
  /** The worktree was re-attached from its surviving branch after a crash or out-of-band deletion. */
  recovered: boolean;
}

export interface CaptureLimits {
  maxPatchBytes: number;
  maxSummaryFiles: number;
}

export const DEFAULT_CAPTURE_LIMITS: CaptureLimits = {
  maxPatchBytes: 2 * 1024 * 1024,
  maxSummaryFiles: 500,
};

export interface WorkingTreeSnapshot {
  head: string;
  summary: ChangeSummary;
}

/** The worktree's content as Git objects: tracked and untracked files, ignored files excluded. */
export interface TreeState {
  head: string;
  tree: string;
}

export interface BeforeRefInput {
  worktreePath: string;
  /** Must live under refs/loxo/. */
  ref: string;
  message: string;
}

export interface BeforeRef extends TreeState {
  /** Commit the ref points at: `tree` with `head` as its only parent. */
  commit: string;
}

export interface RestoreTreeInput {
  worktreePath: string;
  /** Commit the checked-out branch is reset to. */
  head: string;
  /** Content the worktree ends with; files outside it are removed, ignored ones kept. */
  tree: string;
}

export interface CaptureChangesInput {
  worktreePath: string;
  /** HEAD captured before the run started; the stored patch is relative to it. */
  beforeHead: string;
  /** Immutable workspace creation point; the change fingerprint is relative to it. */
  baseCommit: string;
  limits?: CaptureLimits;
}

export interface CapturedChanges {
  afterHead: string;
  summary: ChangeSummary;
  /** Full counts before summary truncation; includes untracked files. */
  changedFiles: number;
  additions: number;
  deletions: number;
  /** Cumulative diff against beforeHead, so agent-created commits are covered. */
  patch: Buffer;
  patchTruncated: boolean;
  /** Content-only fingerprint of the change set vs baseCommit; stable across checkpoint commits. */
  fingerprint: string;
  /** Tracked files changed relative to beforeHead — read-only policy evidence. Untracked-only output stays false. */
  trackedChanges: boolean;
}

export interface BaseDriftInput {
  repositoryRoot: string;
  baseRef: string;
  baseCommit: string;
  branchName: string;
}

export interface BaseDriftReport {
  baseIsAncestor: boolean;
  baseAdvancedBy: number;
  branchAhead: number;
  branchBehind: number;
  diverged: boolean;
}

/** Observable facts about the repository's primary checkout, for merge preconditions and lock recovery. */
export interface PrimaryCheckoutState {
  branch: string | null;
  head: string;
  clean: boolean;
  mergeHead: string | null;
  origHead: string | null;
}

export interface CheckpointInput {
  worktreePath: string;
  message: string;
}

export interface GitIdentity {
  name: string;
  email: string;
}

export interface CommitAsInput {
  worktreePath: string;
  message: string;
  author: GitIdentity;
  /** Defaults to the author. */
  committer?: GitIdentity;
}

export interface InterruptedStateCleared {
  removedLock: boolean;
  abortedMerge: boolean;
}

export interface CheckpointResult {
  /** Null when the tree was already fully committed. */
  commit: string | null;
}

export interface MergeWorkspaceInput {
  repositoryRoot: string;
  baseRef: string;
  branchName: string;
  message: string;
}

export type MergeOutcome =
  | { result: 'merged'; newHead: string; preHead: string }
  | { result: 'conflicted'; preHead: string }
  | { result: 'abort_failed'; preHead: string; error: string };

export interface RemoveWorkspaceInput {
  repositoryRoot: string;
  worktreePath: string;
  /** Explicit confirmation that uncommitted changes may be discarded. */
  allowDirty?: boolean;
  /** Also delete this branch once the worktree is gone; only loxo/ branches qualify. */
  deleteBranch?: string;
}

/**
 * Location-agnostic workspace operations; task and run services never know
 * where Git executes.
 */
export interface WorkspaceDriver {
  inspectRepository(input: InspectRepositoryInput): Promise<RepositoryInfo>;
  prepareWorkspace(input: PrepareWorkspaceInput): Promise<PrepareWorkspaceResult>;
  snapshotWorkingTree(input: {
    worktreePath: string;
    limits?: CaptureLimits;
  }): Promise<WorkingTreeSnapshot>;
  /** Hashes the worktree into a tree object without touching its index or files. */
  snapshotTree(worktreePath: string): Promise<TreeState>;
  /** Pins the worktree's current content under `ref`, untracked files included. */
  writeBeforeRef(input: BeforeRefInput): Promise<BeforeRef>;
  /** Puts the worktree back to a pinned state and proves it by hashing the result. */
  restoreTree(input: RestoreTreeInput): Promise<void>;
  /** Deletes managed refs; missing ones are ignored. */
  deleteManagedRefs(repositoryRoot: string, refs: string[]): Promise<void>;
  captureChanges(input: CaptureChangesInput): Promise<CapturedChanges>;
  reportBaseDrift(input: BaseDriftInput): Promise<BaseDriftReport>;
  inspectPrimaryCheckout(repositoryRoot: string): Promise<PrimaryCheckoutState>;
  commitCheckpoint(input: CheckpointInput): Promise<CheckpointResult>;
  mergeWorkspace(input: MergeWorkspaceInput): Promise<MergeOutcome>;
  removeWorkspace(input: RemoveWorkspaceInput): Promise<void>;
  reconcileWorkspace(input: ReconcileWorkspaceInput): Promise<ReconcileWorkspaceResult>;
}
