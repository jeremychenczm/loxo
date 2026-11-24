import pg from 'pg';
import { config } from '../../config';
import type { Run } from '../../db/schema';
import { admitRun } from '../runs/runs.service';
import { instanceId } from './instance';

/** Thrown at a checkpoint once the run's lease is gone; nothing may be written after it. */
export class OwnershipLostError extends Error {
  constructor(
    readonly runId: string,
    readonly reason: string
  ) {
    super(`Run ${runId} lost its lease: ${reason}`);
    this.name = 'OwnershipLostError';
  }
}

/** What execution code needs to know about the lease it runs under. */
export interface RunLease {
  readonly runId: string;
  readonly epoch: number;
  readonly lost: boolean;
  /** Aborts the moment the lease is lost; hosts kill their processes on it. */
  readonly signal: AbortSignal;
  /** Throws OwnershipLostError if the lease is gone. Call before each step that writes or spends. */
  assertHeld(): void;
}

/**
 * This instance's local view of one run lease. The local deadline is derived
 * from what the database reported, minus a safety margin, and measured on both
 * the monotonic clock and the wall clock (whichever runs out first wins, since
 * platforms disagree on whether the monotonic clock counts sleep). Reaching it
 * without a renewal means the instance stops acting for the run before the
 * database lease can expire and another instance can take over.
 */
export class RunOwnership implements RunLease {
  private readonly controller = new AbortController();
  private readonly stopper = new AbortController();
  private deadlineMono: number;
  private deadlineWall: number;
  private timer: NodeJS.Timeout | undefined;
  private lostReason: string | null = null;

  /** `remainingMs` is the lease the database reported for a claim sent at (t0Mono, t0Wall). */
  constructor(
    readonly runId: string,
    readonly epoch: number,
    private readonly marginMs: number,
    t0Mono: number,
    t0Wall: number,
    remainingMs: number
  ) {
    this.deadlineMono = t0Mono + remainingMs - marginMs;
    this.deadlineWall = t0Wall + remainingMs - marginMs;
    this.schedule();
  }

  /** Also notices a deadline that passed while no timer could fire (event-loop stall, sleep). */
  get lost(): boolean {
    this.checkDeadline();
    return this.lostReason !== null;
  }

