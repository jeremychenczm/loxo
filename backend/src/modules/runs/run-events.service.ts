import { EventEmitter } from 'node:events';
import { and, asc, eq, gt } from 'drizzle-orm';
import { db } from '../../db/client';
import { runEvents, runs, type RunEvent, type RunEventKind } from '../../db/schema';
import { notFound } from '../../http/errors';
import type { HostEvent } from '../hosts/host.types';
import { redactValue } from './redact';

/** One persisted event as subscribers receive it. */
export interface RunEventFrame {
  userId: string;
  taskId: string | null;
  runId: string;
  seq: number;
  kind: RunEventKind;
  payload: Record<string, unknown>;
  createdAt: string;
}

/** Emits `event` with a RunEventFrame after each row commits; realtime channels listen here. */
export const runEventBus = new EventEmitter();
runEventBus.setMaxListeners(0);

export interface RecorderLimits {
  /** Rows per run; past it, one notice is written and the rest dropped. */
  maxEvents: number;
  /** Streamed text is buffered and written as one row per burst. */
  flushChars: number;
  flushMs: number;
}

export const DEFAULT_RECORDER_LIMITS: RecorderLimits = { maxEvents: 5000, flushChars: 2000, flushMs: 250 };

const TEXT_KINDS = { message_delta: 'message_delta', thought_delta: 'message_delta' } as const;

function toRow(event: Exclude<HostEvent, { kind: 'message_delta' | 'thought_delta' }>): {
  kind: RunEventKind;
  payload: Record<string, unknown>;
} {
  const { kind, ...rest } = event;
  switch (kind) {
    case 'tool_call':
      return { kind: 'tool_call', payload: rest };
    case 'tool_update':
      return { kind: 'tool_update', payload: rest };
    case 'permission':
      return { kind: 'permission', payload: rest };
    case 'usage':
      return { kind: 'usage', payload: rest };
    case 'status':
      return { kind: 'status', payload: rest };
    case 'error':
      return { kind: 'error', payload: rest };
  }
}

/**
 * Persists a run's host events in order. Writes are serialized so seq is
 * gapless and matches commit order; text deltas are coalesced so a token
 * stream costs a handful of rows, not thousands.
 */
export class RunEventRecorder {
  private seq = 0;
  private writes: Promise<void> = Promise.resolve();
  private buffer: { stream: 'message' | 'thought'; text: string } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private capped = false;
  private stopped = false;
  private readonly limits: RecorderLimits;

  constructor(
    private readonly run: { id: string; userId: string; taskId: string | null },
    limits: Partial<RecorderLimits> = {}
  ) {
    this.limits = { ...DEFAULT_RECORDER_LIMITS, ...limits };
  }

  record(event: HostEvent): void {
    if (this.stopped) return;
    if (event.kind === 'message_delta' || event.kind === 'thought_delta') {
      const stream = event.kind === 'message_delta' ? 'message' : 'thought';
      if (this.buffer && this.buffer.stream !== stream) this.flushText();
      this.buffer = { stream, text: (this.buffer?.text ?? '') + event.text };
      if (this.buffer.text.length >= this.limits.flushChars) this.flushText();
      else if (!this.timer) this.timer = setTimeout(() => this.flushText(), this.limits.flushMs);
      return;
    }
    this.flushText();
    this.enqueue(toRow(event));
  }

  /** Drops anything buffered and ignores later events; used once the run's lease is lost. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.buffer = null;
  }

  /** Writes anything buffered and waits for every pending row. */
  async flush(): Promise<void> {
    this.flushText();
    await this.writes;
  }

  private flushText(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.buffer || !this.buffer.text) {
      this.buffer = null;
      return;
    }
    const { stream, text } = this.buffer;
    this.buffer = null;
    this.enqueue({ kind: TEXT_KINDS.message_delta, payload: { stream, text } });
  }

  private enqueue(row: { kind: RunEventKind; payload: Record<string, unknown> }): void {
    if (this.capped) return;
    if (this.seq >= this.limits.maxEvents - 1) {
      this.capped = true;
      row = {
        kind: 'status',
        payload: { message: `Event limit of ${this.limits.maxEvents} reached; later activity is not recorded` },
      };
    }
    this.seq += 1;
    const seq = this.seq;
    const payload = redactValue(row.payload) as Record<string, unknown>;
    this.writes = this.writes.then(async () => {
      try {
        const [inserted] = await db
          .insert(runEvents)
          .values({ runId: this.run.id, seq, kind: row.kind, payload })
          .returning();
        runEventBus.emit('event', {
          userId: this.run.userId,
          taskId: this.run.taskId,
          runId: this.run.id,
          seq,
          kind: row.kind,
          payload,
          createdAt: inserted!.createdAt.toISOString(),
        } satisfies RunEventFrame);
      } catch (err) {
        // Event history is best-effort; a failed write must not fail the turn.
        console.error(`Run ${this.run.id} event ${seq} not recorded:`, err);
      }
    });
  }
}

export async function listRunEvents(
  userId: string,
  runId: string,
  afterSeq = 0
): Promise<RunEvent[]> {
  const [run] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.userId, userId)))
    .limit(1);
  if (!run) throw notFound('Run not found');
  return db
    .select()
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, afterSeq)))
    .orderBy(asc(runEvents.seq));
}
