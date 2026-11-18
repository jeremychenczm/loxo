/**
 * Transport-neutral surface for driving an agent runtime. Both ways Loxo
 * reaches an agent — a long-lived ACP session or a provider API — implement
 * AgentHost, so callers never branch on transport.
 */

export type HostTransport = 'acp' | 'api';

/** Normalized runtime activity, persisted as run events and streamed to the room. */
export type HostEvent =
  | { kind: 'message_delta'; text: string }
  | { kind: 'thought_delta'; text: string }
  | {
      kind: 'tool_call';
      toolCallId: string;
      title: string;
      toolKind: string;
      status: string;
      paths: string[];
      input?: unknown;
    }
  | { kind: 'tool_update'; toolCallId: string; status: string | null; output: string | null }
  | {
      kind: 'permission';
      toolCallId: string;
      title: string;
      toolKind: string;
      decision: PermissionDecision;
    }
  | { kind: 'usage'; contextUsed: number; contextSize: number; costUsd: number | null }
  | { kind: 'status'; message: string }
  | { kind: 'error'; message: string };

/** What the agent asked to do; paths are absolute as reported by the runtime. */
export interface PermissionRequest {
  toolCallId: string;
  title: string;
  toolKind: string;
  paths: string[];
  input: unknown;
}

export interface PermissionDecision {
  outcome: 'allow' | 'deny';
  /** Shown to the agent and recorded on the run. */
  reason: string;
}

/** Decides every permission request a runtime raises; the policy engine implements it. */
export type PermissionArbiter = (request: PermissionRequest) => Promise<PermissionDecision>;

/** MCP servers handed to the runtime when the session opens. */
export type HostMcpServer =
  | { type: 'http'; name: string; url: string; headers: Record<string, string> }
  | { type: 'stdio'; name: string; command: string; args: string[]; env: Record<string, string> };

export interface OpenSessionInput {
  /** Absolute working directory; for code work, the member's worktree. */
  cwd: string;
  mcpServers: HostMcpServer[];
  arbiter: PermissionArbiter;
  model?: string | null;
  /** Runtime session to continue; hosts that cannot resume start fresh and say so. */
  resumeSessionId?: string | null;
  /** Aborting abandons startup: the host kills whatever it spawned and rejects. */
  signal?: AbortSignal;
}

export interface TurnInput {
  prompt: string;
  onEvent?: (event: HostEvent) => void;
}

/**
 * end_turn and friends come from the runtime. crashed: the process died;
 * timeout: a watchdog stopped a turn that never started or never ended;
 * stalled: activity continued without progress; error: protocol failure.
 */
export type TurnStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled'
  | 'crashed'
  | 'timeout'
  | 'stalled'
  | 'error';

export interface TurnUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export interface TurnOutcome {
  stopReason: TurnStopReason;
  /** The agent's message text for the turn, concatenated. */
  text: string;
  usage: TurnUsage;
  error: string | null;
}

export interface AgentSession {
  readonly sessionId: string;
  /** The runtime's own id for this conversation, for resuming later; null when it cannot resume. */
  readonly runtimeSessionId: string | null;
  /** True when resumeSessionId was honored; false means the runtime starts with no memory. */
  readonly resumed: boolean;
  /** One turn at a time; a second concurrent call rejects. */
  prompt(turn: TurnInput): Promise<TurnOutcome>;
  /** Asks the runtime to stop the turn in flight; the prompt resolves with `cancelled`. */
  cancel(): Promise<void>;
  /** Ends the session and its process tree. Idempotent. */
  close(): Promise<void>;
}

export interface AgentHost {
  readonly transport: HostTransport;
  openSession(input: OpenSessionInput): Promise<AgentSession>;
}
