import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientConnection,
  type McpServer,
  type PermissionOption,
  type RequestPermissionResponse,
} from '@agentclientprotocol/sdk/unstable';
import { killProcessTree } from '@swarmdev/shared';
import { mapSessionUpdate } from './acp-events';
import type {
  AgentHost,
  AgentSession,
  HostEvent,
  HostMcpServer,
  OpenSessionInput,
  TurnInput,
  TurnOutcome,
} from './host.types';
import { childEnv } from '../../lib/child-env';

/** How to start an ACP agent process; the runtime catalog builds one per agent. */
export interface AcpLaunchSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface AcpHostOptions {
  /** Deadline for the process to answer `initialize` and open a session. */
  startupTimeoutMs?: number;
  /** Deadline for each attempt to restore an earlier session before falling back. */
  restoreTimeoutMs?: number;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const DEFAULT_RESTORE_TIMEOUT_MS = 15_000;
const STDERR_TAIL_CHARS = 4000;
/** How long a failed request waits for the exit event before calling it a protocol error. */
const EXIT_GRACE_MS = 1000;

/** Agent processes started by this backend that have not exited yet. */
const liveChildren = new Set<ChildProcess>();

/** Test seam: how many agent processes are still alive. */
export function liveAgentProcessesForTests(): number {
  return liveChildren.size;
}

export class HostStartupError extends Error {
  constructor(
    readonly reason: 'crashed' | 'timeout' | 'cancelled' | 'error',
    message: string
  ) {
    super(message);
    this.name = 'HostStartupError';
  }
}

function toAcpMcpServer(server: HostMcpServer): McpServer {
  if (server.type === 'http') {
    return {
      type: 'http',
      name: server.name,
      url: server.url,
      headers: Object.entries(server.headers).map(([name, value]) => ({ name, value })),
    };
  }
  return {
    name: server.name,
    command: server.command,
    args: server.args,
    env: Object.entries(server.env).map(([name, value]) => ({ name, value })),
  };
}

/** Prefers one-shot grants so a single approval never widens into a standing one. */
function pickOption(options: PermissionOption[], outcome: 'allow' | 'deny'): string | null {
  const order = outcome === 'allow' ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  for (const kind of order) {
    const match = options.find((o) => o.kind === kind);
    if (match) return match.optionId;
  }
  return null;
}

interface ActiveTurn {
  text: string;
  onEvent?: (event: HostEvent) => void;
  costAtStart: number | null;
}

class AcpSession implements AgentSession {
  sessionId = '';
  resumed = false;
  resumedBy: 'resume' | 'load' | null = null;

  get runtimeSessionId(): string | null {
    return this.sessionId || null;
  }

  private active: ActiveTurn | null = null;
  /** Session updates during `session/load` replay history; they are not new activity. */
  private loading = false;
  private exited = false;
  private stderrTail = '';
  private lastCost: number | null = null;
  private readonly exit: Promise<number | null>;
  private connection!: ClientConnection;

  private constructor(
    private readonly child: ChildProcess,
    private readonly input: OpenSessionInput,
    private readonly restoreTimeoutMs: number
  ) {
    this.exit = new Promise((resolve) => {
      child.once('exit', (code) => {
        this.exited = true;
        resolve(code);
      });
      child.once('error', () => {
        this.exited = true;
        resolve(null);
      });
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS);
    });
  }

