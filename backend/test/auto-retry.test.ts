import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import path from 'node:path';
import fs from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import { runs, type Run } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { commentOnTask } from '../src/modules/control-plane/tools';
import { LeaseKeeper } from '../src/modules/ownership/lease';
import { reconcileOnce } from '../src/modules/ownership/reconciler';
import { setRetryPolicyForTests } from '../src/modules/ownership/recovery';
import { setTaskHostFactoryForTests } from '../src/modules/runs/task-run';
import { drainRunsForTests } from '../src/modules/runs/wake';
import { initFixtureRepo, makeSandbox, removeSandbox } from './fixtures/git-repo';
import { deadRun as deadRunIn, type DeadRun, type DeadRunOptions } from './support/dead-run';
import { scriptedHost } from './support/scripted-host';

const app = createApp();
const T = 30_000;
const BACKOFF_MS = 4_000;
let token = '';
let userId = '';
let repositoryId = '';
let sandbox = '';
let keeper: LeaseKeeper;
const prompts: string[] = [];

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  setTaskHostFactoryForTests(
    scriptedHost(async (turn) => {
      prompts.push(turn.prompt);
      return { text: 'Done on the retry.' };
    })
  );
  setRetryPolicyForTests({ maxAttempts: 3, backoffMs: BACKOFF_MS });
  const reg = await request(app)
    .post('/auth/register')
    .send({ email: 'retry@example.com', username: 'retryuser', password: 'a-strong-password' });
  token = reg.body.token;
  userId = reg.body.user.id;
  sandbox = makeSandbox('auto-retry');
  const repo = await initFixtureRepo(path.join(sandbox, 'repo'), { 'README.md': '# retry\n' });
  const created = await request(app)
    .post('/api/repositories')
    .set({ Authorization: `Bearer ${token}` })
    .send({ rootPath: repo });
  repositoryId = created.body.repository.id;
  keeper = new LeaseKeeper({ instance: 'retry-test' });
});

afterEach(async () => {
  await drainRunsForTests();
  prompts.length = 0;
});

afterAll(async () => {
  setTaskHostFactoryForTests(null);
  setRetryPolicyForTests(null);
  await keeper.stop();
  removeSandbox(sandbox);
});

const deadRun = (options: DeadRunOptions = {}, act?: (run: DeadRun) => Promise<void>) =>
  deadRunIn({ app, token, userId, repositoryId }, options, act);

async function runRow(id: string): Promise<Run> {
  const [row] = await db.select().from(runs).where(eq(runs.id, id));
  return row!;
}

async function childOf(id: string): Promise<Run | undefined> {
  const [row] = await db.select().from(runs).where(eq(runs.parentRunId, id));
  return row;
}

/** Seconds from now (database clock) until the run may be promoted. */
async function backoffSeconds(id: string): Promise<number> {
  const [row] = await db
    .select({ left: sql<string>`extract(epoch from ${runs.notBefore} - clock_timestamp())` })
    .from(runs)
    .where(eq(runs.id, id));
  return Number(row!.left);
}

function releaseBackoff(id: string) {
  return db.update(runs).set({ notBefore: sql`clock_timestamp() - interval '1 second'` }).where(eq(runs.id, id));
}

