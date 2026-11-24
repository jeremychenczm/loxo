import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import { agents, humanRequests, runs, tasks, workspaces } from '../src/db/schema';
import { createApp } from '../src/http/app';
import {
  abandonTaskWorkspace,
  finalizeTaskWorkspace,
  prepareTaskWorkspace,
  reconcileTaskWorkspace,
  type FinalizeInput,
} from '../src/modules/code-workspaces/workspace.service';
import { LeaseKeeper } from '../src/modules/ownership/lease';
import { reconcileOnce, startReconciler } from '../src/modules/ownership/reconciler';
import { createQueuedRun, getRun } from '../src/modules/runs/runs.service';
import { setTaskHostFactoryForTests } from '../src/modules/runs/task-run';
import { drainRunsForTests, requestWake } from '../src/modules/runs/wake';
import { initFixtureRepo, makeSandbox, removeSandbox } from './fixtures/git-repo';
import { scriptedHost } from './support/scripted-host';

/**
 * Reconciler: runs whose owner died are taken over and recovered. A run that
 * did nothing frees its gates and waiting runs move again; a writer that may
 * have touched its workspace is interrupted, and the workspace stays shut
 * until a person decides (recovery.test.ts covers every class).
 */
const app = createApp();
let token = '';
let userId = '';
let repositoryId = '';
let sandbox = '';
let counter = 0;
let keeper: LeaseKeeper;

const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  setTaskHostFactoryForTests(scriptedHost(async () => ({ text: 'picked up after the takeover' })));
  const reg = await request(app).post('/auth/register').send({
    email: 'reconciler@example.com',
    username: 'reconciler',
    password: 'a-strong-password',
  });
  token = reg.body.token;
  userId = reg.body.user.id;
  sandbox = makeSandbox('reconciler');
  const repo = await initFixtureRepo(path.join(sandbox, 'repo'), { 'README.md': '# reconcile\n' });
  const created = await request(app).post('/api/repositories').set(auth()).send({ rootPath: repo });
  repositoryId = created.body.repository.id;
  keeper = new LeaseKeeper({ instance: 'reconciler-test' });
});

afterAll(async () => {
  await drainRunsForTests();
  setTaskHostFactoryForTests(null);
  await keeper.stop();
  removeSandbox(sandbox);
});

async function newAgent(): Promise<string> {
  counter += 1;
  const res = await request(app).post('/api/agents').set(auth()).send({ name: `Worker ${counter}`, runtime: 'claude-code' });
  return res.body.agent.id;
}

async function newTask(withRepository: boolean): Promise<string> {
  counter += 1;
  const res = await request(app)
    .post('/api/tasks')
    .set(auth())
    .send({ title: `Task ${counter}`, ...(withRepository ? { repositoryId } : {}) });
  return res.body.task.id;
}

/** A run left running by an instance that died: its lease ran out a second ago. */
async function orphanedRun(agentId: string, taskId: string, trigger: 'manual' | 'review' = 'manual'): Promise<string> {
  const run = await createQueuedRun(userId, { agentId, agentName: 'Worker', taskId, trigger });
  await db
    .update(runs)
    .set({
      status: 'running',
      ownerInstance: 'dead-instance',
      ownerEpoch: 1,
      leaseExpiresAt: sql`clock_timestamp() - interval '1 second'`,
      startedAt: new Date(),
    })
    .where(eq(runs.id, run.id));
  return run.id;
}

async function queuedRun(agentId: string, taskId: string): Promise<string> {
  return (await createQueuedRun(userId, { agentId, agentName: 'Worker', taskId, trigger: 'manual' })).id;
}

/** Tests on a real repository: their git work takes seconds on a busy disk, past the default limit. */
const REPOSITORY_TIMEOUT = 30_000;

async function prepareWorkspace(taskId: string) {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  return prepareTaskWorkspace(userId, task!);
}

