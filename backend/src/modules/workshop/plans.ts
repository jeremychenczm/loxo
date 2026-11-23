import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Tx } from '../../db/client';
import { dispatchReports, plans, tasks, workPackages, type PlanSource, type Task } from '../../db/schema';
import { canonicalJson } from '../../lib/canonical-json';
import type { PlanReport } from './reports';
import { snapshotOf } from './state';

const MAX_BRIEF_IN_ACCEPTANCE = 900;

export function planHash(content: PlanReport): string {
  return createHash('sha256').update(canonicalJson(content)).digest('hex');
}

/** The plan the workshop falls back to when the lead gave none it could accept: the lead builds everything. */
export function degradedPlan(task: Pick<Task, 'title' | 'brief' | 'leadAgentId' | 'snapshot'>): PlanReport {
  const snapshot = snapshotOf(task);
  const brief = (snapshot?.brief ?? task.brief).trim();
  return {
    summary: 'The lead gave no plan the platform could accept, so the lead builds the whole task as one package.',
    packages: [
      {
        key: 'main',
        title: snapshot?.title ?? task.title,
        owner: snapshot?.leadAgentId ?? task.leadAgentId ?? '',
        area: 'Everything the task touches',
        dependsOn: [],
        acceptance: [brief ? `The brief is met: ${brief.slice(0, MAX_BRIEF_IN_ACCEPTANCE)}` : 'The task is done as described'],
      },
    ],
    integration: 'One package; nothing to integrate.',
    verification: 'The checks configured for the task, and a review of the change against the brief.',
  };
}

/**
 * Records a plan version: the lead's report as submitted (already validated
 * and normalized by the tool), or the degraded plan. Keyed by version, so a
 * repeated advance records nothing new.
 */
export async function recordPlan(
  tx: Tx,
  task: Task,
  plan: { version: number; round: number; source: PlanSource; dispatchId: string | null }
): Promise<void> {
  let content: PlanReport;
  if (plan.source === 'lead') {
    const [report] = await tx.select().from(dispatchReports).where(eq(dispatchReports.dispatchId, plan.dispatchId!));
    if (!report) throw new Error(`Dispatch ${plan.dispatchId} has no plan to record`);
    content = report.report as unknown as PlanReport;
  } else {
    content = degradedPlan(task);
  }
  await tx
    .insert(plans)
    .values({
      taskId: task.id,
      cycle: task.cycle,
      version: plan.version,
      round: plan.round,
      source: plan.source,
      dispatchId: plan.dispatchId,
      content: content as unknown as Record<string, unknown>,
      hash: planHash(content),
    })
    .onConflictDoNothing();
}

/** Pins a plan on the task and writes its work packages; both are idempotent. */
export async function pinPlan(tx: Tx, task: Pick<Task, 'id'>, planId: string): Promise<void> {
  const [plan] = await tx.select().from(plans).where(eq(plans.id, planId));
  if (!plan) throw new Error(`Plan ${planId} does not exist`);
  const content = plan.content as unknown as PlanReport;
  for (const p of content.packages) {
    await tx
      .insert(workPackages)
      .values({
        taskId: task.id,
        planId: plan.id,
        key: p.key,
        title: p.title,
        ownerAgentId: p.owner || null,
        area: p.area,
        dependsOn: p.dependsOn,
        acceptance: p.acceptance,
      })
      .onConflictDoNothing();
  }
  await tx.update(tasks).set({ planHash: plan.hash, updatedAt: new Date() }).where(eq(tasks.id, task.id));
}
