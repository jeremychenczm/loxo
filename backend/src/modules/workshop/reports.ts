import { z } from 'zod';
import { badRequest } from '../../http/errors';

/** Most questions one exploration may put to a person. */
export const MAX_EXPLORATION_QUESTIONS = 5;

/** submit_exploration's arguments, shared by the MCP tool and the service. */
export const explorationShape = {
  summary: z.string().trim().min(1).max(20_000),
  questions: z.array(z.string().trim().min(1).max(2_000)).max(MAX_EXPLORATION_QUESTIONS).optional(),
};

export interface ExplorationReport {
  summary: string;
  questions: string[];
}

const REPORT_SCHEMAS: Readonly<Record<string, z.ZodType<Record<string, unknown>>>> = {
  submit_exploration: z
    .object(explorationShape)
    .strict()
    .transform((r): ExplorationReport & Record<string, unknown> => ({ summary: r.summary, questions: r.questions ?? [] })),
};

/** Validates and normalizes a phase report. Reports without a schema are stored as given. */
export function parseReport(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  const schema = REPORT_SCHEMAS[tool];
  if (!schema) return input;
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || 'report'}: ${i.message}`).join('; ');
    throw badRequest('invalid_report', detail);
  }
  return parsed.data;
}

/** The questions an exploration report put to a person; empty for anything else. */
export function questionsOf(report: Record<string, unknown> | null): string[] {
  const questions = report?.questions;
  return Array.isArray(questions) ? questions.filter((q): q is string => typeof q === 'string') : [];
}