  static async open(
    launch: AcpLaunchSpec,
    input: OpenSessionInput,
    options: AcpHostOptions
  ): Promise<AcpSession> {
    const child = spawn(launch.command, launch.args, {
      cwd: input.cwd,
      env: childEnv('agent', launch.env ?? {}),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    liveChildren.add(child);
    child.once('exit', () => liveChildren.delete(child));
    child.once('error', () => liveChildren.delete(child));
    const session = new AcpSession(child, input, options.restoreTimeoutMs ?? DEFAULT_RESTORE_TIMEOUT_MS);
    session.connect();
    const timeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([
        session.handshake(),
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new HostStartupError('cancelled', 'Agent startup was abandoned'));
          if (input.signal?.aborted) onAbort();
          else input.signal?.addEventListener('abort', onAbort, { once: true });
        }),
        session.exit.then(() => {
          throw new HostStartupError('crashed', session.describeExit('exited during startup'));
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new HostStartupError('timeout', `Agent did not start within ${timeoutMs} ms`)),
            timeoutMs
          );
        }),
      ]);
    } catch (err) {
      // A dying process closes the pipe before its exit event fires.
      const crashed = !(err instanceof HostStartupError) && (await session.exitedWithin(EXIT_GRACE_MS));
      await session.close();
      if (err instanceof HostStartupError) throw err;
      if (crashed) throw new HostStartupError('crashed', session.describeExit('exited during startup'));
      throw new HostStartupError('error', err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
      if (onAbort) input.signal?.removeEventListener('abort', onAbort);
    }
    return session;
  }

  private connect(): void {
    const app = client({ name: 'loxo' })
      .onNotification(methods.client.session.update, ({ params }) => {
        if (this.loading || params.sessionId !== this.sessionId || !this.active) return;
        const event = mapSessionUpdate(params.update);
        if (!event) return;
        if (event.kind === 'message_delta') this.active.text += event.text;
        if (event.kind === 'usage' && event.costUsd !== null) this.lastCost = event.costUsd;
        this.active.onEvent?.(event);
      })
      .onRequest(methods.client.session.requestPermission, async ({ params }) =>
        this.decidePermission(params.toolCall, params.options)
      );
    const stream = ndJsonStream(
      Writable.toWeb(this.child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(this.child.stdout!) as ReadableStream<Uint8Array>
    );
    this.connection = app.connect(stream);
  }

  private async handshake(): Promise<void> {
    const agent = this.connection.agent;
    const init = await agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const mcpServers = this.input.mcpServers.map(toAcpMcpServer);
    const previous = this.input.resumeSessionId;
    // Restore ladder: reattach without replay, then load with replay, then a
    // fresh session. A failed or stalled rung never fails the startup.
    if (previous) {
      const params = { sessionId: previous, cwd: this.input.cwd, mcpServers };
      const rungs: Array<['resume' | 'load', boolean, () => Promise<unknown>]> = [
        ['resume', Boolean(init.agentCapabilities?.sessionCapabilities?.resume), () => agent.request(methods.agent.session.resume, params)],
        ['load', Boolean(init.agentCapabilities?.loadSession), () => agent.request(methods.agent.session.load, params)],
      ];
      for (const [rung, offered, attempt] of rungs) {
        if (!offered) continue;
        this.loading = rung === 'load';
        try {
          await withDeadline(attempt(), this.restoreTimeoutMs);
          this.sessionId = previous;
          this.resumed = true;
          this.resumedBy = rung;
          return;
        } catch {
          // The runtime no longer has that session, or did not answer in time.
        } finally {
          this.loading = false;
        }
      }
    }
    const created = await agent.request(methods.agent.session.new, { cwd: this.input.cwd, mcpServers });
    this.sessionId = created.sessionId;
  }

  private async decidePermission(
    toolCall: { toolCallId: string; title?: string | null; kind?: string | null; locations?: { path: string }[] | null; rawInput?: unknown },
    options: PermissionOption[]
  ): Promise<RequestPermissionResponse> {
    const request = {
      toolCallId: toolCall.toolCallId,
      title: toolCall.title ?? '',
      toolKind: toolCall.kind ?? 'other',
      paths: (toolCall.locations ?? []).map((l) => l.path),
      input: toolCall.rawInput,
    };
    let decision;
    try {
      decision = await this.input.arbiter(request);
    } catch (err) {
      decision = {
        outcome: 'deny' as const,
        reason: `Permission check failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    this.active?.onEvent?.({
      kind: 'permission',
      toolCallId: request.toolCallId,
      title: request.title,
      toolKind: request.toolKind,
      decision,
    });
    const optionId = pickOption(options, decision.outcome);
    return optionId
      ? { outcome: { outcome: 'selected', optionId } }
      : { outcome: { outcome: 'cancelled' } };
  }

  /** Resolves true if the process exits within `ms`. */
  async exitedWithin(ms: number): Promise<boolean> {
    if (this.exited) return true;
    let timer: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      this.exit.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
    clearTimeout(timer);
    return result;
  }

  describeExit(what: string): string {
    const tail = this.stderrTail.trim();
    return tail ? `Agent ${what}: ${tail}` : `Agent ${what}`;
  }

  async prompt(turn: TurnInput): Promise<TurnOutcome> {
    if (this.active) throw new Error('A turn is already running in this session');
    if (this.exited) {
      return {
        stopReason: 'crashed',
        text: '',
        usage: { inputTokens: null, outputTokens: null, costUsd: null },
        error: this.describeExit('is no longer running'),
      };
    }
    const active: ActiveTurn = { text: '', onEvent: turn.onEvent, costAtStart: this.lastCost };
    this.active = active;
    try {
      const response = await Promise.race([
        this.connection.agent.request(methods.agent.session.prompt, {
          sessionId: this.sessionId,
          prompt: [{ type: 'text', text: turn.prompt }],
        }),
        this.exit.then(() => null),
      ]);
      const costUsd =
        this.lastCost !== null ? Math.max(0, this.lastCost - (active.costAtStart ?? 0)) : null;
      if (response === null) {
        return {
          stopReason: 'crashed',
          text: active.text,
          usage: { inputTokens: null, outputTokens: null, costUsd },
          error: this.describeExit('exited during the turn'),
        };
      }
      return {
        stopReason: response.stopReason,
        text: active.text,
        usage: {
          inputTokens: response.usage?.inputTokens ?? null,
          outputTokens: response.usage?.outputTokens ?? null,
          costUsd,
        },
        error: null,
      };
    } catch (err) {
      const crashed = await this.exitedWithin(EXIT_GRACE_MS);
      return {
        stopReason: crashed ? 'crashed' : 'error',
        text: active.text,
        usage: { inputTokens: null, outputTokens: null, costUsd: null },
        error: crashed
          ? this.describeExit('exited during the turn')
          : err instanceof Error
            ? err.message
            : String(err),
      };
    } finally {
      this.active = null;
    }
  }

  async cancel(): Promise<void> {
    if (!this.active || this.exited) return;
    await this.connection.agent
      .notify(methods.agent.session.cancel, { sessionId: this.sessionId })
      .catch(() => {});
  }

  async close(): Promise<void> {
    this.connection?.close();
    if (!this.exited) await killProcessTree(this.child);
    await this.exit;
  }
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`No answer within ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Long-lived ACP session over the agent's stdio. */
export class AcpHost implements AgentHost {
  readonly transport = 'acp' as const;

  constructor(
    private readonly launch: AcpLaunchSpec,
    private readonly options: AcpHostOptions = {}
  ) {}

  openSession(input: OpenSessionInput): Promise<AgentSession> {
    return AcpSession.open(this.launch, input, this.options);
  }
}
