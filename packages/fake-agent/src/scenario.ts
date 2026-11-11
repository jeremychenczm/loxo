import { z } from 'zod';

/**
 * A scripted agent run. Each `session/prompt` plays the next turn script; the
 * last one repeats once the list runs out. Steps cover the behaviors a host
 * must survive: streaming, tool calls, permission requests, usage reports,
 * stalls, crashes, and malformed output.
 */
export type Step =
  | { say: string }
  | { think: string }
  | {
      tool: {
        id: string;
        title: string;
        kind?: ToolKind;
        status?: 'pending' | 'in_progress';
        paths?: string[];
        input?: unknown;
      };
    }
  | { toolDone: { id: string; status?: 'completed' | 'failed'; output?: string } }
  | {
      permission: {
        toolCallId: string;
        title: string;
        kind?: ToolKind;
        /** Plays when the client picks an allow option. */
        onAllow?: Step[];
        /** Plays when the client picks a reject option. */
        onReject?: Step[];
        /** Plays when the client answers `cancelled`. */
        onCancel?: Step[];
      };
    }
  | { contextUsage: { used: number; size: number; costUsd?: number } }
  | { sleep: number }
  /** Never returns; `ignoreCancel` also ignores `session/cancel`. */
  | { hang: { ignoreCancel?: boolean } }
  | { crash: number }
  /** A raw stdout line that is not JSON-RPC. */
  | { garbage: string }
  | { stderr: string }
  /** Writes inside the session cwd; paths outside it are refused. */
  | { writeFile: { path: string; content: string } }
  | { repeat: { times: number; steps: Step[] } };

export type ToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'other';

export interface TurnScript {
  steps: Step[];
  stopReason?: 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal';
  /** Reported on the prompt response. */
  usage?: { inputTokens: number; outputTokens: number };
}

export interface Scenario {
  /** Misbehavior before `initialize` is answered. */
  startup?: 'ok' | 'hang' | 'crash' | 'garbage';
  /** Advertise and honor `session/load`. */
  loadSession?: boolean;
  turns: TurnScript[];
}

const toolKind = z.enum(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'other']);

const stepSchema: z.ZodType<Step> = z.lazy(() =>
  z.union([
    z.object({ say: z.string() }).strict(),
    z.object({ think: z.string() }).strict(),
    z
      .object({
        tool: z
          .object({
            id: z.string().min(1),
            title: z.string(),
            kind: toolKind.optional(),
            status: z.enum(['pending', 'in_progress']).optional(),
            paths: z.array(z.string()).optional(),
            input: z.unknown().optional(),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        toolDone: z
          .object({
            id: z.string().min(1),
            status: z.enum(['completed', 'failed']).optional(),
            output: z.string().optional(),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        permission: z
          .object({
            toolCallId: z.string().min(1),
            title: z.string(),
            kind: toolKind.optional(),
            onAllow: z.array(stepSchema).optional(),
            onReject: z.array(stepSchema).optional(),
            onCancel: z.array(stepSchema).optional(),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        contextUsage: z
          .object({ used: z.number().int().nonnegative(), size: z.number().int().positive(), costUsd: z.number().optional() })
          .strict(),
      })
      .strict(),
    z.object({ sleep: z.number().int().nonnegative() }).strict(),
    z.object({ hang: z.object({ ignoreCancel: z.boolean().optional() }).strict() }).strict(),
    z.object({ crash: z.number().int() }).strict(),
    z.object({ garbage: z.string() }).strict(),
    z.object({ stderr: z.string() }).strict(),
    z.object({ writeFile: z.object({ path: z.string().min(1), content: z.string() }).strict() }).strict(),
    z
      .object({
        repeat: z.object({ times: z.number().int().min(1).max(10_000), steps: z.array(stepSchema) }).strict(),
      })
      .strict(),
  ])
);

const scenarioSchema = z
  .object({
    startup: z.enum(['ok', 'hang', 'crash', 'garbage']).optional(),
    loadSession: z.boolean().optional(),
    turns: z
      .array(
        z
          .object({
            steps: z.array(stepSchema),
            stopReason: z.enum(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal']).optional(),
            usage: z
              .object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() })
              .strict()
              .optional(),
          })
          .strict()
      )
      .min(1),
  })
  .strict();

export function parseScenario(input: unknown): Scenario {
  return scenarioSchema.parse(input);
}
