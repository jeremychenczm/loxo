import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { config } from '../../config';
import { db, type Tx } from '../../db/client';
import {
  agents,
  dispatches,
  humanRequests,
  phaseTransitions,
  taskMembers,
  tasks,
  type Run,
  type Task,
  type TaskStatus,
  type WorkshopPhase,
} from '../../db/schema';
import { crashPoint } from '../ownership/crash-points';
import { createQueuedRun } from '../runs/runs.service';
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
  request: { kind: (typeof humanRequests.$inferInsert)['kind']; dedupeKey: string; payload: Record<string, unknown>; choices: string[] }
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
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function freezeSnapshot(tx: Tx, task: Task): Promise<void> {
  const roster = await liveRoster(tx, task.id);
  const leadAgentId = task.leadAgentId ?? roster[0]!;
  const snapshot: WorkshopSnapshot = {
    brief: task.brief,
    title: task.title,
    repositoryId: task.repositoryId,
    baseRef: task.baseRef,
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
      await freezeSnapshot(tx, task);
      return;
    case 'prepare_worktrees':
      throw new Error('Workshops on a repository are not supported yet');
    case 'dispatch': {
      const [agent] = await tx.select().from(agents).where(eq(agents.id, action.agentId)).limit(1);
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
  await tx.insert(phaseTransitions).values({ taskId: task.id, fromPhase: from, toPhase: to, cycle, round, cause });
}

/** Workshops the reconciler should advance: flagged ones, and running ones whose clocks may have run out. */
export async function workshopsToAdvance(): Promise<string[]> {
  const rows = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      sql`${tasks.advancePending} OR (${tasks.playbook} <> 'legacy' AND ${tasks.phase} IS NOT NULL AND ${tasks.phase} NOT IN ('done', 'stopped') AND EXISTS (SELECT 1 FROM ${dispatches} d WHERE d.task_id = ${tasks.id} AND d.status = 'running'))`
    );
  return rows.map((r) => r.id);
}