  get reason(): string | null {
    return this.lostReason;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /**
   * Aborts when the database asks the holder to stop the run (its workshop
   * dispatch ran out of time, or the workshop stopped). The lease is still
   * held: the holder stops the agent and settles the run itself.
   */
  get stopSignal(): AbortSignal {
    return this.stopper.signal;
  }

  requestStop(): void {
    if (!this.stopper.signal.aborted) this.stopper.abort();
  }

  /** Wall-clock time at which this instance stops acting for the run. */
  get deadline(): Date {
    return new Date(this.deadlineWall);
  }

  assertHeld(): void {
    if (this.lost) throw new OwnershipLostError(this.runId, this.lostReason!);
  }

  /**
   * Applies a database answer: `remainingMs` of lease left as of a request
   * sent at (t0Mono, t0Wall). An answer that arrives after the local deadline
   * does not count; the lease is already treated as lost by then.
   */
  extend(t0Mono: number, t0Wall: number, remainingMs: number): void {
    if (this.lost) return;
    this.deadlineMono = Math.max(this.deadlineMono, t0Mono + remainingMs - this.marginMs);
    this.deadlineWall = Math.max(this.deadlineWall, t0Wall + remainingMs - this.marginMs);
    this.schedule();
  }

  lose(reason: string): void {
    if (this.lostReason !== null) return;
    this.lostReason = reason;
    clearTimeout(this.timer);
    this.controller.abort(new OwnershipLostError(this.runId, reason));
  }

  /** Stops watching the deadline once the run has settled. */
  dispose(): void {
    clearTimeout(this.timer);
  }

  private checkDeadline(): void {
    if (this.lostReason !== null) return;
    if (performance.now() >= this.deadlineMono || Date.now() >= this.deadlineWall) {
      this.lose('lease deadline passed without a renewal');
    }
  }

  private schedule(): void {
    clearTimeout(this.timer);
    const wait = Math.min(this.deadlineMono - performance.now(), this.deadlineWall - Date.now());
    this.timer = setTimeout(() => {
      if (!this.lost) this.schedule();
    }, Math.max(0, wait));
    this.timer.unref();
  }
}

export interface LeaseKeeperOptions {
  ttlMs?: number;
  /** Time a self-fence needs to kill the agent's process tree. */
  killBudgetMs?: number;
  /** Allowance for late timers. */
  jitterMs?: number;
  instance?: string;
  connectionString?: string;
}

const RENEW_SQL = `
WITH c AS (
  SELECT r.id FROM runs r
  JOIN unnest($2::uuid[], $3::int[]) AS o(id, epoch) ON o.id = r.id AND o.epoch = r.owner_epoch
  WHERE r.owner_instance = $1 AND r.status = 'running' AND r.lease_expires_at > clock_timestamp()
  FOR NO KEY UPDATE OF r SKIP LOCKED
)
UPDATE runs SET lease_expires_at = GREATEST(runs.lease_expires_at, clock_timestamp() + $4::integer * interval '1 millisecond')
FROM c WHERE runs.id = c.id
RETURNING runs.id, extract(epoch from runs.lease_expires_at - clock_timestamp()) * 1000 AS remaining_ms,
  EXISTS (SELECT 1 FROM dispatches d WHERE d.id = runs.dispatch_id AND d.cancel_requested_at IS NOT NULL) AS stop`;

const RECHECK_SQL = `
SELECT o.id, COALESCE(r.owner_instance = $1 AND r.owner_epoch = o.epoch AND r.status = 'running'
  AND r.lease_expires_at > clock_timestamp(), false) AS held
FROM unnest($2::uuid[], $3::int[]) AS o(id, epoch) LEFT JOIN runs r ON r.id = o.id`;

/**
 * Holds the leases of every run this instance executes: admits runs under a
 * fresh epoch, renews all of them with one statement every ttl/3 on a
 * dedicated connection (so a busy pool cannot starve renewals), and fences a
 * run locally the moment its lease is gone.
 */
export class LeaseKeeper {
  readonly ttlMs: number;
  readonly instance: string;
  private readonly marginMs: number;
  private readonly connectionString: string;
  private readonly owned = new Map<string, RunOwnership>();
  private readonly lostRuns = new Set<string>();
  private client: pg.Client | null = null;
  private interval: NodeJS.Timeout | undefined;
  private renewing: Promise<void> | null = null;
  private isDraining = false;

  constructor(options: LeaseKeeperOptions = {}) {
    this.ttlMs = options.ttlMs ?? config.runLeaseTtlMs;
    this.instance = options.instance ?? instanceId;
    this.marginMs = (options.killBudgetMs ?? config.runKillBudgetMs) + (options.jitterMs ?? 1_000);
    this.connectionString = options.connectionString ?? config.databaseUrl;
    if (this.marginMs >= this.ttlMs / 2) {
      throw new Error(`Lease margin ${this.marginMs} ms leaves no room in a ${this.ttlMs} ms lease`);
    }
  }

  /**
   * Stops admitting runs on this instance, for a graceful shutdown: queued
   * runs stay queued for another instance, or for this one after a restart.
   * Leases already held keep being renewed until stop().
   */
  drain(): void {
    this.isDraining = true;
  }

  get draining(): boolean {
    return this.isDraining;
  }

  undrainForTests(): void {
    this.isDraining = false;
  }

  /** Starts a queued run under this instance; undefined when it cannot start now. */
  async admit(runId: string): Promise<{ run: Run; lease: RunOwnership } | undefined> {
    if (this.draining) return undefined;
    const t0Mono = performance.now();
    const t0Wall = Date.now();
    const admission = await admitRun(runId, { ttlMs: this.ttlMs, instance: this.instance });
    if (!admission) return undefined;
    const lease = new RunOwnership(
      runId,
      admission.run.ownerEpoch,
      this.marginMs,
      t0Mono,
      t0Wall,
      admission.leaseRemainingMs
    );
    lease.signal.addEventListener('abort', () => this.forget(runId, true), { once: true });
    this.owned.set(runId, lease);
    this.startLoop();
    return { run: admission.run, lease };
  }

