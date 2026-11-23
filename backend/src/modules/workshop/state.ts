import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Tx } from '../../db/client';
import {
  dispatchReports,
  dispatches,
  humanRequests,
  plans,
  platformOps,
  runs,
  taskMembers,
  type Task,
} from '../../db/schema';
import type { DispatchView, MemberView, PlanView, RequestView, WorkshopState, WorktreeState } from './engine';

/** What Brief freezes; later phases read the roster and lead from here, never from the live task. */
export interface WorkshopSnapshot {
  brief: string;
  title: string;
  repositoryId: string | null;
  baseRef: string | null;
  /** The commit the workshop builds on, resolved at start; null without a repository. */
  baseCommit: string | null;
  roster: string[];
  leadAgentId: string;
  signers: string[];
  parallelism: number;
  playbook: 'build' | 'solo';
}

export function snapshotOf(task: Pick<Task, 'snapshot'>): WorkshopSnapshot | null {
  return (task.snapshot as WorkshopSnapshot | null) ?? null;
}

/**
 * Where the workshop's worktrees stand, from the operations that prepare and
 * remove them: Brief's prepare_worktree operations, then the cleanup
 * operations asked for once the workshop ends.
 */
async function worktreeState(tx: Tx, task: Task): Promise<WorktreeState> {
  if (task.repositoryId === null) return 'absent';
  const ops = await tx
    .select({ kind: platformOps.kind, status: platformOps.status })
    .from(platformOps)
    .where(and(eq(platformOps.taskId, task.id), inArray(platformOps.kind, ['prepare_worktree', 'cleanup'])));
  const prepared = ops.filter((o) => o.kind === 'prepare_worktree');
  const cleanups = ops.filter((o) => o.kind === 'cleanup');
  if (cleanups.length > 0) return cleanups.every((o) => o.status !== 'wanted' && o.status !== 'running') ? 'cleaned' : 'cleaning';
  if (prepared.length === 0) return 'absent';
  return prepared.every((o) => o.status === 'done') ? 'ready' : 'preparing';
}

/** Active members in speaking order, for a workshop that has not frozen its snapshot yet. */
export async function liveRoster(tx: Tx, taskId: string): Promise<string[]> {
  const rows = await tx
    .select({ agentId: taskMembers.agentId })
    .from(taskMembers)
    .where(and(eq(taskMembers.taskId, taskId), eq(taskMembers.state, 'active')))
    .orderBy(asc(taskMembers.position));
  return rows.map((r) => r.agentId);
}

/**
 * Reads one task's workshop state inside the advancing transaction, which
 * already holds the task row. Times are on the database clock.
 */
export async function loadWorkshopState(tx: Tx, task: Task): Promise<WorkshopState> {
  const snapshot = snapshotOf(task);
  const roster = snapshot?.roster ?? (await liveRoster(tx, task.id));
  const skippedRows = await tx
    .select({ agentId: taskMembers.agentId })
    .from(taskMembers)
    .where(and(eq(taskMembers.taskId, task.id), eq(taskMembers.state, 'skipped')));
  const skipped = new Set(skippedRows.map((r) => r.agentId));
  const members: MemberView[] = roster.map((agentId) => ({ agentId, skipped: skipped.has(agentId) }));

  const rows = await tx.select().from(dispatches).where(eq(dispatches.taskId, task.id));
  const ids = rows.map((d) => d.id);
  const reports = ids.length
    ? await tx.select().from(dispatchReports).where(inArray(dispatchReports.dispatchId, ids))
    : [];
  const reportBy = new Map(reports.map((r) => [r.dispatchId, r.report]));

  // The latest run of each dispatch decides whether it is waiting on a person.
  const latestRuns = ids.length
    ? await tx
        .selectDistinctOn([runs.dispatchId], {
          dispatchId: runs.dispatchId,
          status: runs.status,
          waiting: sql<boolean>`EXISTS (SELECT 1 FROM ${humanRequests} h WHERE h.run_id = ${runs.id} AND h.status = 'open')`,
        })
        .from(runs)
        .where(inArray(runs.dispatchId, ids))
        .orderBy(runs.dispatchId, desc(runs.createdAt))
    : [];
  const waitingBy = new Map(latestRuns.map((r) => [r.dispatchId, r.status === 'interrupted' || r.waiting]));

  const views: DispatchView[] = rows.map((d) => ({
    id: d.id,
    phase: d.phase,
    purpose: d.purpose,
    packageKey: d.packageKey,
    cycle: d.cycle,
    round: d.round,
    agentId: d.agentId,
    status: d.status,
    report: reportBy.get(d.id) ?? null,
    startedAtMs: d.startedAt?.getTime() ?? null,
    pausedAtMs: d.pausedAt?.getTime() ?? null,
    elapsedMs: d.elapsedMs,
    timeoutMs: d.timeoutMs,
    cancelRequested: d.cancelRequestedAt !== null,
    waitingOnPerson: waitingBy.get(d.id) ?? false,
  }));

  const requestRows = await tx
    .select()
    .from(humanRequests)
    .where(and(eq(humanRequests.taskId, task.id), isNotNull(humanRequests.dedupeKey)));
  const requests: RequestView[] = requestRows.map((r) => ({
    id: r.id,
    kind: r.kind,
    dedupeKey: r.dedupeKey,
    status: r.status,
    answer: r.answer ?? null,
    expiresAtMs: r.expiresAt?.getTime() ?? null,
  }));

  const planRows = await tx.select().from(plans).where(eq(plans.taskId, task.id));
  const planViews: PlanView[] = planRows.map((p) => ({
    id: p.id,
    cycle: p.cycle,
    version: p.version,
    round: p.round,
    source: p.source,
    dispatchId: p.dispatchId,
  }));

  const [clock] = await tx.execute<{ now_ms: string }>(sql`SELECT (extract(epoch from clock_timestamp()) * 1000)::bigint AS now_ms`).then((r) => r.rows);

  return {
    taskId: task.id,
    playbook: task.playbook === 'solo' ? 'solo' : 'build',
    phase: task.phase,
    cycle: task.cycle,
    round: task.round,
    leadAgentId: snapshot?.leadAgentId ?? task.leadAgentId ?? roster[0] ?? '',
    members,
    parallelism: task.parallelism ?? snapshot?.parallelism ?? Math.max(1, roster.length),
    snapshotFrozen: snapshot !== null,
    worktrees: await worktreeState(tx, task),
    hasRepository: task.repositoryId !== null,
    dispatches: views,
    requests,
    plans: planViews,
    planPinned: task.planHash !== null,
    nowMs: Number(clock!.now_ms),
  };
}
