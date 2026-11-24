import { createHash } from 'node:crypto';
import path from 'node:path';
import { and, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { config } from '../../config';
import { db, type Tx } from '../../db/client';
import { canonicalJson } from '../../lib/canonical-json';
import {
  agents,
  dispatches,
  humanRequests,
  phaseTransitions,
  taskMembers,
  tasks,
  workPackages,
  workspaces,
  type Run,
  type Task,
  type TaskStatus,
  type WorkshopPhase,
} from '../../db/schema';
import { packageBranchName, workspaceBranchName, workspaceLeaf } from '../code-workspaces/branch-name';
import { findRepository } from '../code-workspaces/workspace.service';
import { crashPoint } from '../ownership/crash-points';
import { storage } from '../../storage/layout';
import { pinPlan, recordPlan } from './plans';
import { requestPlatformOp } from './platform-ops';
import { createQueuedRun, worktreeGateKey } from '../runs/runs.service';
import { decide, type Action, type EngineSettings } from './engine';
import { FINISHED_PHASES } from './phases';
import { liveRoster, loadWorkshopState, snapshotOf, type WorkshopSnapshot } from './state';

/**
 * Advancing a workshop: lock the task row, load its state, apply what the
 * engine decides, and repeat until it decides nothing new, all in one
 * transaction. Anything that ends a run or answers a request only sets
 * tasks.advance_pending; this runs right after that commit and again from
 * the reconciler, so a crash between the two is caught up on the next pass.
 */

/** Rounds of decide-and-apply in one advance; each round moves at least one step. */
const MAX_ROUNDS = 12;
/** Consecutive failed advances before a person is asked. */
const MAX_FAILURES = 3;
export const ENGINE_ERROR_KEY = 'engine_error';

export function engineSettings(): EngineSettings {
  return {
    readOnlyTimeoutMs: config.workshopReadOnlyTimeoutMs,
    writeTimeoutMs: config.workshopWriteTimeoutMs,
    questionsTtlMs: config.workshopQuestionsTtlMs,
  };
}

export function statusForPhase(phase: WorkshopPhase): TaskStatus {
  switch (phase) {
    case 'sign_off':
    case 'approval':
    case 'merge':
      return 'in_review';
    case 'done':
      return 'done';
    case 'stopped':
      return 'cancelled';
    default:
      return 'in_progress';
  }
}

export interface AdvanceResult {
  applied: Action[];
  queued: Run[];
}

/** Test seam: the hook the start-runs step calls after an advance commits. */
let startRuns: (queued: Run[]) => Promise<void> = async (queued) => {
  const { startQueuedRuns } = await import('../runs/wake');
  await startQueuedRuns(queued);
};

export function setWorkshopRunStarterForTests(starter: ((queued: Run[]) => Promise<void>) | null): void {
  startRuns =
    starter ??
    (async (queued) => {
      const { startQueuedRuns } = await import('../runs/wake');
      await startQueuedRuns(queued);
    });
}

/**
 * Advances one workshop. Failures are counted; after three in a row the
 * engine stops retrying on its own and asks a person (engine_error).
 */
export async function advanceTask(taskId: string): Promise<AdvanceResult> {
  try {
    const result = await db.transaction((tx) => advanceWithin(tx, taskId));
    crashPoint('workshop.after_advance');
    if (result.queued.length > 0) await startRuns(result.queued);
    return result;
  } catch (error) {
    console.error(`Advancing workshop ${taskId} failed:`, error);
    await recordAdvanceFailure(taskId, error).catch((err) =>
      console.error(`Recording the advance failure of ${taskId} failed:`, err)
    );
    return { applied: [], queued: [] };
  }
}

async function advanceWithin(tx: Tx, taskId: string): Promise<AdvanceResult> {
  const applied: Action[] = [];
  const queued: Run[] = [];
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for('update');
    if (!task || task.playbook === 'legacy') return { applied, queued };
    const actions = decide(await loadWorkshopState(tx, task), engineSettings());
    if (actions.length === 0) {
      await tx
        .update(tasks)
        .set({ advancePending: false, advanceFailures: 0 })
        .where(eq(tasks.id, taskId));
      return { applied, queued };
    }
    for (const action of actions) {
      await applyAction(tx, task, action, queued);
      applied.push(action);
    }
  }
  throw new Error(`Workshop ${taskId} did not settle within ${MAX_ROUNDS} rounds`);
}

