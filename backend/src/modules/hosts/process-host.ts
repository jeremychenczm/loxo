import crypto from 'node:crypto';
import {
  runTurn,
  RunnerError,
  type CliRuntime,
  type TurnCredentials,
  type TurnPermission,
  type TurnRequest,
  type TurnResult,
} from '@swarmdev/shared';
import type {
  AgentHost,
  AgentSession,
  OpenSessionInput,
  TurnInput,
  TurnOutcome,
  TurnStopReason,
} from './host.types';

/** Runtimes whose CLI can continue a previous conversation by id. */
const RESUMABLE: ReadonlySet<CliRuntime> = new Set(['claude-code']);

export interface ProcessHostConfig {
  runtime: CliRuntime;
  /** Runtime state directory, kept outside the workspace. */
  stateDir: string;
  credentials?: TurnCredentials;
  /**
   * Enforced through CLI flags only: this transport cannot consult the
   * arbiter per action, so the level is fixed for the whole turn.
   */
  permission: TurnPermission;
  turnTimeoutMs?: number;
  extraEnv?: Record<string, string>;
  /** Test seam; defaults to the real process runner. */
  execute?: (request: TurnRequest) => Promise<TurnResult>;
}

const STOP_FOR_ERROR: Record<string, TurnStopReason> = {
  timeout: 'timeout',
  aborted: 'cancelled',
};

/** The control plane rides as the first HTTP MCP server with a bearer token. */
function controlPlaneOf(input: OpenSessionInput): { url: string; token: string } | undefined {
  for (const server of input.mcpServers) {
    if (server.type !== 'http') continue;
    const auth = Object.entries(server.headers).find(([name]) => name.toLowerCase() === 'authorization');
    const token = auth?.[1].replace(/^Bearer\s+/i, '');
    if (token) return { url: server.url, token };
  }
  return undefined;
}

class ProcessSession implements AgentSession {
  sessionId: string;
  readonly resumed: boolean;
  private sessionRef: string | null;
  private active: AbortController | null = null;
  private closed = false;

  constructor(
    private readonly config: ProcessHostConfig,
    private readonly input: OpenSessionInput
  ) {
    const canResume = RESUMABLE.has(config.runtime) && Boolean(input.resumeSessionId);
    this.resumed = canResume;
    this.sessionRef = canResume ? input.resumeSessionId! : null;
    this.sessionId = this.sessionRef ?? `process-${crypto.randomUUID()}`;
  }

  async prompt(turn: TurnInput): Promise<TurnOutcome> {
    if (this.active) throw new Error('A turn is already running in this session');
    if (this.closed) throw new Error('The session is closed');
    const controller = new AbortController();
    this.active = controller;
    let streamed = false;
    try {
      const result = await (this.config.execute ?? runTurn)({
        runtime: this.config.runtime,
        workspace: this.input.cwd,
        stateDir: this.config.stateDir,
        prompt: turn.prompt,
        model: this.input.model ?? null,
        credentials: this.config.credentials,
        sessionRef: this.sessionRef,
        timeoutMs: this.config.turnTimeoutMs,
        signal: controller.signal,
        permission: this.config.permission,
        mcp: controlPlaneOf(this.input),
        extraEnv: this.config.extraEnv,
        onChunk: (text) => {
          streamed = true;
          turn.onEvent?.({ kind: 'message_delta', text });
        },
      });
      if (!streamed && result.text) turn.onEvent?.({ kind: 'message_delta', text: result.text });
      if (result.sessionRef && RESUMABLE.has(this.config.runtime)) {
        this.sessionRef = result.sessionRef;
        this.sessionId = result.sessionRef;
      }
      return {
        stopReason: 'end_turn',
        text: result.text,
        usage: { inputTokens: null, outputTokens: null, costUsd: null },
        error: null,
      };
    } catch (err) {
      const kind = err instanceof RunnerError ? err.kind : 'cli_failed';
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
    this.closed = true;
    this.active?.abort();
  }
}

/** A fresh CLI process per turn; the fallback for runtimes without ACP. */
export class ProcessHost implements AgentHost {
  readonly transport = 'process' as const;

  constructor(private readonly config: ProcessHostConfig) {}

  async openSession(input: OpenSessionInput): Promise<AgentSession> {
    return new ProcessSession(this.config, input);
  }
}
