import { and, asc, eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { RunnerError } from '@swarmdev/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import {
  agents,
  dispatchReports,
  dispatches,
  humanRequests,
  runs,
  tasks,
  type Agent,
  type Run,
  type Task,
} from '../src/db/schema';
import { createApp } from '../src/http/app';
import { commentOnTask, submitDispatchReport, type RunToolContext } from '../src/modules/control-plane/tools';
import { handOffRun } from '../src/modules/ownership/handoff';
import { recoverRun, setRetryPolicyForTests } from '../src/modules/ownership/recovery';
import { decideInterruptedRun, stopExpiredDecisions } from '../src/modules/ownership/recovery-decisions';
import { takeOverRun } from '../src/modules/ownership/takeover';
import { admitRun, ownerOf, settleRun } from '../src/modules/runs/runs.service';
import { setTaskHostFactoryForTests } from '../src/modules/runs/task-run';
import { drainRunsForTests, promoteQueuedRun } from '../src/modules/runs/wake';
import { advanceTask, setWorkshopRunStarterForTests } from '../src/modules/workshop/advance';
import { noteRunEnded } from '../src/modules/workshop/dispatch-end';
import { scriptedHost } from './support/scripted-host';

/**
 * Every way a run ends, applied to a run of a workshop dispatch: the
 * dispatch must end the way the plan's table says, follow-up runs must carry
 * it on, and the task must be flagged so the engine moves.
 */
const app = createApp();
let token = '';
let userId = '';
const OWNER = 'dispatch-end-test';

const auth = () => ({ Authorization: `Bearer ${token}` });

async function newAgent(name: string): Promise<string> {
  const res = await request(app).post('/api/agents').set(auth()).send({ name, runtime: 'claude-code' });
  return (res.body.agent ?? res.body).id;
}

/** A started build workshop whose explore runs stay queued until a test admits them. */
async function startedWorkshop(names: string[]): Promise<{ task: Task; agents: string[] }> {
  setWorkshopRunStarterForTests(async () => {});
  const ids = [];
  for (const name of names) ids.push(await newAgent(name));
  const res = await request(app)
    .post('/api/tasks')
    .set(auth())
    .send({ title: 'Two-step login', playbook: 'build', leadAgentId: ids[0], memberAgentIds: ids });
  await request(app).post(`/api/tasks/${res.body.task.id}/start`).set(auth());
  const [task] = await db.select().from(tasks).where(eq(tasks.id, res.body.task.id));
  return { task: task!, agents: ids };
}

async function dispatchFor(taskId: string, agentId: string, round = 0) {
  const [row] = await db
    .select()
    .from(dispatches)
    .where(and(eq(dispatches.taskId, taskId), eq(dispatches.agentId, agentId), eq(dispatches.round, round)));
  return row!;
}

async function queuedRunOf(dispatchId: string): Promise<Run> {
  const [run] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.dispatchId, dispatchId), eq(runs.status, 'queued')))
    .orderBy(asc(runs.createdAt));
  return run!;
}

/** Admits the dispatch's queued run under a test owner and returns its tool context. */
async function admitted(taskId: string, agentId: string, instance = OWNER): Promise<RunToolContext> {
  const dispatch = await dispatchFor(taskId, agentId);
  const admission = await admitRun((await queuedRunOf(dispatch.id)).id, { instance });
  expect(admission).toBeDefined();
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  return { run: admission!.run, epoch: admission!.run.ownerEpoch, agent: agent as Agent, task: task! };
}

async function runsOf(dispatchId: string): Promise<Run[]> {
  return db.select().from(runs).where(eq(runs.dispatchId, dispatchId)).orderBy(asc(runs.createdAt));
}

/** Lets the run's lease lapse, then takes it over and drives recovery, as the reconciler does. */
async function crashAndRecover(run: Run): Promise<Run> {
  await db.update(runs).set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(runs.id, run.id));
  const taken = await takeOverRun(run.id, { instance: 'recoverer', reason: 'test' });
  expect(taken).toBeDefined();
  return recoverRun(taken!);
}

const flagged = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.advancePending;

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  const reg = await request(app).post('/auth/register').send({
    email: 'dispatch-end@example.com',
    username: 'dispatchend',
    password: 'a-strong-password',
  });
  token = reg.body.token;
  userId = reg.body.user.id;
});

