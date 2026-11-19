import fs from 'node:fs';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import { agents, changeSnapshots, humanRequests, runs, turns, workspaces, type Run } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { runBeforeRef } from '../src/modules/code-workspaces/branch-name';
import { commentOnTask, submitResult } from '../src/modules/control-plane/tools';
import { armCrashPointForTests } from '../src/modules/ownership/crash-points';
import { FencedError } from '../src/modules/ownership/fence';
import { LeaseKeeper } from '../src/modules/ownership/lease';
import { reconcileOnce } from '../src/modules/ownership/reconciler';
import { classifyRecovery, recoverRun, setRetryPolicyForTests } from '../src/modules/ownership/recovery';
import { admitRun } from '../src/modules/runs/runs.service';
import { initFixtureRepo, makeSandbox, removeSandbox } from './fixtures/git-repo';
import { deadRun as deadRunIn, type DeadRunOptions, type DeadRun } from './support/dead-run';

const app = createApp();
const T = 30_000;
let token = '';
let userId = '';
let repositoryId = '';
let sandbox = '';
let keeper: LeaseKeeper;
const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  const reg = await request(app)
    .post('/auth/register')
    .send({ email: 'recovery@example.com', username: 'recoveryuser', password: 'a-strong-password' });
  token = reg.body.token;
  userId = reg.body.user.id;
  sandbox = makeSandbox('recovery');
  const repo = await initFixtureRepo(path.join(sandbox, 'repo'), { 'README.md': '# recovery\n' });
  const created = await request(app).post('/api/repositories').set(auth()).send({ rootPath: repo });
  repositoryId = created.body.repository.id;
  keeper = new LeaseKeeper({ instance: 'recovery-test' });
  // Retries stay queued here; auto-retry.test.ts runs them.
  setRetryPolicyForTests({ backoffMs: 3_600_000 });
});

