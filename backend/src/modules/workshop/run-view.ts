import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { db, type Executor } from '../../db/client';
import {
  agents,
  dispatches,
  phaseTransitions,
  runs,
  taskMembers,
  tasks,
  turns,
  type Dispatch,
  type Run,
  type Task,
  type Turn,
  type WorkshopPhase,
} from '../../db/schema';
import { phaseMaterials, type WorkshopMaterials } from './materials';
import { agentPhase } from './phases';
import { snapshotOf } from './state';

/** Longest earlier reply quoted back to a member asked again for a report. */
const MAX_PREVIOUS_REPLY_CHARS = 4_000;

/**
 * What one workshop run works from: the frozen brief, its phase and role,
 * and the timeline it may see. In a blind phase that timeline stops where
 * the phase began: every participant starts from the same inputs, and
 * nothing a member (or a person) adds during the phase reaches the others
 * until it is over.
 */
export interface WorkshopRunView {
  title: string;
  brief: string;
  phase: WorkshopPhase;
  cycle: number;
  round: number;
  role: 'lead' | 'member';
  members: { agentId: string; name: string }[];
  timeline: Turn[];
  /** The member's own last reply, when its previous round in this phase ended without a report. */
  previousReply: string | null;
  /** What the phase gives its participants to work from. */
  materials: WorkshopMaterials;
}

export async function workshopRunView(run: Pick<Run, 'dispatchId' | 'agentId'>, ex: Executor = db): Promise<WorkshopRunView | null> {
  if (!run.dispatchId) return null;
  const [dispatch] = await ex.select().from(dispatches).where(eq(dispatches.id, run.dispatchId));
  if (!dispatch) return null;
  const [task] = await ex.select().from(tasks).where(eq(tasks.id, dispatch.taskId));
  if (!task) return null;
  const snapshot = snapshotOf(task);
  const roster = snapshot?.roster ?? [];
  const names = roster.length
    ? await ex.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, roster))
    : [];
  const nameOf = new Map(names.map((a) => [a.id, a.name]));

  return {
    title: snapshot?.title ?? task.title,
    brief: snapshot?.brief ?? task.brief,
    phase: dispatch.phase,
    cycle: dispatch.cycle,
    round: dispatch.round,
    role: dispatch.agentId === (snapshot?.leadAgentId ?? task.leadAgentId) ? 'lead' : 'member',
    members: roster.map((agentId) => ({ agentId, name: nameOf.get(agentId) ?? 'a removed agent' })),
    timeline: await visibleTimeline(task, dispatch, ex),
    previousReply: await previousReply(dispatch, ex),
    materials: await phaseMaterials(dispatch, (id) => (id && nameOf.get(id)) || 'a removed agent', ex),
  };
}

async function visibleTimeline(task: Task, dispatch: Dispatch, ex: Executor): Promise<Turn[]> {
  const all = await ex.select().from(turns).where(eq(turns.taskId, task.id)).orderBy(asc(turns.seq));
  if (!agentPhase(dispatch.phase)?.blind) return all;

  const [entered] = await ex
    .select({ turnSeq: phaseTransitions.turnSeq })
    .from(phaseTransitions)
    .where(
      and(
        eq(phaseTransitions.taskId, task.id),
        eq(phaseTransitions.toPhase, dispatch.phase),
        eq(phaseTransitions.cycle, dispatch.cycle),
        // In SQL, at full precision: a JS Date would drop the microseconds of a dispatch made in the same transaction.
        lte(phaseTransitions.createdAt, sql`(SELECT ${dispatches.createdAt} FROM ${dispatches} WHERE ${dispatches.id} = ${dispatch.id})`)
      )
    )
    .orderBy(desc(phaseTransitions.createdAt))
    .limit(1);
  // Timeline seqs, not timestamps: turns are stamped by the app clock, transitions by the database's.
  const cutoff = entered?.turnSeq ?? 0;
  return all.filter((t) => t.seq <= cutoff);
}

async function previousReply(dispatch: Dispatch, ex: Executor): Promise<string | null> {
  if (dispatch.round === 0 || !dispatch.agentId) return null;
  const [earlier] = await ex
    .select({ output: runs.output })
    .from(runs)
    .innerJoin(dispatches, eq(dispatches.id, runs.dispatchId))
    .where(
      and(
        eq(dispatches.taskId, dispatch.taskId),
        eq(dispatches.phase, dispatch.phase),
        eq(dispatches.cycle, dispatch.cycle),
        eq(dispatches.round, dispatch.round - 1),
        eq(dispatches.agentId, dispatch.agentId),
        eq(dispatches.status, 'no_report')
      )
    )
    .orderBy(desc(runs.createdAt))
    .limit(1);
  const text = earlier?.output.trim();
  return text ? text.slice(0, MAX_PREVIOUS_REPLY_CHARS) : null;
}

/** Members still taking part, with their names: the frozen roster without those skipped. */
export async function activeMembers(taskId: string, ex: Executor = db): Promise<{ agentId: string; name: string }[]> {
  const [task] = await ex.select().from(tasks).where(eq(tasks.id, taskId));
  const roster = task ? (snapshotOf(task)?.roster ?? []) : [];
  if (roster.length === 0) return [];
  const skipped = await ex
    .select({ agentId: taskMembers.agentId })
    .from(taskMembers)
    .where(and(eq(taskMembers.taskId, taskId), eq(taskMembers.state, 'skipped')));
  const out = new Set(skipped.map((r) => r.agentId));
  const names = await ex.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, roster));
  const nameOf = new Map(names.map((a) => [a.id, a.name]));
  return roster.filter((id) => !out.has(id) && nameOf.has(id)).map((agentId) => ({ agentId, name: nameOf.get(agentId)! }));
}
