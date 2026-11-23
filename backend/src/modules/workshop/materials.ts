import { and, asc, desc, eq, gte, sql } from 'drizzle-orm';
import type { Executor } from '../../db/client';
import { dispatchReports, dispatches, humanRequests, plans, type Dispatch, type PlanSource } from '../../db/schema';
import { questionsKey } from './engine';
import type { ExplorationReport, PlanReport, PlanReviewReport } from './reports';

/** A plan as members read it: owners by name. */
export interface PlanMaterial {
  version: number;
  source: PlanSource;
  summary: string;
  packages: { key: string; title: string; owner: string; area: string; dependsOn: string[]; acceptance: string[] }[];
  integration: string;
  verification: string;
}

/**
 * What a phase gives its participants to work from. Plan: every member's
 * exploration and the person's answer to their questions, and when revising,
 * the plan as it stood and the objections to it. Plan review: the plan.
 */
export interface WorkshopMaterials {
  explorations?: { member: string; summary: string; questions: string[] }[];
  questions?: {
    asked: { member: string; question: string }[];
    /** The person's answer; null when the request expired or is still open. */
    answer: string | null;
  };
  plan?: PlanMaterial;
  objections?: { member: string; comments: string }[];
}

type NameOf = (agentId: string | null) => string;

export async function phaseMaterials(dispatch: Dispatch, nameOf: NameOf, ex: Executor): Promise<WorkshopMaterials> {
  switch (dispatch.phase) {
    case 'plan': {
      const materials: WorkshopMaterials = {
        explorations: await explorations(dispatch, nameOf, ex),
        ...(await questions(dispatch, nameOf, ex)),
      };
      const latest = await latestPlan(dispatch, ex);
      if (!latest) return materials;
      return { ...materials, plan: planMaterial(latest, nameOf), objections: await objections(dispatch, latest.id, nameOf, ex) };
    }
    case 'plan_review': {
      const latest = await latestPlan(dispatch, ex);
      return latest ? { plan: planMaterial(latest, nameOf) } : {};
    }
    default:
      return {};
  }
}

/** Each member's latest reported exploration in the cycle. */
async function explorations(dispatch: Dispatch, nameOf: NameOf, ex: Executor): Promise<WorkshopMaterials['explorations']> {
  const rows = await ex
    .select({ agentId: dispatches.agentId, round: dispatches.round, report: dispatchReports.report })
    .from(dispatches)
    .innerJoin(dispatchReports, eq(dispatchReports.dispatchId, dispatches.id))
    .where(
      and(
        eq(dispatches.taskId, dispatch.taskId),
        eq(dispatches.phase, 'explore'),
        eq(dispatches.cycle, dispatch.cycle),
        eq(dispatches.status, 'reported')
      )
    )
    .orderBy(asc(dispatches.createdAt));
  const latest = new Map<string | null, ExplorationReport>();
  for (const row of rows) latest.set(row.agentId, row.report as unknown as ExplorationReport);
  return [...latest].map(([agentId, report]) => ({
    member: nameOf(agentId),
    summary: report.summary,
    questions: report.questions ?? [],
  }));
}

async function questions(dispatch: Dispatch, nameOf: NameOf, ex: Executor): Promise<Pick<WorkshopMaterials, 'questions'>> {
  const [request] = await ex
    .select()
    .from(humanRequests)
    .where(and(eq(humanRequests.taskId, dispatch.taskId), eq(humanRequests.dedupeKey, questionsKey(dispatch.cycle))))
    .orderBy(desc(humanRequests.createdAt))
    .limit(1);
  if (!request) return {};
  const asked = Array.isArray(request.payload.questions) ? (request.payload.questions as { agentId: string; question: string }[]) : [];
  const answer =
    request.status === 'answered' && request.answer
      ? [request.answer.choice, request.answer.note].filter((part) => typeof part === 'string' && part).join('\n')
      : null;
  return { questions: { asked: asked.map((q) => ({ member: nameOf(q.agentId), question: q.question })), answer } };
}

async function latestPlan(dispatch: Dispatch, ex: Executor) {
  const [plan] = await ex
    .select()
    .from(plans)
    .where(and(eq(plans.taskId, dispatch.taskId), eq(plans.cycle, dispatch.cycle)))
    .orderBy(desc(plans.version))
    .limit(1);
  return plan;
}

function planMaterial(plan: NonNullable<Awaited<ReturnType<typeof latestPlan>>>, nameOf: NameOf): PlanMaterial {
  const content = plan.content as unknown as PlanReport;
  return {
    version: plan.version,
    source: plan.source,
    summary: content.summary,
    packages: content.packages.map((p) => ({ ...p, owner: nameOf(p.owner) })),
    integration: content.integration,
    verification: content.verification,
  };
}

/** Objections from the review of a plan: reviews dispatched once it was recorded. */
async function objections(
  dispatch: Dispatch,
  planId: string,
  nameOf: NameOf,
  ex: Executor
): Promise<WorkshopMaterials['objections']> {
  const rows = await ex
    .select({ agentId: dispatches.agentId, report: dispatchReports.report })
    .from(dispatches)
    .innerJoin(dispatchReports, eq(dispatchReports.dispatchId, dispatches.id))
    .where(
      and(
        eq(dispatches.taskId, dispatch.taskId),
        eq(dispatches.phase, 'plan_review'),
        eq(dispatches.cycle, dispatch.cycle),
        eq(dispatches.status, 'reported'),
        // At full precision in SQL; the plan and the first reviews can share a transaction.
        gte(dispatches.createdAt, sql`(SELECT ${plans.createdAt} FROM ${plans} WHERE ${plans.id} = ${planId})`)
      )
    )
    .orderBy(asc(dispatches.createdAt));
  return rows
    .map((r) => ({ agentId: r.agentId, review: r.report as unknown as PlanReviewReport }))
    .filter((r) => r.review.verdict === 'object')
    .map((r) => ({ member: nameOf(r.agentId), comments: r.review.comments }));
}
