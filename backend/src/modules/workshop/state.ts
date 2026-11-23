import { and, asc, desc, eq, inArray, isNotNull, notInArray, sql } from 'drizzle-orm';
import type { Tx } from '../../db/client';
import {
  dispatchReports,
  dispatches,
  humanRequests,
  plans,
  platformOps,
  runs,
  taskMembers,
  workPackages,
  workspaces,
  type Plan,
  type PlatformOpStatus,
  type Task,
} from '../../db/schema';
import type {
  DispatchView,
  MemberView,
  PackageOpKind,
  PackageView,
  PlanView,
  RequestView,
  WorkshopState,
  WorktreeState,
} from './engine';

const PACKAGE_OP_KINDS: readonly PackageOpKind[] = ['branch_package', 'checkpoint', 'integrate'];

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

/** The pinned plan's packages in the order the plan lists them. */
async function packagesOf(tx: Tx, taskId: string, planRows: Plan[]): Promise<PackageView[]> {
  const rows = await tx.select().from(workPackages).where(eq(workPackages.taskId, taskId));
  if (rows.length === 0) return [];
  const content = planRows.find((p) => p.id === rows[0]!.planId)?.content as { packages?: { key: string }[] } | undefined;
  const order = (content?.packages ?? []).map((p) => p.key);
  const rank = (key: string) => (order.includes(key) ? order.indexOf(key) : order.length);
  return rows
    .sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key))
    .map((p) => ({ key: p.key, ownerAgentId: p.ownerAgentId, dependsOn: p.dependsOn, status: p.status, attempt: p.attempt }));
}

async function packageOpsOf(tx: Tx, taskId: string): Promise<Record<string, PlatformOpStatus>> {
  const rows = await tx
    .select({ opKey: platformOps.opKey, status: platformOps.status })
    .from(platformOps)
    .where(and(eq(platformOps.taskId, taskId), inArray(platformOps.kind, [...PACKAGE_OP_KINDS])));
  return Object.fromEntries(rows.map((r) => [r.opKey, r.status]));
}

async function integrationHeadOf(tx: Tx, task: Task): Promise<string | null> {
  if (task.repositoryId === null) return null;
  const [row] = await tx
    .select({ headCommit: workspaces.headCommit })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.taskId, task.id),
        eq(workspaces.kind, 'integration'),
        notInArray(workspaces.status, ['merged', 'retained', 'abandoned'])
      )
    );
  return row?.headCommit ?? null;
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
    packages: await packagesOf(tx, task.id, planRows),
    packageOps: await packageOpsOf(tx, task.id),
    baseCommit: snapshot?.baseCommit ?? null,
    integrationHead: await integrationHeadOf(tx, task),
    nowMs: Number(clock!.now_ms),
  };
}