afterAll(async () => {
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

async function retryRequests(runId: string) {
  return db.select().from(humanRequests).where(and(eq(humanRequests.runId, runId), eq(humanRequests.kind, 'retry')));
}

async function recoverySnapshots(runId: string) {
  return db.select().from(changeSnapshots).where(and(eq(changeSnapshots.runId, runId), eq(changeSnapshots.kind, 'recovery')));
}

async function workspaceStatus(taskId: string): Promise<string | undefined> {
  const [row] = await db.select({ status: workspaces.status }).from(workspaces).where(eq(workspaces.taskId, taskId));
  return row?.status;
}

function expireLease(runId: string) {
  return db.update(runs).set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(runs.id, runId));
}

describe('classifying a run that lost its owner', () => {
  const ledger = { controlPlaneWrites: 0, terminal: null, captured: false, timelineEntries: 0 };
  it('retries only a run that committed nothing, changed nothing, and leaves no possible orphan', () => {
    const cases: Array<[Parameters<typeof classifyRecovery>[0], string]> = [
      [{ ledger, worktree: 'none', orphanRisk: false }, 'retry'],
      [{ ledger, worktree: 'unchanged', orphanRisk: false }, 'retry'],
      [{ ledger, worktree: 'unchanged', orphanRisk: true }, 'interrupted'],
      [{ ledger, worktree: 'unknown', orphanRisk: false }, 'interrupted'],
      [{ ledger, worktree: 'changed', orphanRisk: false }, 'interrupted'],
      [{ ledger: { ...ledger, timelineEntries: 1 }, worktree: 'none', orphanRisk: false }, 'interrupted'],
      [{ ledger: { ...ledger, captured: true }, worktree: 'unchanged', orphanRisk: false }, 'interrupted'],
      [{ ledger: { ...ledger, controlPlaneWrites: 1 }, worktree: 'none', orphanRisk: false }, 'interrupted'],
      [
        { ledger: { ...ledger, controlPlaneWrites: 2, terminal: { tool: 'submit_result', result: {} } }, worktree: 'changed', orphanRisk: true },
        'known',
      ],
    ];
    for (const [facts, expected] of cases) expect(classifyRecovery(facts), JSON.stringify(facts)).toBe(expected);
  });
});

describe('recovering a run whose owner died', () => {
  it('settles a run whose result was already submitted, and shuts its worktree', { timeout: T }, async () => {
    const { ctx } = await deadRun({ repository: true }, async ({ ctx, worktree }) => {
      fs.writeFileSync(path.join(worktree!, 'ledger.ts'), 'export const ledger = [];\n');
      await submitResult(ctx, 'Ledger module added.');
      fs.writeFileSync(path.join(worktree!, 'after.ts'), 'export const after = 1;\n');
    });

    const pass = await reconcileOnce(keeper);
    expect(pass.takenOver).toContain(ctx.run.id);
    expect(await runRow(ctx.run.id)).toMatchObject({
      status: 'succeeded',
      stopReason: 'owner_lost',
      error: null,
      recoveryStep: 'resolved',
      recoveryClass: 'known',
      ownerInstance: 'recovery-test',
      ownerEpoch: 2,
      leaseExpiresAt: null,
    });
    expect(await recoverySnapshots(ctx.run.id)).toMatchObject([{ epoch: 2, changedFiles: 2 }]);
    expect(await retryRequests(ctx.run.id)).toEqual([]);
    expect(await workspaceStatus(ctx.task.id)).toBe('quarantined');
    const [agent] = await db.select({ status: agents.status }).from(agents).where(eq(agents.id, ctx.agent.id));
    expect(agent!.status).toBe('idle');
  });

  it('interrupts a run that only commented, holding its task but not its agent', { timeout: T }, async () => {
    const { ctx } = await deadRun({}, async ({ ctx }) => {
      await commentOnTask(ctx, 'Halfway through the importer.');
    });

    await reconcileOnce(keeper);
    expect(await runRow(ctx.run.id)).toMatchObject({
      status: 'interrupted',
      recoveryClass: 'interrupted',
      recoveryStep: 'resolved',
      ownerEpoch: 2,
      leaseExpiresAt: null,
      finishedAt: null,
    });
    const [decision] = await retryRequests(ctx.run.id);
    expect(decision).toMatchObject({ status: 'open', choices: ['continue', 'stop'] });
    expect(decision!.payload).toMatchObject({ runId: ctx.run.id, controlPlaneWrites: 1, timelineEntries: 1, beforeRef: null });
    expect(decision!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    const notes = await db
      .select({ content: turns.content, runId: turns.runId, epoch: turns.epoch })
      .from(turns)
      .where(and(eq(turns.taskId, ctx.task.id), eq(turns.kind, 'system')));
    expect(notes).toMatchObject([{ runId: ctx.run.id, epoch: 2, content: expect.stringContaining('continue, or stop') }]);

    const [sameTask] = await db
      .insert(runs)
      .values({ userId, agentId: ctx.agent.id, agentName: 'again', taskId: ctx.task.id, trigger: 'manual' })
      .returning();
    expect(await admitRun(sameTask!.id)).toBeUndefined();
    const otherTask = await request(app).post('/api/tasks').set(auth()).send({ title: 'Elsewhere' });
    const [elsewhere] = await db
      .insert(runs)
      .values({ userId, agentId: ctx.agent.id, agentName: 'again', taskId: otherTask.body.task.id, trigger: 'manual' })
      .returning();
    expect((await admitRun(elsewhere!.id))?.run.status).toBe('running');
    await db.update(runs).set({ status: 'failed', leaseExpiresAt: null }).where(eq(runs.id, elsewhere!.id));
    await db.update(runs).set({ status: 'failed' }).where(eq(runs.id, sameTask!.id));
  });

  it('interrupts a writer that changed its worktree and offers to discard back to the before-state', { timeout: T }, async () => {
    const { ctx } = await deadRun({ repository: true }, async ({ worktree }) => {
      fs.writeFileSync(path.join(worktree!, 'half.ts'), 'export const half = true;\n');
    });

    await reconcileOnce(keeper);
    expect(await runRow(ctx.run.id)).toMatchObject({ status: 'interrupted', recoveryClass: 'interrupted' });
    const [decision] = await retryRequests(ctx.run.id);
    expect(decision!.choices).toEqual(['continue', 'discard', 'stop']);
    expect(decision!.payload).toMatchObject({ changedFiles: 1, beforeRef: runBeforeRef(ctx.run.id), controlPlaneWrites: 0 });
    expect(await recoverySnapshots(ctx.run.id)).toMatchObject([{ changedFiles: 1, policyViolation: false }]);
    expect(await workspaceStatus(ctx.task.id)).toBe('quarantined');
  });

  it('interrupts a writer that changed nothing while its processes may still be alive', { timeout: T }, async () => {
    const { ctx } = await deadRun({ repository: true });
    await reconcileOnce(keeper);
    expect(await runRow(ctx.run.id)).toMatchObject({ status: 'interrupted', recoveryClass: 'interrupted' });
    expect(await recoverySnapshots(ctx.run.id)).toMatchObject([{ changedFiles: 0 }]);
  });

  it('interrupts a writer that died before recording its before-state', { timeout: T }, async () => {
    const { ctx } = await deadRun({ repository: true, pinBefore: false });
    await reconcileOnce(keeper);
    expect(await runRow(ctx.run.id)).toMatchObject({ status: 'interrupted', beforeTree: null });
    expect((await retryRequests(ctx.run.id))[0]!.choices).toEqual(['continue', 'stop']);
  });

  it('fails a read-only run that did nothing, leaving it to be retried and the task open', { timeout: T }, async () => {
    const { ctx } = await deadRun({ repository: true, trigger: 'review' });
    await reconcileOnce(keeper);
    expect(await runRow(ctx.run.id)).toMatchObject({
      status: 'failed',
      error: 'Owner lost: lease expired; retrying as attempt 2',
      recoveryClass: 'retry',
      recoveryStep: 'resolved',
    });
    expect(await retryRequests(ctx.run.id)).toEqual([]);
    expect(await workspaceStatus(ctx.task.id)).not.toBe('quarantined');
  });

  it('interrupts a read-only run that changed tracked files, flagging the violation', { timeout: T }, async () => {
    const { ctx } = await deadRun({ repository: true, trigger: 'review' }, async ({ worktree }) => {
      fs.writeFileSync(path.join(worktree!, 'README.md'), '# edited by a reviewer\n');
    });
    await reconcileOnce(keeper);
    expect(await runRow(ctx.run.id)).toMatchObject({ status: 'interrupted' });
    expect(await recoverySnapshots(ctx.run.id)).toMatchObject([{ changedFiles: 1, policyViolation: true }]);
  });
});

describe('recovery survives its own crashes', () => {
  it('resumes from taken_over and ends exactly as one uninterrupted pass would', { timeout: T }, async () => {
    const { ctx } = await deadRun({ repository: true }, async ({ worktree }) => {
      fs.writeFileSync(path.join(worktree!, 'partial.ts'), 'export const partial = 1;\n');
    });
    const disarm = armCrashPointForTests('recovery.before_assess');
    try {
      await reconcileOnce(keeper);
    } finally {
      disarm();
    }
    expect(await runRow(ctx.run.id)).toMatchObject({ status: 'running', recoveryStep: 'taken_over', ownerEpoch: 2 });
    expect(await recoverySnapshots(ctx.run.id)).toEqual([]);

    // Still leased to the recoverer that "died": nothing happens until the lease runs out.
    expect((await reconcileOnce(keeper)).takenOver).not.toContain(ctx.run.id);
    await expireLease(ctx.run.id);
    await reconcileOnce(keeper);
    expect(await runRow(ctx.run.id)).toMatchObject({ status: 'interrupted', recoveryStep: 'resolved', ownerEpoch: 3 });
    expect(await recoverySnapshots(ctx.run.id)).toMatchObject([{ epoch: 3, changedFiles: 1 }]);
    expect(await retryRequests(ctx.run.id)).toHaveLength(1);
  });

  it('resumes from assessed without capturing twice, and fences the recoverer that died', { timeout: T }, async () => {
    const { ctx } = await deadRun({ repository: true }, async ({ worktree }) => {
      fs.writeFileSync(path.join(worktree!, 'partial.ts'), 'export const partial = 2;\n');
    });
    const disarm = armCrashPointForTests('recovery.before_resolve');
    try {
      await reconcileOnce(keeper);
    } finally {
      disarm();
    }
    const stale = await runRow(ctx.run.id);
    expect(stale).toMatchObject({ status: 'running', recoveryStep: 'assessed', recoveryClass: 'interrupted', ownerEpoch: 2 });
    expect(await recoverySnapshots(ctx.run.id)).toHaveLength(1);
    expect(await retryRequests(ctx.run.id)).toEqual([]);

    await expireLease(ctx.run.id);
    await reconcileOnce(keeper);
    expect(await runRow(ctx.run.id)).toMatchObject({ status: 'interrupted', ownerEpoch: 3 });
    expect(await recoverySnapshots(ctx.run.id)).toMatchObject([{ epoch: 2 }]);
    expect(await retryRequests(ctx.run.id)).toHaveLength(1);
    const notes = await db.select().from(turns).where(and(eq(turns.runId, ctx.run.id), eq(turns.kind, 'system')));
    expect(notes).toHaveLength(1);

    // The recoverer that died wakes up and tries to finish under epoch 2.
    await expect(recoverRun(stale)).rejects.toBeInstanceOf(FencedError);
    expect(await retryRequests(ctx.run.id)).toHaveLength(1);
  });
});