afterEach(async () => {
  await drainRunsForTests();
  setTaskHostFactoryForTests(null);
  setWorkshopRunStarterForTests(null);
  setRetryPolicyForTests(null);
});

afterAll(async () => {
  await drainRunsForTests();
});

describe('a dispatch run settled by its owner', () => {
  it('reports, re-asks after a missing report, and asks a person after a failure', async () => {
    setTaskHostFactoryForTests(
      scriptedHost(async (turn) => {
        const [run] = await db
          .select()
          .from(runs)
          .where(and(eq(runs.status, 'running'), sql`${turn.prompt} LIKE '%' || ${runs.agentName} || '%'`));
        if (turn.prompt.includes('Reporter')) {
          const [agent] = await db.select().from(agents).where(eq(agents.id, run!.agentId!));
          const [task] = await db.select().from(tasks).where(eq(tasks.id, run!.taskId!));
          await submitDispatchReport(
            { run: run!, epoch: run!.ownerEpoch, agent: agent as Agent, task: task! },
            'submit_exploration',
            { approach: 'TOTP via otplib' }
          );
          return { text: 'Reported.' };
        }
        if (turn.prompt.includes('Crasher')) throw new RunnerError('agent crashed', 'cli_failed');
        return { text: 'I looked but forgot to report.' };
      })
    );
    const { task, agents: [reporter, silent, crasher] } = await startedWorkshop(['Reporter', 'Silent', 'Crasher']);
    setWorkshopRunStarterForTests(null);
    await advanceTask(task.id); // nothing new; the queued runs start through promotion
    for (const d of await db.select().from(dispatches).where(eq(dispatches.taskId, task.id))) {
      await promoteQueuedRun(await queuedRunOf(d.id));
    }
    await drainRunsForTests();

    expect((await dispatchFor(task.id, reporter!)).status).toBe('reported');
    expect((await dispatchFor(task.id, silent!, 0)).status).toBe('no_report');
    expect((await dispatchFor(task.id, silent!, 1)).status).toBe('no_report');
    expect((await dispatchFor(task.id, crasher!)).status).toBe('failed');
    const open = await db.select().from(humanRequests).where(eq(humanRequests.taskId, task.id));
    expect(open.map((r) => [r.kind, (r.payload as { agentId: string }).agentId]).sort()).toEqual(
      [
        ['member_failed', crasher],
        ['member_failed', silent],
      ].sort()
    );
  });

  it('fails the dispatch of a queued run whose agent was deleted', async () => {
    const { task, agents: [, gone] } = await startedWorkshop(['Keeper', 'Gone']);
    const dispatch = await dispatchFor(task.id, gone!);
    const queued = await queuedRunOf(dispatch.id);
    await request(app).delete(`/api/agents/${gone}`).set(auth());
    const [orphan] = await db.select().from(runs).where(eq(runs.id, queued.id));
    await promoteQueuedRun(orphan!);
    expect((await db.select().from(dispatches).where(eq(dispatches.id, dispatch.id)))[0]!.status).toBe('failed');
  });
});

describe('admission', () => {
  it('marks the dispatch running and starts its clock with the first run', async () => {
    const { task, agents: [lead] } = await startedWorkshop(['Clock A', 'Clock B']);
    const ctx = await admitted(task.id, lead!);
    const dispatch = await dispatchFor(task.id, lead!);
    expect(dispatch.status).toBe('running');
    expect(dispatch.startedAt).not.toBeNull();
    await settleRun(ownerOf(ctx.run), { status: 'succeeded' }, 'idle');
  });

  it('cancels a queued run whose dispatch the workshop has moved past', async () => {
    const { task, agents: [lead] } = await startedWorkshop(['Stale A', 'Stale B']);
    const queued = await queuedRunOf((await dispatchFor(task.id, lead!)).id);
    await db.update(tasks).set({ round: 1 }).where(eq(tasks.id, task.id));
    expect(await promoteQueuedRun(queued)).toBe(false);
    const [row] = await db.select().from(runs).where(eq(runs.id, queued.id));
    expect(row).toMatchObject({ status: 'cancelled', stopReason: 'stale' });
  });
});

