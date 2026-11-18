import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config';
import { db, pool } from '../src/db/client';
import { runs } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { LeaseKeeper, RunOwnership } from '../src/modules/ownership/lease';
import { createQueuedRun, settleRun } from '../src/modules/runs/runs.service';

/**
 * Lease behavior against a real Postgres, with a short lease so deadlines
 * pass within a test. The keeper's margin (kill budget + jitter) is 300 ms.
 */
const TTL = 1_500;
const app = createApp();
let token = '';
let userId = '';
let keeper: LeaseKeeper;
let counter = 0;

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  const reg = await request(app).post('/auth/register').send({
    email: 'lease@example.com',
    username: 'leaseuser',
    password: 'a-strong-password',
  });
  token = reg.body.token;
  userId = reg.body.user.id;
  keeper = new LeaseKeeper({ ttlMs: TTL, killBudgetMs: 200, jitterMs: 100, instance: 'lease-test' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await keeper.stop();
});

const auth = () => ({ Authorization: `Bearer ${token}` });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A queued run on its own agent and task, so no test contends for another's gates. */
async function freshRun(): Promise<string> {
  counter += 1;
  const agent = await request(app).post('/api/agents').set(auth()).send({ name: `Leaser ${counter}`, runtime: 'api' });
  const task = await request(app).post('/api/tasks').set(auth()).send({ title: `Leased ${counter}` });
  const run = await createQueuedRun(userId, {
    agentId: agent.body.agent.id,
    agentName: `Leaser ${counter}`,
    taskId: task.body.task.id,
    trigger: 'manual',
  });
  return run.id;
}

async function leaseRow(runId: string) {
  const [row] = await db
    .select({ expiresAt: runs.leaseExpiresAt, epoch: runs.ownerEpoch, owner: runs.ownerInstance, status: runs.status })
    .from(runs)
    .where(eq(runs.id, runId));
  return row!;
}

/** Holds a row lock from another connection, the way a settling or takeover transaction would. */
async function lockRow(runId: string): Promise<() => Promise<void>> {
  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();
  await client.query('BEGIN');
  await client.query('SELECT id FROM runs WHERE id = $1 FOR UPDATE', [runId]);
  return async () => {
    await client.query('ROLLBACK');
    await client.end();
  };
}

async function admit(runId: string) {
  const admitted = await keeper.admit(runId);
  expect(admitted).toBeDefined();
  return admitted!.lease;
}

async function finish(runId: string) {
  keeper.release(runId);
  await settleRun(runId, { status: 'succeeded' }, 'idle');
}

describe('run leases', () => {
  it('claims with the next epoch every time', async () => {
    const runId = await freshRun();
    expect((await admit(runId)).epoch).toBe(1);
    keeper.release(runId);
    await db
      .update(runs)
      .set({ status: 'queued', ownerInstance: null, leaseExpiresAt: null })
      .where(eq(runs.id, runId));
    expect((await admit(runId)).epoch).toBe(2);
    expect(await leaseRow(runId)).toMatchObject({ epoch: 2, owner: 'lease-test', status: 'running' });
    await finish(runId);
  });

  it('extends the lease on renewal and never shortens it', async () => {
    const runId = await freshRun();
    await admit(runId);
    const first = (await leaseRow(runId)).expiresAt!;
    await sleep(200);
    await keeper.renewNow();
    const second = (await leaseRow(runId)).expiresAt!;
    expect(second.getTime()).toBeGreaterThan(first.getTime());

    const far = new Date(Date.now() + 60_000);
    await db.update(runs).set({ leaseExpiresAt: far }).where(eq(runs.id, runId));
    await keeper.renewNow();
    expect((await leaseRow(runId)).expiresAt!.getTime()).toBe(far.getTime());
    await finish(runId);
  });

  it('does not revive an expired lease, and its owner fences itself on the next renewal', async () => {
    const runId = await freshRun();
    const lease = await admit(runId);
    await db
      .update(runs)
      .set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(runs.id, runId));
    await keeper.renewNow();

    expect(lease.lost).toBe(true);
    expect(lease.reason).toMatch(/ended or passed to another owner/);
    expect(lease.signal.aborted).toBe(true);
    expect(keeper.isLost(runId)).toBe(true);
    expect((await leaseRow(runId)).expiresAt!.getTime()).toBeLessThan(Date.now());
  });

  it('notices a takeover on the next renewal', async () => {
    const runId = await freshRun();
    const lease = await admit(runId);
    await db
      .update(runs)
      .set({ ownerInstance: 'another-instance', ownerEpoch: sql`${runs.ownerEpoch} + 1` })
      .where(eq(runs.id, runId));
    await keeper.renewNow();
    expect(lease.lost).toBe(true);
    expect(lease.signal.aborted).toBe(true);
  });

  it('skips a row another transaction holds instead of stalling the whole batch', async () => {
    const lockedId = await freshRun();
    const freeId = await freshRun();
    const locked = await admit(lockedId);
    await admit(freeId);
    const freeBefore = (await leaseRow(freeId)).expiresAt!;
    await sleep(100);

    const unlock = await lockRow(lockedId);
    try {
      const started = performance.now();
      await keeper.renewNow();
      // statement_timeout is ttl/3 = 500 ms; waiting on the lock would take that long.
      expect(performance.now() - started).toBeLessThan(250);
    } finally {
      await unlock();
    }
    expect((await leaseRow(freeId)).expiresAt!.getTime()).toBeGreaterThan(freeBefore.getTime());
    // Skipped, not lost: the recheck still sees the run as ours.
    expect(locked.lost).toBe(false);
    await finish(lockedId);
    await finish(freeId);
  });

  it('fences the run at its local deadline, before the database lease expires', async () => {
    const runId = await freshRun();
    const lease = await admit(runId);
    // Every renewal now skips the row, as if the database were unreachable for it.
    const unlock = await lockRow(runId);
    let lostAt = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('lease was never lost')), TTL * 2);
        lease.signal.addEventListener('abort', () => {
          lostAt = Date.now();
          clearTimeout(timeout);
          resolve();
        });
      });
    } finally {
      await unlock();
    }
    expect(lease.reason).toMatch(/deadline/);
    const expiresAt = (await leaseRow(runId)).expiresAt!.getTime();
    expect(lostAt).toBeLessThan(expiresAt);
    expect(lease.deadline.getTime()).toBeLessThan(expiresAt);
  });
});

describe('local lease deadline', () => {
  it('ignores a renewal answered after the deadline', async () => {
    const lease = new RunOwnership('run', 1, 0, performance.now(), Date.now(), 50);
    await sleep(80);
    lease.extend(performance.now(), Date.now(), 10_000);
    expect(lease.lost).toBe(true);
  });

  it('counts a wall-clock jump such as waking from sleep', () => {
    const lease = new RunOwnership('run', 1, 0, performance.now(), Date.now(), 10_000);
    expect(lease.lost).toBe(false);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 60_000);
    expect(lease.lost).toBe(true);
    expect(() => lease.assertHeld()).toThrow(/deadline/);
  });
});
