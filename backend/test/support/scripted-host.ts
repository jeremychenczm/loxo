import crypto from 'node:crypto';
import { RunnerError, type TurnPermission } from '@swarmdev/shared';
import type {
  AgentHost,
  AgentSession,
  OpenSessionInput,
  TurnInput,
  TurnOutcome,
  TurnStopReason,
} from '../../src/modules/hosts/host.types';
import type { HostRequest } from '../../src/modules/runs/task-run';

/** One turn as a scripted agent sees it. */
export interface ScriptedTurn {
  prompt: string;
  /** The session's working directory: the task worktree for code work. */
  workspace: string;
  permission: TurnPermission;
  signal: AbortSignal;
}

export interface ScriptedReply {
  text: string;
  /** Recorded as the runtime's resumable session id. */
  sessionRef?: string;
}

/** Throw a RunnerError to end the turn as a failure; its message becomes the run error. */
export type ScriptedAgent = (turn: ScriptedTurn) => Promise<ScriptedReply>;

const STOP_FOR_KIND: Record<string, TurnStopReason> = { timeout: 'timeout', aborted: 'cancelled' };

class ScriptedSession implements AgentSession {
  readonly sessionId = `scripted-${crypto.randomUUID()}`;
  runtimeSessionId: string | null = null;
  readonly resumed = false;
  private active: AbortController | null = null;

  constructor(
    private readonly agent: ScriptedAgent,
    private readonly input: OpenSessionInput,
    private readonly permission: TurnPermission
  ) {}

  async prompt(turn: TurnInput): Promise<TurnOutcome> {
    if (this.active) throw new Error('A turn is already running in this session');
    const controller = new AbortController();
    this.active = controller;
    try {
      const reply = await this.agent({
        prompt: turn.prompt,
        workspace: this.input.cwd,
        permission: this.permission,
        signal: controller.signal,
      });
      if (reply.sessionRef) this.runtimeSessionId = reply.sessionRef;
      if (reply.text) turn.onEvent?.({ kind: 'message_delta', text: reply.text });
      return { stopReason: 'end_turn', text: reply.text, usage: emptyUsage(), error: null };
    } catch (err) {
      const kind = err instanceof RunnerError ? err.kind : 'cli_failed';
      return {
        stopReason: STOP_FOR_KIND[kind] ?? 'error',
        text: '',
        usage: emptyUsage(),
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

function emptyUsage() {
  return { inputTokens: null, outputTokens: null, costUsd: null };
}

/** Host factory for `setTaskHostFactoryForTests`, driven by an in-process script. */
export function scriptedHost(agent: ScriptedAgent): (request: HostRequest) => AgentHost {
  return (request) => ({
    transport: 'acp',
    openSession: async (input) => new ScriptedSession(agent, input, request.permission),
  });
}