describe('reports', () => {
  it('refuses the wrong report tool and keeps the first report of a dispatch', async () => {
    const { task, agents: [lead] } = await startedWorkshop(['Report A', 'Report B']);
    const ctx = await admitted(task.id, lead!);
    await expect(submitDispatchReport(ctx, 'submit_plan', { plan: 'x' })).rejects.toMatchObject({
      code: 'wrong_report_tool',
    });
    const first = await submitDispatchReport(ctx, 'submit_exploration', { approach: 'first' });
    expect(first).toEqual({ accepted: true, report: { approach: 'first' } });

    // A follow-up run of the same dispatch reports again: the first report stands.
    const followUp = await handOffRun(ownerOf(ctx.run), { status: 'cancelled' });
    expect(followUp).toBeUndefined(); // it had already reported, so it settled instead
    const rows = await db.select().from(dispatchReports).where(eq(dispatchReports.dispatchId, ctx.run.dispatchId!));
    expect(rows.map((r) => r.report)).toEqual([{ approach: 'first' }]);
    expect((await dispatchFor(task.id, lead!)).status).toBe('reported');
  });

  it('waits for a report still being written before deciding the dispatch had none', async () => {
    const { task, agents: [lead] } = await startedWorkshop(['Race A', 'Race B']);
    const ctx = await admitted(task.id, lead!);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let inserted!: () => void;
    const insertedSignal = new Promise<void>((resolve) => (inserted = resolve));

    // A control-plane call in flight: key-share lock on the run, report inserted, not yet committed.
    const reporting = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1 FROM runs WHERE id = ${ctx.run.id} FOR KEY SHARE`);
      await tx.insert(dispatchReports).values({
        dispatchId: ctx.run.dispatchId!,
        runId: ctx.run.id,
        epoch: ctx.epoch,
        tool: 'submit_exploration',
        report: { approach: 'late' },
      });
      inserted();
      await held;
    });
    await insertedSignal;

    let settledAt = 0;
    const settling = db
      .transaction(async (tx) => {
        const row = await settleRun(ownerOf(ctx.run), { status: 'succeeded' }, 'idle', tx);
        return noteRunEnded(tx, row!.id, { kind: 'settled', status: 'succeeded' });
      })
      .then((taskId) => {
        settledAt = Date.now();
        return taskId;
      });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(settledAt).toBe(0);
    const releasedAt = Date.now();
    release();
    await reporting;
    expect(await settling).toBe(task.id);
    expect(settledAt).toBeGreaterThanOrEqual(releasedAt);
    expect((await dispatchFor(task.id, lead!)).status).toBe('reported');
    // Nothing advanced it yet: the flag set in the settling transaction is still there for the advance.
    expect(await flagged(task.id)).toBe(true);
  });
});

describe('handoff', () => {
  it('continues the dispatch in a follow-up run that keeps its dispatch and gate', async () => {
    const { task, agents: [lead] } = await startedWorkshop(['Hand A', 'Hand B']);
    const ctx = await admitted(task.id, lead!);
    const followUp = await handOffRun(ownerOf(ctx.run), { status: 'cancelled' });
    expect(followUp).toMatchObject({ dispatchId: ctx.run.dispatchId, gateKey: ctx.run.gateKey, status: 'queued' });
    expect((await dispatchFor(task.id, lead!)).status).toBe('running');
  });

  it('ends a dispatch that was told to stop instead of continuing it', async () => {
    const { task, agents: [lead] } = await startedWorkshop(['Stop A', 'Stop B']);
    const ctx = await admitted(task.id, lead!);
    await db.update(dispatches).set({ cancelRequestedAt: new Date() }).where(eq(dispatches.id, ctx.run.dispatchId!));
    const followUp = await handOffRun(ownerOf(ctx.run), { status: 'cancelled' });
    expect(followUp).toBeUndefined();
    // Explore is read-only: a stopped dispatch counts as skipped.
    expect((await dispatchFor(task.id, lead!)).status).toBe('skipped');
  });
});

describe('recovery after the owner died', () => {
  it('retries a run that did nothing in a follow-up that keeps the dispatch', async () => {
    const { task, agents: [lead] } = await startedWorkshop(['Retry A', 'Retry B']);
    const ctx = await admitted(task.id, lead!, 'dead');
    const resolved = await crashAndRecover(ctx.run);
    expect(resolved).toMatchObject({ status: 'failed', recoveryClass: 'retry' });
    const chain = await runsOf(ctx.run.dispatchId!);
    expect(chain.map((r) => [r.status, r.attempt])).toEqual([
      ['failed', 1],
      ['queued', 2],
    ]);
    expect(chain[1]).toMatchObject({ dispatchId: ctx.run.dispatchId, gateKey: ctx.run.gateKey, parentRunId: ctx.run.id });
    expect((await dispatchFor(task.id, lead!)).status).toBe('running');
  });

  it('fails the dispatch when retries run out', async () => {
    setRetryPolicyForTests({ maxAttempts: 1 });
    const { task, agents: [lead] } = await startedWorkshop(['GiveUp A', 'GiveUp B']);
    const ctx = await admitted(task.id, lead!, 'dead');
    await crashAndRecover(ctx.run);
    expect((await runsOf(ctx.run.dispatchId!)).map((r) => r.status)).toEqual(['failed']);
    expect((await dispatchFor(task.id, lead!)).status).toBe('failed');
  });

  it('keeps a report the run committed before its owner died', async () => {
    const { task, agents: [lead] } = await startedWorkshop(['Known A', 'Known B']);
    const ctx = await admitted(task.id, lead!, 'dead');
    await submitDispatchReport(ctx, 'submit_exploration', { approach: 'kept' });
    const resolved = await crashAndRecover(ctx.run);
    expect(resolved).toMatchObject({ status: 'succeeded', recoveryClass: 'known' });
    expect((await dispatchFor(task.id, lead!)).status).toBe('reported');
  });

  it('holds an interrupted dispatch open, pauses its clock, and follows the decision', async () => {
    const { task, agents: [lead, peer] } = await startedWorkshop(['Paused A', 'Paused B']);
    const ctx = await admitted(task.id, lead!, 'dead');
    await commentOnTask(ctx, 'Halfway through reading the auth module.');
    const resolved = await crashAndRecover(ctx.run);
    expect(resolved).toMatchObject({ status: 'interrupted' });
    expect((await dispatchFor(task.id, lead!)).status).toBe('running');

    await advanceTask(task.id);
    expect((await dispatchFor(task.id, lead!)).pausedAt).not.toBeNull();

    const [retry] = await db
      .select()
      .from(humanRequests)
      .where(and(eq(humanRequests.runId, ctx.run.id), eq(humanRequests.kind, 'retry')));
    await decideInterruptedRun(userId, retry!, { choice: 'continue' });
    const chain = await runsOf(ctx.run.dispatchId!);
    expect(chain.at(-1)).toMatchObject({ dispatchId: ctx.run.dispatchId, gateKey: ctx.run.gateKey });
    expect((await dispatchFor(task.id, lead!)).status).toBe('running');

    // The other member's dispatch is still untouched.
    expect((await dispatchFor(task.id, peer!)).status).toBe('pending');
  });

  it('fails the dispatch when a person stops the interrupted run', async () => {
    const { task, agents: [lead] } = await startedWorkshop(['Halt A', 'Halt B']);
    const ctx = await admitted(task.id, lead!, 'dead');
    await commentOnTask(ctx, 'Started.');
    await crashAndRecover(ctx.run);
    const [retry] = await db
      .select()
      .from(humanRequests)
      .where(and(eq(humanRequests.runId, ctx.run.id), eq(humanRequests.kind, 'retry')));
    await decideInterruptedRun(userId, retry!, { choice: 'stop' });
    expect((await runsOf(ctx.run.dispatchId!)).map((r) => r.status)).toEqual(['cancelled']);
    expect((await dispatchFor(task.id, lead!)).status).toBe('failed');
  });

  it('fails the dispatch when the retry request expires unanswered', async () => {
    const { task, agents: [lead] } = await startedWorkshop(['Expire A', 'Expire B']);
    const ctx = await admitted(task.id, lead!, 'dead');
    await commentOnTask(ctx, 'Started.');
    await crashAndRecover(ctx.run);
    await db
      .update(humanRequests)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(and(eq(humanRequests.runId, ctx.run.id), eq(humanRequests.kind, 'retry')));
    expect(await stopExpiredDecisions()).toContain(ctx.run.id);
    expect((await dispatchFor(task.id, lead!)).status).toBe('failed');
    // A second pass finds nothing left to stop and leaves the dispatch alone.
    expect(await stopExpiredDecisions()).not.toContain(ctx.run.id);
  });
});