async function recordAdvanceFailure(taskId: string, error: unknown): Promise<void> {
  await db.transaction(async (tx) => {
    const [task] = await tx
      .update(tasks)
      .set({ advanceFailures: sql`${tasks.advanceFailures} + 1` })
      .where(eq(tasks.id, taskId))
      .returning();
    if (!task || task.advanceFailures < MAX_FAILURES) return;
    await openEngineRequest(tx, task.id, {
      kind: 'engine_error',
      dedupeKey: ENGINE_ERROR_KEY,
      payload: { error: error instanceof Error ? error.message : String(error), failures: task.advanceFailures },
      choices: ['retry', 'stop'],
    });
    // A person decides from here; the reconciler stops retrying.
    await tx.update(tasks).set({ advancePending: false }).where(eq(tasks.id, taskId));
  });
}

async function openEngineRequest(
  tx: Tx,
  taskId: string,
  request: {
    kind: (typeof humanRequests.$inferInsert)['kind'];
    dedupeKey: string;
    payload: Record<string, unknown>;
    choices: string[];
    ttlMs?: number;
  }
): Promise<void> {
  const [open] = await tx
    .select({ id: humanRequests.id })
    .from(humanRequests)
    .where(
      and(
        eq(humanRequests.taskId, taskId),
        eq(humanRequests.dedupeKey, request.dedupeKey),
        eq(humanRequests.status, 'open')
      )
    )
    .limit(1);
  if (open) return;
  await tx.insert(humanRequests).values({
    taskId,
    kind: request.kind,
    payload: request.payload,
    choices: request.choices,
    dedupeKey: request.dedupeKey,
    // On the database clock, which the engine compares it with.
    ...(request.ttlMs !== undefined
      ? { expiresAt: sql`clock_timestamp() + ${request.ttlMs}::integer * interval '1 millisecond'` }
      : {}),
  });
}

/** Freezes what the workshop works from; the base commit is resolved by the caller, outside the transaction. */
export async function freezeSnapshot(tx: Tx, task: Task, base: { ref: string | null; commit: string | null }): Promise<void> {
  const roster = await liveRoster(tx, task.id);
  const leadAgentId = task.leadAgentId ?? roster[0]!;
  const snapshot: WorkshopSnapshot = {
    brief: task.brief,
    title: task.title,
    repositoryId: task.repositoryId,
    baseRef: base.ref,
    baseCommit: base.commit,
    roster,
    leadAgentId,
    signers: roster,
    parallelism: task.parallelism ?? Math.min(roster.length, config.workshopMaxParallelism),
    playbook: task.playbook === 'solo' ? 'solo' : 'build',
  };
  const hash = createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
  await tx
    .update(tasks)
    .set({ snapshot: snapshot as unknown as Record<string, unknown>, snapshotHash: hash, parallelism: snapshot.parallelism })
    .where(eq(tasks.id, task.id));
}

function phaseLabel(phase: WorkshopPhase): string {
  return phase.replace('_', ' ');
}

async function applyAction(tx: Tx, task: Task, action: Action, queued: Run[]): Promise<void> {
  switch (action.type) {
    case 'freeze_snapshot':
      await freezeSnapshot(tx, task, { ref: task.baseRef, commit: null });
      return;
    case 'prepare_worktrees':
      queued.push(...(await prepareWorktrees(tx, task)));
      return;
    case 'cleanup_worktrees':
      queued.push(...(await cleanupWorktrees(tx, task)));
      return;
    case 'dispatch': {
      const [agent] = await tx.select().from(agents).where(eq(agents.id, action.agentId)).limit(1);
      // A member works in their own worktree; a workshop without a repository has none.
      const [worktree] = await tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(
          and(
            eq(workspaces.taskId, task.id),
            eq(workspaces.kind, 'member'),
            eq(workspaces.agentId, action.agentId),
            notInArray(workspaces.status, ['merged', 'retained', 'abandoned'])
          )
        );
      const [row] = await tx
        .insert(dispatches)
        .values({
          taskId: task.id,
          phase: action.phase,
          purpose: action.purpose,
          packageKey: action.packageKey,
          cycle: action.cycle,
          round: action.round,
          agentId: action.agentId,
          workspaceId: worktree?.id ?? null,
          timeoutMs: action.timeoutMs,
          // A deleted agent cannot run; its dispatch fails and the engine asks a person.
          ...(agent ? {} : { status: 'failed' as const, endedAt: new Date() }),
        })
        .onConflictDoNothing()
        .returning();
      if (!row || !agent) return;
      const snapshot = snapshotOf(task);
      const run = await createQueuedRun(
        task.userId,
        {
          agentId: agent.id,
          agentName: agent.name,
          taskId: task.id,
          trigger: 'dispatch',
          reason: `Workshop on task #${task.number} (${snapshot?.title ?? task.title}): ${phaseLabel(action.phase)}`,
          dispatchId: row.id,
          // Members on different worktrees, or without one, run at the same time.
          workspaceId: row.workspaceId,
          gateKey: worktreeGateKey(row.workspaceId),
        },
        tx
      );
      queued.push(run);
      return;
    }
    case 'cancel_dispatch':
      await tx
        .update(dispatches)
        .set({ cancelRequestedAt: sql`clock_timestamp()`, updatedAt: new Date() })
        .where(and(eq(dispatches.id, action.dispatchId), isNull(dispatches.cancelRequestedAt)));
      return;
    case 'pause_dispatch':
      await tx
        .update(dispatches)
        .set({
          elapsedMs: sql`${dispatches.elapsedMs} + COALESCE((extract(epoch from clock_timestamp() - ${dispatches.startedAt}) * 1000)::integer, 0)`,
          startedAt: null,
          pausedAt: sql`clock_timestamp()`,
          updatedAt: new Date(),
        })
        .where(and(eq(dispatches.id, action.dispatchId), isNull(dispatches.pausedAt)));
      return;
    case 'resume_dispatch':
      await tx
        .update(dispatches)
        .set({ pausedAt: null, startedAt: sql`clock_timestamp()`, updatedAt: new Date() })
        .where(eq(dispatches.id, action.dispatchId));
      return;
    case 'open_request':
      await openEngineRequest(tx, task.id, action);
      return;
    case 'expire_request':
      await tx
        .update(humanRequests)
        .set({ status: 'expired' })
        .where(and(eq(humanRequests.id, action.requestId), eq(humanRequests.status, 'open')));
      return;
    case 'record_plan':
      await recordPlan(tx, task, action);
      return;
    case 'pin_plan':
      await pinPlan(tx, task, action.planId);
      return;
    case 'package_op':
      queued.push(...(await requestPackageOp(tx, task, action)));
      return;
    case 'skip_member':
      await tx
        .update(taskMembers)
        .set({ state: 'skipped', updatedAt: new Date() })
        .where(and(eq(taskMembers.taskId, task.id), eq(taskMembers.agentId, action.agentId)));
      return;
    case 'transition':
      await moveToPhase(tx, task, action.from, action.to, action.cycle, action.round, action.cause);
      return;
    case 'stop':
      await stopWorkshopWithin(tx, task, { reason: action.reason });
      return;
  }
}

