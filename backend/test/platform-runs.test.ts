import { and, asc, eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import { agents, humanRequests, platformOps, runs, tasks, turns, type Run } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { handOffRun } from '../src/modules/ownership/handoff';
import { recoverRun } from '../src/modules/ownership/recovery';
import { takeOverRun } from '../src/modules/ownership/takeover';
import { admitRun, createQueuedRun, ownerOf } from '../src/modules/runs/runs.service';
import { drainRunsForTests, promoteQueuedRun, startQueuedRuns } from '../src/modules/runs/wake';
import {
  requestPlatformOp,
  setPlatformOpHandlerForTests,
  setPlatformRetryBackoffForTests,
} from '../src/modules/workshop/platform-ops';

/**
 * Platform runs: operations the platform executes itself, with no agent,
 * under the gate of the worktree they touch, retried as new runs of the
 * same operation, and handed off or recovered by their operation.
 */
const app = createApp();
let token = '';
let userId = '';
let taskCounter = 0;
const calls: string[] = [];

const auth = () => ({ Authorization: `Bearer ${token}` });

/** A workshop task that has not started: advancing it does nothing but clear its flag. */
async function newTask(): Promise<string> {
  const res = await request(app)
    .post('/api/tasks')
    .set(auth())
    .send({ title: `Platform ${++taskCounter}`, playbook: 'build' });
  return res.body.task.id;
}

async function ask(taskId: string, opKey: string, kind = 'test_op', gate: string | null = null) {
  const { op, run } = await db.transaction((tx) =>
    requestPlatformOp(tx, { userId, taskId, opKey, kind, args: { opKey }, workspaceId: null })
  );
  if (run && gate) await db.update(runs).set({ gateKey: gate }).where(eq(runs.id, run.id));
  const [fresh] = run ? await db.select().from(runs).where(eq(runs.id, run.id)) : [null];
  return { op, run: fresh as Run | null };
}

const opRow = async (id: string) => (await db.select().from(platformOps).where(eq(platformOps.id, id)))[0]!;
const runsOf = (opId: string) => db.select().from(runs).where(eq(runs.opId, opId)).orderBy(asc(runs.createdAt));

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  setPlatformRetryBackoffForTests(0);
  setPlatformOpHandlerForTests('test_op', async (op) => {
    calls.push(op.opKey);
    return { did: op.opKey };
  });
  const reg = await request(app).post('/auth/register').send({
    email: 'platform@example.com',
    username: 'platform',
    password: 'a-strong-password',
  });
  token = reg.body.token;
  userId = reg.body.user.id;
});

afterEach(async () => {
  await drainRunsForTests();
});

afterAll(async () => {
  setPlatformOpHandlerForTests('test_op', null);
  setPlatformOpHandlerForTests('flaky_op', null);
  setPlatformOpHandlerForTests('broken_op', null);
  setPlatformRetryBackoffForTests(null);
});

