import crypto from 'node:crypto';
import { RunnerError, type TurnResult } from '@swarmdev/shared';
import {
  executeApiToolLoop,
  type ApiToolDefinition,
  type ApiToolLoopRequest,
} from '../runner/api-tool-loop';
import type { ApiProtocol } from '../runner/api-turn';
import type {
  AgentHost,
  AgentSession,
  OpenSessionInput,
  TurnInput,
  TurnOutcome,
  TurnStopReason,
} from './host.types';
import { repoReadTools, type RepoReadContext } from './repo-read-tools';

const REPO_TOOLS = new Set(['read_file', 'list_files', 'get_diff', 'get_checks']);

export interface ApiHostConfig {
  protocol: ApiProtocol;
  apiKey: string;
  baseUrl?: string | null;
  model: string;
  system: string;
  turnTimeoutMs?: number;
  /** Scope for the read-only repository tools; the root is the session cwd. */
  repo?: Omit<RepoReadContext, 'root'>;
  /** Platform tools offered beside repository reading, such as the control plane. */
  extraTools?: ApiToolDefinition[];
  /** Test seam; defaults to the real provider tool loop. */
  execute?: (request: ApiToolLoopRequest) => Promise<TurnResult>;
}

const STOP_FOR_ERROR: Record<string, TurnStopReason> = { timeout: 'timeout', aborted: 'cancelled' };

/**
 * A provider-API member. It has no file system or shell: it can read the
 * worktree through platform tools and nothing else, which is why the engine
 * only seats it in read-only phases. History lives in memory, so a new
 * session never resumes an old one.
 */
class ApiSession implements AgentSession {
  readonly sessionId = `api-${crypto.randomUUID()}`;
  readonly resumed = false;
  readonly runtimeSessionId = null;
  private readonly history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  private active: AbortController | null = null;

  constructor(
    private readonly config: ApiHostConfig,
    private readonly input: OpenSessionInput
  ) {}

  async prompt(turn: TurnInput): Promise<TurnOutcome> {
    if (this.active) throw new Error('A turn is already running in this session');
    const controller = new AbortController();
    this.active = controller;
    const tools = [
      ...repoReadTools({ root: this.input.cwd, ...this.config.repo }),
      ...(this.config.extraTools ?? []),
    ];
    try {
      const result = await (this.config.execute ?? executeApiToolLoop)({
        protocol: this.config.protocol,
        apiKey: this.config.apiKey,
        baseUrl: this.config.baseUrl,
        model: this.input.model ?? this.config.model,
        system: this.config.system,
        prompt: turn.prompt,
        history: [...this.history],
        tools,
        timeoutMs: this.config.turnTimeoutMs,
        signal: controller.signal,
        onToolCall: (call) => {
          if (call.phase === 'start') {
            turn.onEvent?.({
              kind: 'tool_call',
              toolCallId: call.id,
              title: call.name,
              toolKind: REPO_TOOLS.has(call.name) ? 'read' : 'other',
              status: 'in_progress',
              paths: [],
              input: call.args,
            });
          } else {
            turn.onEvent?.({
              kind: 'tool_update',
              toolCallId: call.id,
              status: call.isError ? 'failed' : 'completed',
              output: call.result.slice(0, 4000),
            });
          }
        },
      });
      if (result.text) turn.onEvent?.({ kind: 'message_delta', text: result.text });
      this.history.push({ role: 'user', content: turn.prompt }, { role: 'assistant', content: result.text });
      return {
        stopReason: 'end_turn',
        text: result.text,
        usage: {
          inputTokens: result.usage?.inputTokens ?? null,
          outputTokens: result.usage?.outputTokens ?? null,
          costUsd: null,
        },
        error: null,
      };
    } catch (err) {
      const kind = err instanceof RunnerError ? err.kind : 'api_failed';
      return {
        stopReason: STOP_FOR_ERROR[kind] ?? 'error',
        text: '',
        usage: { inputTokens: null, outputTokens: null, costUsd: null },
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      this.active = null;
    }
  }

  async cancel(): Promise<void> {
    this.active?.abort();
  }

  async close(): Promise<void> {
    this.active?.abort();
  }
}

export class ApiHost implements AgentHost {
  readonly transport = 'api' as const;

  constructor(private readonly config: ApiHostConfig) {}

  async openSession(input: OpenSessionInput): Promise<AgentSession> {
    return new ApiSession(this.config, input);
  }
}