/** Ends a workshop: running dispatches are told to stop, and queued runs of a stopped workshop are refused at admission. */
export async function stopWorkshopWithin(tx: Tx, task: Task, cause: Record<string, unknown>): Promise<void> {
  await moveToPhase(tx, task, task.phase, 'stopped', task.cycle, task.round, cause);
  await tx
    .update(dispatches)
    .set({ cancelRequestedAt: sql`clock_timestamp()`, updatedAt: new Date() })
    .where(
      and(
        eq(dispatches.taskId, task.id),
        inArray(dispatches.status, ['pending', 'running']),
        isNull(dispatches.cancelRequestedAt)
      )
    );
}

/**
 * Brief's worktrees: the integration worktree on the task branch and one
 * worktree per member, detached at the frozen base commit. Rows first, then
 * one prepare_worktree operation each; both are keyed, so a repeated advance
 * adds nothing. Returns the platform runs to start after commit.
 */
async function prepareWorktrees(tx: Tx, task: Task): Promise<Run[]> {
  const snapshot = snapshotOf(task);
  const repository = await findRepository(task.userId, task.repositoryId);
  if (!snapshot?.baseCommit || !repository) throw new Error('A workshop on a repository needs its base commit and repository');
  const root = storage.worktreesRoot(task.userId);
  const live = notInArray(workspaces.status, ['merged', 'retained', 'abandoned']);
  const wanted: { kind: 'integration' | 'member'; agentId: string | null; branch: string | null }[] = [
    { kind: 'integration', agentId: null, branch: workspaceBranchName(task.number, null) },
    ...snapshot.roster.map((agentId) => ({ kind: 'member' as const, agentId, branch: null })),
  ];
  const queued: Run[] = [];
  for (const want of wanted) {
    const [existing] = await tx
      .select()
      .from(workspaces)
      .where(
        and(
          eq(workspaces.taskId, task.id),
          eq(workspaces.kind, want.kind),
          want.agentId ? eq(workspaces.agentId, want.agentId) : isNull(workspaces.agentId),
          live
        )
      );
    const row =
      existing ??
      (
        await tx
          .insert(workspaces)
          .values({
            userId: task.userId,
            taskId: task.id,
            repositoryId: repository.id,
            kind: want.kind,
            agentId: want.agentId,
            worktreePath: path.join(root, workspaceLeaf(task.id, want.kind, want.agentId)),
            branchName: want.branch,
            currentBranch: want.branch,
            baseRef: snapshot.baseRef ?? repository.defaultBranch,
            baseCommit: snapshot.baseCommit,
            status: 'preparing',
          })
          .returning()
      )[0]!;
    const { run } = await requestPlatformOp(tx, {
      userId: task.userId,
      taskId: task.id,
      opKey: `prepare:${row.id}`,
      kind: 'prepare_worktree',
      workspaceId: row.id,
      phase: 'brief',
      cycle: 0,
    });
    if (run) queued.push(run);
  }
  return queued;
}

