import { and, asc, eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { RunnerError } from '@swarmdev/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config';
import { db, pool } from '../src/db/client';
import { agents, dispatches, humanRequests, runs, tasks, type Agent, type Run } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { commentOnTask, submitDispatchReport, submitResult, type RunToolContext } from '../src/modules/control-plane/tools';
import { handOffRun } from '../src/modules/ownership/handoff';
import { LeaseKeeper, runLeases } from '../src/modules/ownership/lease';
import { recoverRun } from '../src/modules/ownership/recovery';
import { decideInterruptedRun } from '../src/modules/ownership/recovery-decisions';
import { takeOverRun } from '../src/modules/ownership/takeover';
import { admitRun, ownerOf, settleRun } from '../src/modules/runs/runs.service';
import { setTaskHostFactoryForTests } from '../src/modules/runs/task-run';
import { drainRunsForTests } from '../src/modules/runs/wake';
import { advanceTask, setWorkshopRunStarterForTests } from '../src/modules/workshop/advance';
import { agentPhase } from '../src/modules/workshop/phases';
import { scriptedHost } from './support/scripted-host';

/**
 * Time budgets and stop requests: the engine asks for a stop by writing it
 * on the dispatch, the instance holding the run reads it back with its lease
 * renewal and stops the agent itself, and the dispatch's clock spans its
 * follow-up runs but not the time it waits on a person.
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const app = createApp();
let token = '';
let userId = '';
const originalReadOnlyTimeout = config.workshopReadOnlyTimeoutMs;
let workshops = 0;

const auth = () => ({ Authorization: `Bearer ${token}` });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function workshop(names: string[], start = true): Promise<{ taskId: string; ids: string[] }> {
  const ids: string[] = [];
  for (const name of names) {
    const res = await request(app).post('/api/agents').set(auth()).send({ name, runtime: 'claude-code' });
    ids.push((res.body.agent ?? res.body).id);
  }
  const res = await request(app)
    .post('/api/tasks')
    .set(auth())
    .send({ title: `Workshop ${++workshops}`, playbook: 'build', leadAgentId: ids[0], memberAgentIds: ids });
  if (start) await request(app).post(`/api/tasks/${res.body.task.id}/start`).set(auth());
  return { taskId: res.body.task.id, ids };
}

async function dispatchOf(taskId: string, agentId: string, phase = 'explore') {
  const [row] = await db
    .select()
    .from(dispatches)
    .where(and(eq(dispatches.taskId, taskId), eq(dispatches.agentId, agentId), sql`${dispatches.phase} = ${phase}`))
    .orderBy(asc(dispatches.createdAt));
  return row!;
}

async function queuedRunOf(dispatchId: string): Promise<Run> {
  const [run] = await db.select().from(runs).where(and(eq(runs.dispatchId, dispatchId), eq(runs.status, 'queued')));
  return run!;
}

async function contextOf(run: Run): Promise<RunToolContext> {
  const [agent] = await db.select().from(agents).where(eq(agents.id, run.agentId!));
  const [task] = await db.select().from(tasks).where(eq(tasks.id, run.taskId!));
  return { run, epoch: run.ownerEpoch, agent: agent as Agent, task: task! };
}

async function until(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('condition not reached');
    await pause(25);
  }
}

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  const reg = await request(app).post('/auth/register').send({
    email: 'timeouts@example.com',
    username: 'timeouts',
    password: 'a-strong-password',
  });
  token = reg.body.token;
  userId = reg.body.user.id;
});

afterEach(async () => {
  await drainRunsForTests();
  config.workshopReadOnlyTimeoutMs = originalReadOnlyTimeout;
  setTaskHostFactoryForTests(null);
  setWorkshopRunStarterForTests(null);
});

afterAll(async () => {
  await drainRunsForTests();
});

describe('stop requests through the lease', () => {
  it("reads a dispatch's stop request back with the renewal, without losing the lease", async () => {
    setWorkshopRunStarterForTests(async () => {});
    const { taskId, ids } = await workshop(['Holder A', 'Holder B']);
    const keeper = new LeaseKeeper({ instance: 'other-instance', ttlMs: 6_000, killBudgetMs: 500, jitterMs: 500 });
    try {
      const dispatch = await dispatchOf(taskId, ids[0]!);
      const admitted = await keeper.admit((await queuedRunOf(dispatch.id)).id);
      expect(admitted).toBeDefined();
      await keeper.renewNow();
      expect(admitted!.lease.stopSignal.aborted).toBe(false);

      // Another instance (the engine) asks for the stop on the dispatch row.
      await db.update(dispatches).set({ cancelRequestedAt: new Date() }).where(eq(dispatches.id, dispatch.id));
      await keeper.renewNow();
      expect(admitted!.lease.stopSignal.aborted).toBe(true);
      expect(admitted!.lease.lost).toBe(false);
      await settleRun({ runId: admitted!.run.id, epoch: admitted!.lease.epoch, instance: keeper.instance }, { status: 'cancelled' }, 'idle');
    } finally {
      await keeper.stop();
    }
  });

  it('stops a member past its time budget, skips its read-only dispatch, and moves on without it', async () => {
    config.workshopReadOnlyTimeoutMs = 300;
    setTaskHostFactoryForTests((req) =>
      scriptedHost(async (turn) => {
        const [run] = await db
          .select()
          .from(runs)
          .where(and(eq(runs.status, 'running'), eq(runs.agentId, req.agent.id)));
        const ctx = await contextOf(run!);
        const [dispatch] = await db.select().from(dispatches).where(eq(dispatches.id, run!.dispatchId!));
        if (req.agent.name === 'Slowpoke' && dispatch!.phase === 'explore') {
          // Never reports; it only stops when told to.
          await new Promise<void>((resolve) => turn.signal.addEventListener('abort', () => resolve(), { once: true }));
          throw new RunnerError('stopped', 'aborted');
        }
        const tool = agentPhase(dispatch!.phase)!.reportTool;
        if (tool === 'submit_result') await submitResult(ctx, 'Built.');
        else await submitDispatchReport(ctx, tool, { ok: true });
        return { text: 'Done.' };
      })(req)
    );
    const { taskId, ids } = await workshop(['Quick', 'Slowpoke']);
    const slow = ids[1]!;
    await until(async () => (await dispatchOf(taskId, slow)).status === 'running');
    await pause(400);

    await advanceTask(taskId);
    expect((await dispatchOf(taskId, slow)).cancelRequestedAt).not.toBeNull();
    await runLeases.renewNow();
    await until(async () => (await dispatchOf(taskId, slow)).status === 'skipped');
    await drainRunsForTests();

    const [stopped] = await db.select().from(runs).where(eq(runs.dispatchId, (await dispatchOf(taskId, slow)).id));
    expect(stopped).toMatchObject({ status: 'cancelled', stopReason: 'cancel_requested' });
    // Skipped in explore only: the member still reviews the plan, and the workshop reaches build.
    expect((await dispatchOf(taskId, slow, 'plan_review')).status).toBe('reported');
    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(task!.phase).toBe('build');
  });
});

describe('the dispatch clock', () => {
  it('keeps running across a follow-up run instead of starting over', async () => {
    setWorkshopRunStarterForTests(async () => {});
    const { taskId, ids } = await workshop(['Span A', 'Span B']);
    const dispatch = await dispatchOf(taskId, ids[0]!);
    const first = await admitRun((await queuedRunOf(dispatch.id)).id, { instance: 'span-owner' });
    const startedAt = (await dispatchOf(taskId, ids[0]!)).startedAt!;
    await pause(50);
    const followUp = await handOffRun(ownerOf(first!.run), { status: 'cancelled' });
    await admitRun(followUp!.id, { instance: 'span-owner' });
    expect((await dispatchOf(taskId, ids[0]!)).startedAt!.getTime()).toBe(startedAt.getTime());
    const [current] = await db.select().from(runs).where(eq(runs.id, followUp!.id));
    await settleRun(ownerOf(current!), { status: 'cancelled' }, 'idle');
  });

  it('stops while an interrupted run waits on a person and resumes with the follow-up', async () => {
    setWorkshopRunStarterForTests(async () => {});
    const { taskId, ids } = await workshop(['Wait A', 'Wait B']);
    const dispatch = await dispatchOf(taskId, ids[0]!);
    const admitted = await admitRun((await queuedRunOf(dispatch.id)).id, { instance: 'dead' });
    await commentOnTask(await contextOf(admitted!.run), 'Reading.');
    await pause(100);
    await db.update(runs).set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(runs.id, admitted!.run.id));
    await recoverRun((await takeOverRun(admitted!.run.id, { instance: 'recoverer', reason: 'test' }))!);

    await advanceTask(taskId);
    const paused = await dispatchOf(taskId, ids[0]!);
    expect(paused.pausedAt).not.toBeNull();
    expect(paused.startedAt).toBeNull();
    expect(paused.elapsedMs).toBeGreaterThanOrEqual(100);

    const [retry] = await db
      .select()
      .from(humanRequests)
      .where(and(eq(humanRequests.runId, admitted!.run.id), eq(humanRequests.kind, 'retry')));
    // The follow-up starts at once and keeps working until it is told to stop; the other member fails fast.
    setTaskHostFactoryForTests((req) =>
      scriptedHost(async (turn) => {
        if (req.agent.name !== 'Wait A') throw new RunnerError('not part of this test', 'cli_failed');
        await new Promise<void>((resolve) => turn.signal.addEventListener('abort', () => resolve(), { once: true }));
        throw new RunnerError('stopped', 'aborted');
      })(req)
    );
    await decideInterruptedRun(userId, retry!, { choice: 'continue' });
    const running = async () =>
      db.select().from(runs).where(and(eq(runs.dispatchId, dispatch.id), eq(runs.status, 'running')));
    await until(async () => (await running()).length === 1);
    await advanceTask(taskId);
    const resumed = await dispatchOf(taskId, ids[0]!);
    expect(resumed.pausedAt).toBeNull();
    expect(resumed.startedAt).not.toBeNull();
    // Time banked before the pause is kept; the paused span never counted.
    expect(resumed.elapsedMs).toBe(paused.elapsedMs);

    await db.update(dispatches).set({ cancelRequestedAt: new Date() }).where(eq(dispatches.id, dispatch.id));
    await runLeases.renewNow();
    await drainRunsForTests();
    expect((await dispatchOf(taskId, ids[0]!)).status).toBe('skipped');
  });

  it('does not retry a run whose dispatch was told to stop', async () => {
    setWorkshopRunStarterForTests(async () => {});
    const { taskId, ids } = await workshop(['NoRetry A', 'NoRetry B']);
    const dispatch = await dispatchOf(taskId, ids[0]!);
    const admitted = await admitRun((await queuedRunOf(dispatch.id)).id, { instance: 'dead' });
    await db.update(dispatches).set({ cancelRequestedAt: new Date() }).where(eq(dispatches.id, dispatch.id));
    await db.update(runs).set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(runs.id, admitted!.run.id));
    await recoverRun((await takeOverRun(admitted!.run.id, { instance: 'recoverer', reason: 'test' }))!);
    expect((await db.select().from(runs).where(eq(runs.dispatchId, dispatch.id))).map((r) => r.status)).toEqual(['failed']);
    expect((await dispatchOf(taskId, ids[0]!)).status).toBe('skipped');
  });
});