async function workspaceOf(taskId: string) {
  const [row] = await db.select().from(workspaces).where(eq(workspaces.taskId, taskId));
  return row!;
}

describe('reconciler', () => {
  it('takes over a run whose owner died and promotes the run waiting behind it', async () => {
    const [deadAgent, nextAgent] = [await newAgent(), await newAgent()];
    const taskId = await newTask(false);
    const orphan = await orphanedRun(deadAgent, taskId);
    const waiting = await queuedRun(nextAgent, taskId);

    const result = await reconcileOnce(keeper);
    expect(result.takenOver).toContain(orphan);
    expect(result.promoted).toContain(waiting);
    expect(await getRun(userId, orphan)).toMatchObject({
      status: 'failed',
      error: 'Owner lost: lease expired; retrying as attempt 2',
      ownerInstance: 'reconciler-test',
      ownerEpoch: 2,
      leaseExpiresAt: null,
      recoveryClass: 'retry',
      recoveryStep: 'resolved',
    });
    const [agent] = await db.select({ status: agents.status }).from(agents).where(eq(agents.id, deadAgent));
    expect(agent!.status).toBe('error');

    await drainRunsForTests();
    expect((await getRun(userId, waiting)).status).toBe('succeeded');
  });

  it('withdraws the permission requests the lost run left open', async () => {
    const taskId = await newTask(false);
    const orphan = await orphanedRun(await newAgent(), taskId);
    const other = await queuedRun(await newAgent(), await newTask(false));
    const [mine, theirs] = await db
      .insert(humanRequests)
      .values([
        { taskId, runId: orphan, kind: 'permission', choices: ['allow', 'deny'] },
        { taskId, runId: other, kind: 'permission', choices: ['allow', 'deny'] },
      ])
      .returning();

    await reconcileOnce(keeper);
    await drainRunsForTests();
    const statuses = await db.select({ id: humanRequests.id, status: humanRequests.status }).from(humanRequests);
    expect(statuses.find((r) => r.id === mine!.id)?.status).toBe('cancelled');
    expect(statuses.find((r) => r.id === theirs!.id)?.status).toBe('open');
  });

  it('quarantines the workspace a lost writer could touch and holds its task for a decision', { timeout: REPOSITORY_TIMEOUT }, async () => {
    const taskId = await newTask(true);
    await prepareWorkspace(taskId);
    const orphan = await orphanedRun(await newAgent(), taskId);
    const waiting = await queuedRun(await newAgent(), taskId);

    const first = await reconcileOnce(keeper);
    expect(first.takenOver).toContain(orphan);
    expect(first.promoted).not.toContain(waiting);
    expect((await getRun(userId, orphan)).status).toBe('interrupted');
    const quarantined = await workspaceOf(taskId);
    expect(quarantined.status).toBe('quarantined');
    expect(quarantined.lastError).toContain(orphan);
    expect((await getRun(userId, waiting)).status).toBe('queued');

    // A wake that reaches the task anyway waits too; nothing starts or burns the queue.
    const pushed = await requestWake(userId, { agentId: await newAgent(), taskId, trigger: 'manual' });
    expect(pushed.admitted).toBe('queued');
    await drainRunsForTests();
    expect((await getRun(userId, waiting)).status).toBe('queued');
    expect((await workspaceOf(taskId)).status).toBe('quarantined');

    // Reconciling cannot lift the quarantine while the decision is pending.
    await expect(reconcileTaskWorkspace(userId, taskId)).rejects.toMatchObject({ status: 409, code: 'run_interrupted' });
    expect((await workspaceOf(taskId)).status).toBe('quarantined');
    const second = await reconcileOnce(keeper);
    expect(second.promoted).not.toContain(waiting);

    // A person stops the interrupted run, then reconciles; the waiting runs go through in order.
    const [decision] = await db.select().from(humanRequests).where(eq(humanRequests.runId, orphan));
    const stopped = await request(app)
      .post(`/api/human-requests/${decision!.id}/answer`)
      .set(auth())
      .send({ choice: 'stop' });
    expect(stopped.status).toBe(200);
    await reconcileTaskWorkspace(userId, taskId);
    expect(['ready', 'dirty']).toContain((await workspaceOf(taskId)).status);
    const third = await reconcileOnce(keeper);
    expect(third.promoted).toContain(waiting);
    await drainRunsForTests();
    expect((await getRun(userId, waiting)).status).toBe('succeeded');
    expect((await getRun(userId, pushed.run.id)).status).toBe('succeeded');
  });

  it('keeps the task open after losing a run that could not write', { timeout: REPOSITORY_TIMEOUT }, async () => {
    const taskId = await newTask(true);
    await prepareWorkspace(taskId);
    await orphanedRun(await newAgent(), taskId, 'review');
    const waiting = await queuedRun(await newAgent(), taskId);

    const result = await reconcileOnce(keeper);
    expect(result.promoted).toContain(waiting);
    expect((await workspaceOf(taskId)).status).not.toBe('quarantined');
    await drainRunsForTests();
    expect((await getRun(userId, waiting)).status).toBe('succeeded');
  });

  it('refuses to finalize or abandon a workspace while a run is working on the task', { timeout: REPOSITORY_TIMEOUT }, async () => {
    const taskId = await newTask(true);
    await prepareWorkspace(taskId);
    const run = await queuedRun(await newAgent(), taskId);
    expect(await keeper.admit(run)).toBeDefined();

    const busy = { status: 409, code: 'run_in_progress' };
    await expect(abandonTaskWorkspace(userId, taskId, { confirmDiscard: true })).rejects.toMatchObject(busy);
    await expect(finalizeTaskWorkspace(userId, taskId, {} as FinalizeInput)).rejects.toMatchObject(busy);
    keeper.release(run);
  });

  it('fences a run of its own before taking it over', async () => {
    const taskId = await newTask(false);
    const run = await queuedRun(await newAgent(), taskId);
    const admitted = await keeper.admit(run);
    await db
      .update(runs)
      .set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(runs.id, run));

    const result = await reconcileOnce(keeper);
    expect(result.takenOver).toContain(run);
    expect(admitted!.lease.lost).toBe(true);
    expect(admitted!.lease.reason).toMatch(/expired/);
  });

  it('takes a run over exactly once when passes overlap', async () => {
    const orphan = await orphanedRun(await newAgent(), await newTask(false));
    const passes = await Promise.all([reconcileOnce(keeper), reconcileOnce(keeper), reconcileOnce(keeper)]);
    expect(passes.flatMap((p) => p.takenOver).filter((id) => id === orphan)).toHaveLength(1);
    expect((await getRun(userId, orphan)).ownerEpoch).toBe(2);
  });

  it('runs a pass at start-up, keeps passing on its period, and stops when told', async () => {
    const until = async (done: () => Promise<boolean>) => {
      for (let i = 0; i < 100 && !(await done()); i += 1) await new Promise((r) => setTimeout(r, 50));
      expect(await done()).toBe(true);
    };
    const resolved = (runId: string) => async () => (await getRun(userId, runId)).recoveryStep === 'resolved';
    // A one-second lease makes the period about half a second.
    const looping = new LeaseKeeper({ instance: 'reconciler-loop', ttlMs: 1_000, killBudgetMs: 100, jitterMs: 100 });
    const first = await orphanedRun(await newAgent(), await newTask(false));
    const stop = startReconciler(looping);
    try {
      await until(resolved(first));
      const second = await orphanedRun(await newAgent(), await newTask(false));
      await until(resolved(second));
    } finally {
      stop();
    }
    const third = await orphanedRun(await newAgent(), await newTask(false));
    await new Promise((r) => setTimeout(r, 1_500));
    expect((await getRun(userId, third)).status).toBe('running');

    await reconcileOnce(keeper);
    await drainRunsForTests();
    await looping.stop();
  });
});