const LIVE_WORKTREE = notInArray(workspaces.status, ['merged', 'retained', 'abandoned']);

/**
 * A package operation in the worktree it belongs to: the integration
 * worktree to merge, the owner's for everything else. Keyed by the engine,
 * so asking again queues nothing.
 */
async function requestPackageOp(tx: Tx, task: Task, action: Extract<Action, { type: 'package_op' }>): Promise<Run[]> {
  const [pkg] = await tx
    .select()
    .from(workPackages)
    .where(and(eq(workPackages.taskId, task.id), eq(workPackages.key, action.packageKey)));
  if (!pkg?.ownerAgentId) throw new Error(`Package "${action.packageKey}" has no owner to work for`);
  const [worktree] = await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      action.kind === 'integrate'
        ? and(eq(workspaces.taskId, task.id), eq(workspaces.kind, 'integration'), LIVE_WORKTREE)
        : and(eq(workspaces.taskId, task.id), eq(workspaces.kind, 'member'), eq(workspaces.agentId, pkg.ownerAgentId), LIVE_WORKTREE)
    );
  if (!worktree) throw new Error(`Package "${pkg.key}" has no worktree for ${action.kind}`);
  const args: Record<string, unknown> = { packageKey: pkg.key };
  if (action.kind === 'branch_package') {
    args.branch = packageBranchName(task.number, pkg.key, pkg.attempt);
    args.startCommit = action.startCommit;
  } else if (action.kind === 'checkpoint' || action.kind === 'finish_resolve') {
    const [owner] = await tx.select({ name: agents.name }).from(agents).where(eq(agents.id, pkg.ownerAgentId));
    args.author = owner?.name ?? '';
  }
  const { run } = await requestPlatformOp(tx, {
    userId: task.userId,
    taskId: task.id,
    opKey: action.opKey,
    kind: action.kind,
    args,
    workspaceId: worktree.id,
    phase: 'build',
    cycle: task.cycle,
  });
  return run ? [run] : [];
}

/** Once a workshop ends, its members' worktrees go; the integration worktree stays for its merge or a person. */
async function cleanupWorktrees(tx: Tx, task: Task): Promise<Run[]> {
  const rows = await tx
    .select()
    .from(workspaces)
    .where(
      and(
        eq(workspaces.taskId, task.id),
        eq(workspaces.kind, 'member'),
        notInArray(workspaces.status, ['merged', 'retained', 'abandoned'])
      )
    );
  const queued: Run[] = [];
  for (const row of rows) {
    const { run } = await requestPlatformOp(tx, {
      userId: task.userId,
      taskId: task.id,
      opKey: `cleanup:${row.id}`,
      kind: 'cleanup',
      workspaceId: row.id,
    });
    if (run) queued.push(run);
  }
  return queued;
}

export async function moveToPhase(
  tx: Tx,
  task: Pick<Task, 'id'>,
  from: WorkshopPhase | null,
  to: WorkshopPhase,
  cycle: number,
  round: number,
  cause: Record<string, unknown>
): Promise<void> {
  const finished = FINISHED_PHASES.includes(to);
  await tx
    .update(tasks)
    .set({
      phase: to,
      cycle,
      round,
      status: statusForPhase(to),
      updatedAt: new Date(),
      ...(finished ? { closedAt: new Date() } : {}),
    })
    .where(eq(tasks.id, task.id));
  // Read after the update above, under the task row lock that every timeline append also takes.
  await tx.insert(phaseTransitions).values({
    taskId: task.id,
    fromPhase: from,
    toPhase: to,
    cycle,
    round,
    cause,
    turnSeq: sql`(SELECT ${tasks.turnCounter} FROM ${tasks} WHERE ${tasks.id} = ${task.id})`,
  });
}

/**
 * Workshops the reconciler should advance: flagged ones, running ones whose
 * clocks may have run out, and ones waiting on an engine request that has
 * expired.
 */
export async function workshopsToAdvance(): Promise<string[]> {
  const rows = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      sql`${tasks.advancePending} OR (${tasks.playbook} <> 'legacy' AND ${tasks.phase} IS NOT NULL AND ${tasks.phase} NOT IN ('done', 'stopped') AND EXISTS (SELECT 1 FROM ${dispatches} d WHERE d.task_id = ${tasks.id} AND d.status = 'running')) OR EXISTS (SELECT 1 FROM ${humanRequests} h WHERE h.task_id = ${tasks.id} AND h.status = 'open' AND h.dedupe_key IS NOT NULL AND h.expires_at <= clock_timestamp())`
    );
  return rows.map((r) => r.id);
}
