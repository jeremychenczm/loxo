import { and, eq, inArray } from 'drizzle-orm';
import { config } from '../../config';
import type { Executor, Tx } from '../../db/client';
import { db } from '../../db/client';
import fs from 'node:fs';
import path from 'node:path';
import {
  humanRequests,
  platformOps,
  tasks,
  workPackages,
  workspaces,
  type PlatformOp,
  type Run,
  type WorkshopPhase,
} from '../../db/schema';
import { localGitDriver } from '../code-workspaces/local-git-driver';
import { getWorkspace } from '../code-workspaces/workspace.service';
import { BUILT_IN_PLATFORM_OPS, type PackageObservation, type WorktreeObservation } from './platform-op-kinds';
import type { RunLease } from '../ownership/lease';
import { createQueuedRun, worktreeGateKey } from '../runs/runs.service';

/**
 * Platform operations: git and check work the platform does itself, each
 * execution a platform run under the gate of the worktree it touches. The
 * handlers live in a registry so each kind can be added on its own; an
 * execution that fails is retried as a new run of the same operation, up to
 * the run attempt limit, after which the operation fails and a person is asked.
 */

export const PLATFORM_AGENT_NAME = 'Loxo platform';

/** Commits the platform makes itself carry this identity, never the repository's git config. */
export { PLATFORM_IDENTITY } from './platform-op-kinds';

/** Integration relies on `git merge-tree --write-tree`, added in git 2.38. */
const MIN_GIT: [number, number] = [2, 38];
let gitReady: Promise<boolean> | null = null;

/** Whether the installed git can run workshops on a repository; checked once per process. */
export function workshopGitReady(): Promise<boolean> {
  gitReady ??= localGitDriver.gitVersion().then(
    (v) => v !== null && (v[0] > MIN_GIT[0] || (v[0] === MIN_GIT[0] && v[1] >= MIN_GIT[1])),
    () => false
  );
  return gitReady;
}

export interface PlatformOpContext {
  run: Run;
  lease: RunLease;
  /** Aborts when the instance is shutting down; a handler that can stop early should. */
  signal: AbortSignal;
}

export type PlatformOpHandler = (op: PlatformOp, ctx: PlatformOpContext) => Promise<Record<string, unknown>>;

const handlers = new Map<string, PlatformOpHandler>();

export function registerPlatformOp(kind: string, handler: PlatformOpHandler): void {
  handlers.set(kind, handler);
}

/** Test seam: add or remove a handler for a kind. */
export function setPlatformOpHandlerForTests(kind: string, handler: PlatformOpHandler | null): void {
  if (handler) handlers.set(kind, handler);
  else handlers.delete(kind);
}

export interface PlatformOpRequest {
  userId: string;
  taskId: string;
  opKey: string;
  kind: string;
  args?: Record<string, unknown>;
  workspaceId: string | null;
  phase?: WorkshopPhase | null;
  cycle?: number | null;
}

/**
 * Asks for an operation inside the caller's transaction. Asking again with
 * the same key returns the existing operation and queues nothing. Returns
 * the queued run, if any, for the caller to start after commit.
 */