describe('platform runs', () => {
  it('queues one run per operation, with no agent, however often the operation is asked for', async () => {
    const taskId = await newTask();
    const first = await ask(taskId, 'prepare:1');
    expect(first.run).toMatchObject({
      actor: 'platform',
      agentId: null,
      agentName: 'Loxo platform',
      trigger: 'platform',
      opId: first.op.id,
      status: 'queued',
    });
    const again = await ask(taskId, 'prepare:1');
    expect(again.op.id).toBe(first.op.id);
    expect(again.run).toBeNull();
    expect(await runsOf(first.op.id)).toHaveLength(1);
  });

  it('executes the operation, records its result, and writes nothing to the timeline', async () => {
    const taskId = await newTask();
    const { op, run } = await ask(taskId, 'checkout:a');
    await startQueuedRuns([run!]);
    await drainRunsForTests();
    expect(await opRow(op.id)).toMatchObject({ status: 'done', result: { did: 'checkout:a' }, attempts: 1 });
    expect((await runsOf(op.id)).map((r) => r.status)).toEqual(['succeeded']);
    expect(await db.select().from(turns).where(eq(turns.runId, run!.id))).toEqual([]);
    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(task!.advancePending).toBe(false);
  });

  it('waits while an agent holds the worktree gate and starts when it frees', async () => {
    const taskId = await newTask();
    const agent = await request(app).post('/api/agents').set(auth()).send({ name: 'Writer', runtime: 'claude-code' });
    const writing = await createQueuedRun(userId, {
      agentId: agent.body.agent.id,
      agentName: 'Writer',
      taskId,
      trigger: 'manual',
      gateKey: 'ws:shared',
    });
    await admitRun(writing.id, { instance: 'gate-owner' });
    const { op, run } = await ask(taskId, 'integrate:1', 'test_op', 'ws:shared');
    expect(await promoteQueuedRun(run!)).toBe(false);
    expect((await opRow(op.id)).status).toBe('wanted');

    await db.update(runs).set({ status: 'failed', leaseExpiresAt: null }).where(eq(runs.id, writing.id));
    await db.update(agents).set({ status: 'idle' });
    expect(await promoteQueuedRun(run!)).toBe(true);
    await drainRunsForTests();
    expect((await opRow(op.id)).status).toBe('done');
  });

  it('retries a failed execution as a new run of the same operation', async () => {
    let failures = 1;
    setPlatformOpHandlerForTests('flaky_op', async () => {
      if (failures-- > 0) throw new Error('index.lock exists');
      return { ok: true };
    });
    const taskId = await newTask();
    const { op, run } = await ask(taskId, 'flaky:1', 'flaky_op');
    await startQueuedRuns([run!]);
    await drainRunsForTests();
    const chain = await runsOf(op.id);
    expect(chain.map((r) => [r.status, r.attempt])).toEqual([
      ['failed', 1],
      ['succeeded', 2],
    ]);
    expect(chain[1]).toMatchObject({ actor: 'platform', opId: op.id, parentRunId: chain[0]!.id });
    expect(await opRow(op.id)).toMatchObject({ status: 'done', attempts: 2 });
  });

  it('gives up after the attempt limit and asks a person once', async () => {
    setPlatformOpHandlerForTests('broken_op', async () => {
      throw new Error('merge left the worktree in a state Git cannot read');
    });
    const taskId = await newTask();
    const { op, run } = await ask(taskId, 'broken:1', 'broken_op');
    await startQueuedRuns([run!]);
    await drainRunsForTests();
    expect((await runsOf(op.id)).map((r) => r.status)).toEqual(['failed', 'failed', 'failed']);
    expect(await opRow(op.id)).toMatchObject({ status: 'failed', attempts: 3 });
    const requests = await db.select().from(humanRequests).where(eq(humanRequests.taskId, taskId));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      kind: 'engine_error',
      dedupeKey: `platform_op:${op.id}`,
      choices: ['retry', 'stop'],
      payload: { operation: 'broken_op', attempts: 3 },
    });
  });

  it('cancels a queued run whose operation is no longer wanted', async () => {
    const taskId = await newTask();
    const { op, run } = await ask(taskId, 'stale:1');
    await db.update(platformOps).set({ status: 'cancelled' }).where(eq(platformOps.id, op.id));
    expect(await promoteQueuedRun(run!)).toBe(false);
    const [row] = await db.select().from(runs).where(eq(runs.id, run!.id));
    expect(row).toMatchObject({ status: 'cancelled', stopReason: 'stale' });
    expect(calls).not.toContain('stale:1');
  });

  it('hands an operation interrupted by a shutdown to a follow-up run, without timeline entries', async () => {
    const taskId = await newTask();
    const { op, run } = await ask(taskId, 'handoff:1');
    const admitted = await admitRun(run!.id, { instance: 'shutting-down' });
    const followUp = await handOffRun(ownerOf(admitted!.run), { status: 'cancelled' });
    expect(followUp).toMatchObject({ actor: 'platform', agentId: null, opId: op.id, status: 'queued', attempt: 1 });
    expect(await db.select().from(turns).where(eq(turns.taskId, taskId))).toEqual([]);
    await db.update(runs).set({ status: 'cancelled' }).where(eq(runs.id, followUp!.id));
  });

  it('does not continue an operation that is no longer wanted when its run is handed off', async () => {
    const taskId = await newTask();
    const { op, run } = await ask(taskId, 'handoff:2');
    const admitted = await admitRun(run!.id, { instance: 'shutting-down' });
    await db.update(platformOps).set({ status: 'cancelled' }).where(eq(platformOps.id, op.id));
    expect(await handOffRun(ownerOf(admitted!.run), { status: 'cancelled' })).toBeUndefined();
    expect((await runsOf(op.id)).map((r) => r.status)).toEqual(['cancelled']);
    expect(await db.select().from(turns).where(eq(turns.taskId, taskId))).toEqual([]);
  });

  it('retries an operation whose owner died, as a new run of the same operation', async () => {
    const taskId = await newTask();
    const { op, run } = await ask(taskId, 'crash:1');
    await admitRun(run!.id, { instance: 'dead' });
    await db.update(runs).set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(runs.id, run!.id));
    const resolved = await recoverRun((await takeOverRun(run!.id, { instance: 'recoverer', reason: 'test' }))!);
    expect(resolved).toMatchObject({ status: 'failed', recoveryClass: 'retry' });
    const chain = await runsOf(op.id);
    expect(chain.map((r) => [r.status, r.attempt])).toEqual([
      ['failed', 1],
      ['queued', 2],
    ]);
    expect(chain[1]).toMatchObject({ actor: 'platform', agentId: null, opId: op.id });
    expect((await opRow(op.id)).status).toBe('running');
    await db.update(runs).set({ status: 'cancelled' }).where(eq(runs.id, chain[1]!.id));
  });

  it('does not retry an operation whose processes cannot be confirmed gone', async () => {
    const taskId = await newTask();
    const { op, run } = await ask(taskId, 'orphan:1');
    await admitRun(run!.id, { instance: 'dead' });
    await db
      .update(runs)
      .set({
        launcherPid: 4242,
        launcherTag: 'loxo-op',
        launcherHost: 'another-host',
        leaseExpiresAt: sql`clock_timestamp() - interval '1 second'`,
      })
      .where(eq(runs.id, run!.id));
    await recoverRun((await takeOverRun(run!.id, { instance: 'recoverer', reason: 'test' }))!);
    expect((await runsOf(op.id)).map((r) => r.status)).toEqual(['failed']);
    expect((await opRow(op.id)).status).toBe('failed');
    const [req] = await db
      .select()
      .from(humanRequests)
      .where(and(eq(humanRequests.taskId, taskId), eq(humanRequests.dedupeKey, `platform_op:${op.id}`)));
    expect(String((req!.payload as { error: string }).error)).toContain('could not be confirmed gone');
  });
});