  /** The run settled; stop renewing it. */
  release(runId: string): void {
    this.owned.get(runId)?.dispose();
    this.forget(runId, false);
  }

  /** True when this instance fenced the run itself; control-plane calls for it are refused. */
  isLost(runId: string): boolean {
    return this.lostRuns.has(runId);
  }

  get(runId: string): RunOwnership | undefined {
    return this.owned.get(runId);
  }

  /** One renewal round now; rounds never overlap. */
  renewNow(): Promise<void> {
    if (!this.renewing) {
      this.renewing = this.renew().finally(() => {
        this.renewing = null;
      });
    }
    return this.renewing;
  }

  async stop(): Promise<void> {
    clearInterval(this.interval);
    this.interval = undefined;
    await this.renewing?.catch(() => {});
    await this.closeClient();
  }

  private forget(runId: string, lost: boolean): void {
    if (lost) {
      this.lostRuns.add(runId);
      console.warn(`Run ${runId} fenced itself: ${this.owned.get(runId)?.reason ?? 'lease lost'}`);
    }
    this.owned.delete(runId);
    if (this.owned.size === 0) {
      clearInterval(this.interval);
      this.interval = undefined;
      if (!this.renewing) void this.closeClient();
    }
  }

  private startLoop(): void {
    if (this.interval) return;
    this.interval = setInterval(() => void this.renewNow(), Math.floor(this.ttlMs / 3));
    this.interval.unref();
  }

  private async connection(): Promise<pg.Client> {
    if (this.client) return this.client;
    const budget = Math.floor(this.ttlMs / 3);
    const client = new pg.Client({
      connectionString: this.connectionString,
      statement_timeout: budget,
      lock_timeout: budget,
      // Server-side timeouts cannot fire if the connection is half-open.
      query_timeout: budget + 1_000,
      connectionTimeoutMillis: budget,
      keepAlive: true,
    });
    client.on('error', () => void this.closeClient());
    await client.connect();
    this.client = client;
    return client;
  }

  private async closeClient(): Promise<void> {
    const client = this.client;
    this.client = null;
    await client?.end().catch(() => {});
  }

  private async renew(): Promise<void> {
    const leases = [...this.owned.values()].filter((lease) => !lease.lost);
    if (leases.length === 0) return;
    const ids = leases.map((l) => l.runId);
    const epochs = leases.map((l) => l.epoch);
    const t0Mono = performance.now();
    const t0Wall = Date.now();
    let renewed: Map<string, number>;
    try {
      const client = await this.connection();
      const { rows } = await client.query<{ id: string; remaining_ms: string; stop: boolean }>(RENEW_SQL, [
        this.instance,
        ids,
        epochs,
        this.ttlMs,
      ]);
      renewed = new Map(rows.map((r) => [r.id, Number(r.remaining_ms)]));
      for (const row of rows) if (row.stop) this.owned.get(row.id)?.requestStop();
    } catch (err) {
      // The deadline timers fence the runs if renewals keep failing.
      console.error('Lease renewal failed:', err);
      await this.closeClient();
      return;
    }
    for (const lease of leases) {
      const remaining = renewed.get(lease.runId);
      if (remaining !== undefined) lease.extend(t0Mono, t0Wall, remaining);
    }

    const missing = leases.filter((l) => !renewed.has(l.runId) && !l.lost);
    if (missing.length === 0) return;
    // Missing rows were either skipped because another transaction held them,
    // or are no longer ours. Only the second kind is fenced now.
    try {
      const client = await this.connection();
      const { rows } = await client.query<{ id: string; held: boolean }>(RECHECK_SQL, [
        this.instance,
        missing.map((l) => l.runId),
        missing.map((l) => l.epoch),
      ]);
      for (const row of rows) {
        if (!row.held) this.owned.get(row.id)?.lose('lease ended or passed to another owner');
      }
    } catch (err) {
      console.error('Lease recheck failed:', err);
      await this.closeClient();
    }
  }
}

/** The leases of this backend process. */
export const runLeases = new LeaseKeeper();