export async function requestPlatformOp(tx: Tx, request: PlatformOpRequest): Promise<{ op: PlatformOp; run: Run | null }> {
  const [inserted] = await tx
    .insert(platformOps)
    .values({
      taskId: request.taskId,
      opKey: request.opKey,
      kind: request.kind,
      args: request.args ?? {},
      workspaceId: request.workspaceId,
      phase: request.phase ?? null,
      cycle: request.cycle ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (!inserted) {
    const [existing] = await tx
      .select()
      .from(platformOps)
      .where(and(eq(platformOps.taskId, request.taskId), eq(platformOps.opKey, request.opKey)));
    return { op: existing!, run: null };
  }
  const run = await queuePlatformRun(tx, request.userId, inserted, { attempt: 1 });
  return { op: inserted, run };
}

/** A platform run for the operation: no agent, the worktree's gate, and the run attempt it is on. */
export async function queuePlatformRun(
  ex: Executor,
  userId: string,
  op: PlatformOp,
  options: { attempt: number; parentRunId?: string | null; delayMs?: number; reason?: string }
): Promise<Run> {
  return createQueuedRun(
    userId,
    {
      agentId: null,
      agentName: PLATFORM_AGENT_NAME,
      taskId: op.taskId,
      trigger: 'platform',
      actor: 'platform',
      reason: options.reason ?? `Platform operation ${op.kind}`,
      opId: op.id,
      workspaceId: op.workspaceId,
      gateKey: worktreeGateKey(op.workspaceId),
      attempt: options.attempt,
      parentRunId: options.parentRunId ?? null,
      delayMs: options.delayMs,
    },
    ex
  );
}

export async function platformOpOf(opId: string, ex: Executor = db): Promise<PlatformOp | undefined> {
  const [row] = await ex.select().from(platformOps).where(eq(platformOps.id, opId)).limit(1);
  return row;
}

/**
 * Runs the operation's handler; throws when the kind has none or the handler
 * fails. A retry or follow-up first clears what the run before it may have
 * left half done in the worktree (that run has ended by then).
 */
export async function executePlatformRun(run: Run, ctx: Omit<PlatformOpContext, 'run'>): Promise<Record<string, unknown>> {
  const op = run.opId ? await platformOpOf(run.opId) : undefined;
  if (!op) throw new Error(`Platform run ${run.id} has no operation`);
  const handler = handlers.get(op.kind) ?? BUILT_IN_PLATFORM_OPS[op.kind];
  if (!handler) throw new Error(`No handler for platform operation ${op.kind}`);
  ctx.lease.assertHeld();
  if (run.parentRunId && op.workspaceId) {
    const workspace = await getWorkspace(op.workspaceId);
    if (workspace && fs.existsSync(workspace.worktreePath)) {
      await localGitDriver.clearInterruptedState(workspace.worktreePath, { keepMerge: op.kind === 'begin_resolve' });
    }
  }
  const witnessed = witness(run, ctx.lease.epoch);
  try {
    return await handler(op, { ...ctx, run });
  } finally {
    witnessed();
  }
}

const WITNESS_BEAT_MS = 50;

/**
 * With LOXO_PLATFORM_WITNESS_DIR set (chaos trials), records when this
 * process executes an operation, in the witness format agents use, so the
 * double-execution check sees platform operations next to agents. Returns
 * the function that writes the end line.
 */
function witness(run: Run, epoch: number): () => void {
  const dir = process.env.LOXO_PLATFORM_WITNESS_DIR;
  if (!dir) return () => {};
  const file = path.join(dir, `platform-${process.pid}.jsonl`);
  const base = { run: run.id, epoch, via: new URL(config.mcpUrl()).host, pid: process.pid };
  const write = (mark: 'start' | 'beat' | 'end') =>
    fs.appendFileSync(file, `${JSON.stringify({ ...base, t: Date.now(), mark })}\n`);
  write('start');
  const beat = setInterval(() => write('beat'), WITNESS_BEAT_MS);
  beat.unref();
  return () => {
    clearInterval(beat);
    write('end');
  };
}

/** Whether a follow-up or retry run may carry the operation on: it is still wanted. */
export async function opContinues(tx: Tx, run: Pick<Run, 'opId'>): Promise<boolean> {
  if (!run.opId) return false;
  const [op] = await tx.select({ status: platformOps.status }).from(platformOps).where(eq(platformOps.id, run.opId));
  return op !== undefined && (op.status === 'wanted' || op.status === 'running');
}

export type PlatformRunEnding =
  | { kind: 'done'; result: Record<string, unknown> }
  | { kind: 'failed'; error: string }
  | { kind: 'continued' };

let retryBackoffMs = config.runRetryBackoffMs;

/** Test seam: shorten the back-off before a failed operation runs again. */
export function setPlatformRetryBackoffForTests(ms: number | null): void {
  retryBackoffMs = ms ?? config.runRetryBackoffMs;
}

/**
 * Records how a platform run ended, inside the transaction that ended it,
 * after its run row is locked. A failure is retried as a new run while the
 * run attempt limit allows; after that the operation fails and a person is
 * asked. Returns the task to advance and any retry run to start after commit.
 */
export async function notePlatformRunEnded(
  tx: Tx,
  run: Run,
  ending: PlatformRunEnding
): Promise<{ taskId: string | null; retry: Run | null }> {
  if (!run.opId) return { taskId: null, retry: null };
  const [op] = await tx
    .select()
    .from(platformOps)
    .where(and(eq(platformOps.id, run.opId), inArray(platformOps.status, ['wanted', 'running'])))
    .for('update');
  if (!op) return { taskId: null, retry: null };
  await tx.update(tasks).set({ advancePending: true }).where(eq(tasks.id, op.taskId));
  if (ending.kind === 'continued') return { taskId: op.taskId, retry: null };
  if (ending.kind === 'done') {
    await tx
      .update(platformOps)
      .set({ status: 'done', result: ending.result, attempts: run.attempt, error: null, updatedAt: new Date() })
      .where(eq(platformOps.id, op.id));
    const observed = ending.result.worktree as WorktreeObservation | undefined;
    if (observed) await applyWorktreeObservation(tx, observed);
    const pkg = ending.result.package as PackageObservation | undefined;
    if (pkg) await applyPackageObservation(tx, op.taskId, pkg);
    return { taskId: op.taskId, retry: null };
  }
  if (run.attempt < config.runMaxAttempts) {
    await tx
      .update(platformOps)
      .set({ status: 'wanted', attempts: run.attempt, error: ending.error, updatedAt: new Date() })
      .where(eq(platformOps.id, op.id));
    const retry = await queuePlatformRun(tx, run.userId, op, {
      attempt: run.attempt + 1,
      parentRunId: run.id,
      delayMs: retryBackoffMs * 2 ** (run.attempt - 1),
      reason: `Retrying platform operation ${op.kind} after: ${ending.error}`,
    });
    return { taskId: op.taskId, retry };
  }
  await failPlatformOp(tx, op, run.attempt, ending.error);
  return { taskId: op.taskId, retry: null };
}

/**
 * Writes what an operation saw of its worktree, under the settling run's
 * fence. For the recovery operations this is also what lifts a quarantine.
 */
async function applyWorktreeObservation(tx: Tx, observed: WorktreeObservation): Promise<void> {
  await tx
    .update(workspaces)
    .set({
      status: observed.status,
      headCommit: observed.headCommit,
      lastError: observed.lastError,
      ...(observed.worktreePath ? { worktreePath: observed.worktreePath } : {}),
      ...(observed.currentBranch !== undefined ? { currentBranch: observed.currentBranch } : {}),
      ...(observed.status === 'abandoned' ? { abandonedAt: new Date() } : {}),
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, observed.id));
}

/** Writes what a package operation established: its branch and start, its head, and how far it has come. */
async function applyPackageObservation(tx: Tx, taskId: string, observed: PackageObservation): Promise<void> {
  await tx
    .update(workPackages)
    .set({
      status: observed.status,
      ...(observed.branch !== undefined ? { branch: observed.branch } : {}),
      ...(observed.startCommit !== undefined ? { startCommit: observed.startCommit } : {}),
      ...(observed.headCommit !== undefined ? { headCommit: observed.headCommit } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(workPackages.taskId, taskId), eq(workPackages.key, observed.key)));
}

const OP_REQUEST_PREFIX = 'platform_op:';

/** The operation a request about a failed operation is for, or null for any other request. */
export function platformOpOfRequestKey(dedupeKey: string | null): string | null {
  return dedupeKey?.startsWith(OP_REQUEST_PREFIX) ? dedupeKey.slice(OP_REQUEST_PREFIX.length) : null;
}

/** Gives up on an operation and asks a person, once per operation. */
export async function failPlatformOp(tx: Tx, op: PlatformOp, attempts: number, error: string): Promise<void> {
  await tx
    .update(platformOps)
    .set({ status: 'failed', attempts, error, updatedAt: new Date() })
    .where(eq(platformOps.id, op.id));
  const dedupeKey = `${OP_REQUEST_PREFIX}${op.id}`;
  const [open] = await tx
    .select({ id: humanRequests.id })
    .from(humanRequests)
    .where(and(eq(humanRequests.taskId, op.taskId), eq(humanRequests.dedupeKey, dedupeKey), eq(humanRequests.status, 'open')));
  if (open) return;
  await tx.insert(humanRequests).values({
    taskId: op.taskId,
    kind: 'engine_error',
    payload: { operation: op.kind, opKey: op.opKey, error, attempts },
    choices: ['retry', 'stop'],
    dedupeKey,
  });
}

