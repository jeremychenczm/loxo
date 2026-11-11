import type { AgentSession, HostEvent, TurnInput, TurnOutcome, TurnStopReason } from './host.types';

/**
 * Turn supervision. Liveness and progress are judged separately: an agent
 * that keeps emitting thoughts or repeating itself is alive but stuck, while
 * a long-running tool call is quiet but busy and gets a wider window.
 */
export interface WatchdogLimits {
  /** No events at all for this long stops the turn. */
  idleMs: number;
  /** The idle window while a tool call is still running. */
  toolIdleMs: number;
  /** Events without progress — no new tool work and no new message text — for this long stops the turn. */
  progressMs: number;
  /** Hard ceiling for one turn. */
  maxTurnMs: number;
  /** After asking the runtime to cancel, how long to wait before killing it. */
  cancelGraceMs: number;
  /** A message line at least this long, seen this many times in one turn, is a loop. */
  repeatedLine: { minLength: number; maxRepeats: number };
}

export const DEFAULT_WATCHDOG_LIMITS: WatchdogLimits = {
  idleMs: 120_000,
  toolIdleMs: 900_000,
  progressMs: 600_000,
  maxTurnMs: 3_600_000,
  cancelGraceMs: 10_000,
  repeatedLine: { minLength: 20, maxRepeats: 5 },
};

/** Bounds memory on very long turns; lines past the cap are still counted if already known. */
const MAX_TRACKED_LINES = 2000;

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

interface Verdict {
  stopReason: Extract<TurnStopReason, 'timeout' | 'stalled'>;
  message: string;
}

class TurnMonitor {
  private lastEventAt = Date.now();
  private lastProgressAt = Date.now();
  private readonly startedAt = Date.now();
  private readonly runningTools = new Set<string>();
  private readonly lineCounts = new Map<string, number>();
  private pendingText = '';
  verdict: Verdict | null = null;

  constructor(private readonly limits: WatchdogLimits) {}

  observe(event: HostEvent): void {
    const now = Date.now();
    this.lastEventAt = now;
    switch (event.kind) {
      case 'tool_call':
        this.runningTools.add(event.toolCallId);
        this.lastProgressAt = now;
        break;
      case 'tool_update':
        if (event.status === 'completed' || event.status === 'failed') {
          this.runningTools.delete(event.toolCallId);
          this.lastProgressAt = now;
        }
        break;
      case 'permission':
        this.lastProgressAt = now;
        break;
      case 'message_delta':
        if (this.recordText(event.text)) this.lastProgressAt = now;
        break;
      default:
        break;
    }
  }

  /**
   * Returns whether the text added anything new, splitting it into lines and
   * sentences. A fragment still being typed counts as new only while it is
   * not a replay of a line already seen. Flags a loop when a line repeats.
   */
  private recordText(text: string): boolean {
    this.pendingText += text;
    const segments = this.pendingText.split(/\n|(?<=[.!?。！？])\s+/);
    this.pendingText = segments.pop() ?? '';
    let fresh = false;
    const { minLength, maxRepeats } = this.limits.repeatedLine;
    for (const raw of segments) {
      const line = normalize(raw);
      if (!line) continue;
      const seen = (this.lineCounts.get(line) ?? 0) + 1;
      if (this.lineCounts.size < MAX_TRACKED_LINES || this.lineCounts.has(line)) {
        this.lineCounts.set(line, seen);
      }
      if (seen === 1) fresh = true;
      if (line.length >= minLength && seen >= maxRepeats && !this.verdict) {
        this.verdict = {
          stopReason: 'stalled',
          message: `The agent repeated the same line ${seen} times: "${raw.trim().slice(0, 120)}"`,
        };
      }
    }
    const partial = normalize(this.pendingText);
    if (partial && ![...this.lineCounts.keys()].some((known) => known.startsWith(partial))) fresh = true;
    return fresh;
  }

  /** Checks the clocks; sets and returns a verdict once a limit is crossed. */
  check(): Verdict | null {
    if (this.verdict) return this.verdict;
    const now = Date.now();
    // A running tool is busy by definition: a long build emits nothing until it ends.
    const toolRunning = this.runningTools.size > 0;
    const idleLimit = toolRunning ? this.limits.toolIdleMs : this.limits.idleMs;
    const progressLimit = toolRunning
      ? Math.max(this.limits.progressMs, this.limits.toolIdleMs)
      : this.limits.progressMs;
    if (now - this.startedAt >= this.limits.maxTurnMs) {
      this.verdict = { stopReason: 'timeout', message: `The turn exceeded ${this.limits.maxTurnMs} ms` };
    } else if (now - this.lastEventAt >= idleLimit) {
      this.verdict = { stopReason: 'timeout', message: `No activity from the agent for ${idleLimit} ms` };
    } else if (now - this.lastProgressAt >= progressLimit) {
      this.verdict = {
        stopReason: 'stalled',
        message: `The agent made no progress for ${progressLimit} ms`,
      };
    }
    return this.verdict;
  }
}

const TICK_FLOOR_MS = 25;

class WatchedSession implements AgentSession {
  private dead = false;

  constructor(
    private readonly inner: AgentSession,
    private readonly limits: WatchdogLimits
  ) {}

  get sessionId(): string {
    return this.inner.sessionId;
  }

  get resumed(): boolean {
    return this.inner.resumed;
  }

  async prompt(turn: TurnInput): Promise<TurnOutcome> {
    const monitor = new TurnMonitor(this.limits);
    const pending = this.inner.prompt({
      ...turn,
      onEvent: (event) => {
        monitor.observe(event);
        turn.onEvent?.(event);
      },
    });

    const tickMs = Math.max(
      TICK_FLOOR_MS,
      Math.min(this.limits.idleMs, this.limits.progressMs, this.limits.maxTurnMs) / 10
    );
    let timer: NodeJS.Timeout | undefined;
    const tripped = new Promise<Verdict>((resolve) => {
      const tick = () => {
        const verdict = monitor.check();
        if (verdict) resolve(verdict);
        else timer = setTimeout(tick, tickMs);
      };
      timer = setTimeout(tick, tickMs);
    });

    const first = await Promise.race([pending.then((outcome) => ({ outcome })), tripped.then((verdict) => ({ verdict }))]);
    clearTimeout(timer);
    if ('outcome' in first) {
      // A loop detected on the final chunk still counts against the turn.
      return monitor.verdict ? this.override(first.outcome, monitor.verdict) : first.outcome;
    }

    await this.inner.cancel();
    const settled = await Promise.race([
      pending,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), this.limits.cancelGraceMs)),
    ]);
    if (settled) return this.override(settled, first.verdict);

    // The runtime ignored cancellation; nothing short of killing it ends the turn.
    this.dead = true;
    await this.inner.close();
    return this.override(await pending, first.verdict, ' The agent ignored cancellation and was stopped.');
  }

  private override(outcome: TurnOutcome, verdict: Verdict, suffix = ''): TurnOutcome {
    return { ...outcome, stopReason: verdict.stopReason, error: `${verdict.message}.${suffix}` };
  }

  async cancel(): Promise<void> {
    if (!this.dead) await this.inner.cancel();
  }

  close(): Promise<void> {
    this.dead = true;
    return this.inner.close();
  }
}

/** Wraps a session so every turn runs under the watchdog. */
export function withWatchdog(
  session: AgentSession,
  limits: Partial<WatchdogLimits> = {}
): AgentSession {
  return new WatchedSession(session, { ...DEFAULT_WATCHDOG_LIMITS, ...limits });
}
