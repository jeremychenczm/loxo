import { z } from 'zod';
import { badRequest } from '../../http/errors';

/** Most questions one exploration may put to a person. */
export const MAX_EXPLORATION_QUESTIONS = 5;
/** Most work packages one plan may have. */
export const MAX_PACKAGES = 8;
const MAX_ACCEPTANCE = 10;

/** submit_exploration's arguments, shared by the MCP tool and the service. */
export const explorationShape = {
  summary: z.string().trim().min(1).max(20_000),
  questions: z.array(z.string().trim().min(1).max(2_000)).max(MAX_EXPLORATION_QUESTIONS).optional(),
};

export interface ExplorationReport {
  summary: string;
  questions: string[];
}

const packageShape = z
  .object({
    key: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'use lowercase letters, digits and dashes, at most 32 characters'),
    title: z.string().trim().min(1).max(200),
    /** A member's name, as the prompt lists them. */
    owner: z.string().trim().min(1).max(200),
    /** The files or area the package owns, so parallel packages do not collide. */
    area: z.string().trim().min(1).max(2_000),
    dependsOn: z.array(z.string().trim().min(1)).max(MAX_PACKAGES).optional(),
    acceptance: z.array(z.string().trim().min(1).max(1_000)).min(1).max(MAX_ACCEPTANCE),
  })
  .strict();

/** submit_plan's arguments. */
export const planShape = {
  summary: z.string().trim().min(1).max(20_000),
  packages: z.array(packageShape).min(1).max(MAX_PACKAGES),
  integration: z.string().trim().min(1).max(5_000),
  verification: z.string().trim().min(1).max(5_000),
};

export interface PlanPackage {
  key: string;
  title: string;
  /** The owner's agent id. */
  owner: string;
  area: string;
  dependsOn: string[];
  acceptance: string[];
}

export interface PlanReport {
  summary: string;
  packages: PlanPackage[];
  integration: string;
  verification: string;
}

/** submit_plan_review's arguments. */
export const planReviewShape = {
  verdict: z.enum(['approve', 'object']),
  comments: z.string().trim().max(10_000).optional(),
};

export interface PlanReviewReport {
  verdict: 'approve' | 'object';
  comments: string;
}

/** Who may own a package: the members still taking part. */
export interface ReportContext {
  members: { agentId: string; name: string }[];
}

const REPORT_SCHEMAS: Readonly<Record<string, z.ZodTypeAny>> = {
  submit_exploration: z
    .object(explorationShape)
    .strict()
    .transform((r): ExplorationReport => ({ summary: r.summary, questions: r.questions ?? [] })),
  submit_plan: z.object(planShape).strict(),
  submit_plan_review: z
    .object(planReviewShape)
    .strict()
    .refine((r) => r.verdict === 'approve' || Boolean(r.comments), {
      message: 'an objection needs comments saying what to change',
      path: ['comments'],
    })
    .transform((r): PlanReviewReport => ({ verdict: r.verdict, comments: r.comments ?? '' })),
};

/**
 * Validates and normalizes a phase report. A plan is also checked against
 * the members taking part: owners must be among them, package keys unique,
 * and dependencies must name other packages without a cycle; owners are
 * stored by agent id. Reports without a schema are stored as given.
 */
export function parseReport(
  tool: string,
  input: Record<string, unknown>,
  context: ReportContext = { members: [] }
): Record<string, unknown> {
  const schema = REPORT_SCHEMAS[tool];
  if (!schema) return input;
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || 'report'}: ${i.message}`).join('; ');
    throw badRequest('invalid_report', detail);
  }
  if (tool !== 'submit_plan') return parsed.data as Record<string, unknown>;
  return checkPlan(parsed.data as z.infer<z.ZodObject<typeof planShape>>, context) as unknown as Record<string, unknown>;
}

function checkPlan(plan: z.infer<z.ZodObject<typeof planShape>>, context: ReportContext): PlanReport {
  const problems: string[] = [];
  const keys = plan.packages.map((p) => p.key);
  for (const key of new Set(keys.filter((k, i) => keys.indexOf(k) !== i))) problems.push(`package key "${key}" is used twice`);

  const packages: PlanPackage[] = plan.packages.map((p) => {
    const owner = context.members.find(
      (m) => m.agentId === p.owner || m.name.toLowerCase() === p.owner.toLowerCase()
    );
    if (!owner) {
      problems.push(`package "${p.key}": owner "${p.owner}" is not a member; use one of ${context.members.map((m) => m.name).join(', ')}`);
    }
    const dependsOn = [...new Set(p.dependsOn ?? [])];
    for (const dep of dependsOn) {
      if (dep === p.key) problems.push(`package "${p.key}" depends on itself`);
      else if (!keys.includes(dep)) problems.push(`package "${p.key}" depends on "${dep}", which is not in the plan`);
    }
    return { key: p.key, title: p.title, owner: owner?.agentId ?? p.owner, area: p.area, dependsOn, acceptance: p.acceptance };
  });

  const cycle = dependencyCycle(packages);
  if (cycle) problems.push(`dependencies form a cycle: ${cycle.join(' -> ')}`);
  if (problems.length > 0) throw badRequest('invalid_plan', problems.join('; '));
  return { summary: plan.summary, packages, integration: plan.integration, verification: plan.verification };
}

/** A dependency cycle as a list of keys ending where it started, or null. */
function dependencyCycle(packages: PlanPackage[]): string[] | null {
  const deps = new Map(packages.map((p) => [p.key, p.dependsOn.filter((d) => d !== p.key)]));
  const state = new Map<string, 'open' | 'done'>();
  const path: string[] = [];
  const visit = (key: string): string[] | null => {
    if (state.get(key) === 'done') return null;
    if (state.get(key) === 'open') return [...path.slice(path.indexOf(key)), key];
    state.set(key, 'open');
    path.push(key);
    for (const dep of deps.get(key) ?? []) {
      const found = visit(dep);
      if (found) return found;
    }
    path.pop();
    state.set(key, 'done');
    return null;
  };
  for (const key of deps.keys()) {
    const found = visit(key);
    if (found) return found;
  }
  return null;
}

/** The questions an exploration report put to a person; empty for anything else. */
export function questionsOf(report: Record<string, unknown> | null): string[] {
  const questions = report?.questions;
  return Array.isArray(questions) ? questions.filter((q): q is string => typeof q === 'string') : [];
}