describe('automatic retry of runs that did nothing', () => {
  it('queues the next attempt after a back-off and runs it once that elapses', { timeout: T }, async () => {
    const { ctx } = await deadRun({ repository: true, trigger: 'review' });
    await reconcileOnce(keeper);

    expect(await runRow(ctx.run.id)).toMatchObject({
      status: 'failed',
      recoveryClass: 'retry',
      error: 'Owner lost: lease expired; retrying as attempt 2',
    });
    const retry = (await childOf(ctx.run.id))!;
    expect(retry).toMatchObject({
      status: 'queued',
      attempt: 2,
      trigger: 'review',
      agentId: ctx.agent.id,
      taskId: ctx.task.id,
      reason: ctx.run.reason,
    });
    const wait = await backoffSeconds(retry.id);
    expect(wait).toBeGreaterThan(BACKOFF_MS / 1000 - 1.5);
    expect(wait).toBeLessThanOrEqual(BACKOFF_MS / 1000);

    // Not before its time, even when the gates are free.
    expect((await reconcileOnce(keeper)).promoted).not.toContain(retry.id);
    await releaseBackoff(retry.id);
    expect((await reconcileOnce(keeper)).promoted).toContain(retry.id);
    await drainRunsForTests();
    expect(await runRow(retry.id)).toMatchObject({ status: 'succeeded', attempt: 2 });
    expect(prompts).toHaveLength(1);
  });

  it('doubles the back-off for each further attempt and gives up at the cap', { timeout: T }, async () => {
    const second = await deadRun({ trigger: 'review' }, async ({ ctx }) => {
      await db.update(runs).set({ attempt: 2 }).where(eq(runs.id, ctx.run.id));
    });
    const third = await deadRun({ trigger: 'review' }, async ({ ctx }) => {
      await db.update(runs).set({ attempt: 3 }).where(eq(runs.id, ctx.run.id));
    });
    await reconcileOnce(keeper);

    const fromSecond = (await childOf(second.ctx.run.id))!;
    expect(fromSecond.attempt).toBe(3);
    const wait = await backoffSeconds(fromSecond.id);
    expect(wait).toBeGreaterThan((2 * BACKOFF_MS) / 1000 - 1.5);
    expect(wait).toBeLessThanOrEqual((2 * BACKOFF_MS) / 1000);

    expect(await runRow(third.ctx.run.id)).toMatchObject({
      status: 'failed',
      recoveryClass: 'retry',
      error: 'Owner lost: lease expired; gave up after 3 attempt(s)',
    });
    expect(await childOf(third.ctx.run.id)).toBeUndefined();
    await db.update(runs).set({ status: 'cancelled' }).where(eq(runs.id, fromSecond.id));
  });

  it('never retries a run that committed something or may have changed its worktree', { timeout: T }, async () => {
    const commented = await deadRun({}, async ({ ctx }) => {
      await commentOnTask(ctx, 'Started.');
    });
    const wrote = await deadRun({ repository: true }, async ({ worktree }) => {
      fs.writeFileSync(path.join(worktree!, 'partial.ts'), 'export const partial = 1;\n');
    });
    await reconcileOnce(keeper);
    for (const { ctx } of [commented, wrote]) {
      expect((await runRow(ctx.run.id)).status).toBe('interrupted');
      expect(await childOf(ctx.run.id)).toBeUndefined();
    }
    await db.update(runs).set({ status: 'cancelled' }).where(eq(runs.id, commented.ctx.run.id));
    await db.update(runs).set({ status: 'cancelled' }).where(eq(runs.id, wrote.ctx.run.id));
  });

  it('queues the retry in the same transaction that resolves the run', { timeout: T }, async () => {
    const { ctx } = await deadRun({ trigger: 'review' });
    // The resolve fails on its last write (the agent's display status), after the
    // retry was queued: the retry must roll back with it.
    const constraint = 'retry_test_block';
    await pool.query(
      `ALTER TABLE agents ADD CONSTRAINT ${constraint} CHECK (id <> '${ctx.agent.id}' OR status <> 'error') NOT VALID`
    );
    try {
      await reconcileOnce(keeper);
      expect(await runRow(ctx.run.id)).toMatchObject({ status: 'running', recoveryStep: 'assessed' });
      expect(await childOf(ctx.run.id)).toBeUndefined();
    } finally {
      await pool.query(`ALTER TABLE agents DROP CONSTRAINT ${constraint}`);
    }
    await db.update(runs).set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(runs.id, ctx.run.id));
    await reconcileOnce(keeper);
    expect(await runRow(ctx.run.id)).toMatchObject({ status: 'failed', recoveryClass: 'retry' });
    const retry = (await childOf(ctx.run.id))!;
    expect(retry.attempt).toBe(2);
    await db.update(runs).set({ status: 'cancelled' }).where(eq(runs.id, retry.id));
  });
});
