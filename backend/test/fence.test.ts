import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import { runs, tasks, turns } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { fence, FencedError, fenceRejectionsForTests } from '../src/modules/ownership/fence';
import { LeaseKeeper } from '../src/modules/ownership/lease';
import { takeOverRun } from '../src/modules/ownership/takeover';
import { createQueuedRun, settleRun, type RunOwner } from '../src/modules/runs/runs.service';

/**
 * The fencing protocol between an owner and a taker, with real row locks.
 * Every transaction locks the run row first: owners FOR KEY SHARE (fence) or
 * FOR NO KEY UPDATE (settle, renew), takers FOR UPDATE. A taker therefore
 * waits for in-flight owner writes, an owner write after a takeover fails,
 * and no interleaving deadlocks.
 */
const app = createApp();
let token = '';
let userId = '';
let keeper: LeaseKeeper;
let counter = 0;

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  const reg = await request(app).post('/auth/register').send({
    email: 'fencing@example.com',
    username: 'fencinguser',
    password: 'a-strong-password',
  });
  token = reg.body.token;
  userId = reg.body.user.id;
  keeper = new LeaseKeeper({ instance: 'fence-test' });
});

afterAll(async () => {
  await keeper.stop();
});

const auth = () => ({ Authorization: `Bearer ${token}` });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Started {
  owner: RunOwner;
  taskId: string;
  agentId: string;
}

/** A run admitted by this test's keeper, on its own agent and task. */
async function startRun(): Promise<Started> {
  counter += 1;
  const agent = await request(app).post('/api/agents').set(auth()).send({ name: `Fencer ${counter}`, runtime: 'api' });
  const task = await request(app).post('/api/tasks').set(auth()).send({ title: `Fenced ${counter}` });
  const queued = await createQueuedRun(userId, {
    agentId: agent.body.agent.id,
    agentName: `Fencer ${counter}`,
    taskId: task.body.task.id,
    trigger: 'manual',
  });
  const admitted = await keeper.admit(queued.id);
  expect(admitted).toBeDefined();
  return {
    owner: { runId: queued.id, epoch: admitted!.lease.epoch, instance: keeper.instance },
    taskId: task.body.task.id,
    agentId: agent.body.agent.id,
  };
}

/** Resolves when `promise` settles; lets a test observe that something is still blocked. */
function track<T>(promise: Promise<T>) {
  const state = { done: false };
  void promise.then(
    () => (state.done = true),
    () => (state.done = true)
  );
  return state;
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => (entered = resolve));
  return { open, opened, entered, inside };
}

/**
 * An owner write shaped like a control-plane tool: fence, bump the task's
 * turn counter, insert a turn that references the run, then hold the
 * transaction open until the gate opens.
 */
function ownerWrite(run: Started, hold: ReturnType<typeof gate>) {
  return db.transaction(async (tx) => {
    await fence(tx, run.owner, 'test_write');
    const [counterRow] = await tx
      .update(tasks)
      .set({ turnCounter: sql`${tasks.turnCounter} + 1` })
      .where(eq(tasks.id, run.taskId))
      .returning({ seq: tasks.turnCounter });
    const now = new Date();
    await tx.insert(turns).values({
      taskId: run.taskId,
      seq: counterRow!.seq,
      kind: 'agent',
      agentId: run.agentId,
      runId: run.owner.runId,
      content: 'progress',
      status: 'completed',
      createdAt: now,
      completedAt: now,
    });
    hold.entered();
    await hold.opened;
  });
}

async function runRow(runId: string) {
  const [row] = await db.select().from(runs).where(eq(runs.id, runId));
  return row!;
}

describe('fencing', () => {
  it('settles under the current epoch and refuses a stale one', async () => {
    const run = await startRun();
    const before = fenceRejectionsForTests();
    expect(await settleRun({ ...run.owner, epoch: run.owner.epoch - 1 }, { status: 'succeeded' }, 'idle')).toBeUndefined();
    expect(await settleRun({ ...run.owner, instance: 'someone-else' }, { status: 'succeeded' }, 'idle')).toBeUndefined();
    expect(fenceRejectionsForTests()).toBe(before + 2);

    const settled = await settleRun(run.owner, { status: 'succeeded' }, 'idle');
    expect(settled?.status).toBe('succeeded');
    keeper.release(run.owner.runId);
  });

  it("refuses the old owner's settlement and writes after a takeover", async () => {
    const run = await startRun();
    const taken = await takeOverRun(run.owner.runId, { instance: 'taker', reason: 'test', force: true });
    expect(taken).toMatchObject({
      status: 'running',
      ownerInstance: 'taker',
      ownerEpoch: run.owner.epoch + 1,
      recoveryStep: 'taken_over',
    });

    expect(await settleRun(run.owner, { status: 'succeeded' }, 'idle')).toBeUndefined();
    await expect(db.transaction((tx) => fence(tx, run.owner, 'late_write'))).rejects.toBeInstanceOf(FencedError);
    expect(await runRow(run.owner.runId)).toMatchObject({ status: 'running', ownerInstance: 'taker', error: 'Owner lost: test' });
  });

  it('makes a takeover wait for an in-flight owner write, without deadlock', async () => {
    const run = await startRun();
    const hold = gate();
    const write = ownerWrite(run, hold);
    await hold.inside;

    const takeover = takeOverRun(run.owner.runId, { instance: 'taker', reason: 'test', force: true });
    const progress = track(takeover);
    await sleep(300);
    expect(progress.done).toBe(false);

    hold.open();
    await expect(write).resolves.toBeUndefined();
    const taken = await takeover;
    expect(taken?.ownerEpoch).toBe(run.owner.epoch + 1);
    // The write committed under the old epoch before the takeover did.
    const [turn] = await db.select().from(turns).where(eq(turns.runId, run.owner.runId));
    expect(turn?.content).toBe('progress');
    keeper.release(run.owner.runId);
  });

  it('never makes a renewal wait for an owner write', async () => {
    const run = await startRun();
    const before = (await runRow(run.owner.runId)).leaseExpiresAt!;
    const hold = gate();
    const write = ownerWrite(run, hold);
    await hold.inside;
    try {
      await sleep(50);
      const started = performance.now();
      await keeper.renewNow();
      expect(performance.now() - started).toBeLessThan(250);
      // Not skipped either: KEY SHARE and the renewal's lock are compatible.
      expect((await runRow(run.owner.runId)).leaseExpiresAt!.getTime()).toBeGreaterThan(before.getTime());
    } finally {
      hold.open();
      await write;
    }
    await settleRun(run.owner, { status: 'succeeded' }, 'idle');
    keeper.release(run.owner.runId);
  });

  it('lets a settlement that commits first win, leaving the takeover a no-op', async () => {
    const run = await startRun();
    const hold = gate();
    const settling = db.transaction(async (tx) => {
      const settled = await settleRun(run.owner, { status: 'succeeded' }, 'idle', tx);
      hold.entered();
      await hold.opened;
      return settled;
    });
    await hold.inside;

    const takeover = takeOverRun(run.owner.runId, { instance: 'taker', reason: 'test', force: true });
    const progress = track(takeover);
    await sleep(300);
    expect(progress.done).toBe(false);

    hold.open();
    expect((await settling)?.status).toBe('succeeded');
    expect(await takeover).toBeUndefined();
    expect(await runRow(run.owner.runId)).toMatchObject({ status: 'succeeded', ownerEpoch: run.owner.epoch });
    keeper.release(run.owner.runId);
  });
});
