import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import { changeSnapshots, runs, workspaces } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { reconcileOnce } from '../src/modules/ownership/reconciler';
import { LeaseKeeper } from '../src/modules/ownership/lease';
import { readRunEffects } from '../src/modules/runs/run-effects';
import { admitRun } from '../src/modules/runs/runs.service';
import { setTaskHostFactoryForTests } from '../src/modules/runs/task-run';
import { drainRunsForTests, requestWake } from '../src/modules/runs/wake';
import { initFixtureRepo, makeSandbox, removeSandbox } from './fixtures/git-repo';
import { scriptedHost, type ScriptedTurn } from './support/scripted-host';

const app = createApp();
const T = 30_000;
let token = '';
let userId = '';
let sandbox = '';
let repositoryId = '';
let behavior: (turn: ScriptedTurn) => Promise<string> = async () => 'done';
const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  setTaskHostFactoryForTests(scriptedHost(async (turn) => ({ text: await behavior(turn) })));
  const reg = await request(app)
    .post('/auth/register')
    .send({ email: 'gates@example.com', username: 'gatesuser', password: 'a-strong-password' });
  token = reg.body.token;
  userId = reg.body.user.id;
  sandbox = makeSandbox('recovery-gates');
  const repo = await initFixtureRepo(path.join(sandbox, 'repo'), { 'README.md': '# gates\n' });
  const created = await request(app).post('/api/repositories').set(auth()).send({ rootPath: repo });
  repositoryId = created.body.repository.id;
});

afterAll(() => {
  setTaskHostFactoryForTests(null);
  removeSandbox(sandbox);
});

async function agent(name: string): Promise<string> {
  const res = await request(app).post('/api/agents').set(auth()).send({ name, runtime: 'claude-code' });
  return res.body.agent.id;
}

async function task(title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await request(app).post('/api/tasks').set(auth()).send({ title, ...extra });
  return res.body.task.id;
}

async function queuedRun(agentId: string, taskId: string) {
  const [row] = await db
    .insert(runs)
    .values({ userId, agentId, agentName: 'gate test', taskId, trigger: 'manual' })
    .returning();
  return row!;
}

/** A run left as recovery leaves an interrupted one. */
async function interruptedRun(agentId: string, taskId: string) {
  const [row] = await db
    .insert(runs)
    .values({
      userId,
      agentId,
      agentName: 'gate test',
      taskId,
      trigger: 'manual',
      status: 'interrupted',
      recoveryStep: 'resolved',
      recoveryClass: 'interrupted',
    })
    .returning();
  return row!;
}

function pgCode(err: unknown): string | undefined {
  return ((err as { cause?: { code?: string } }).cause ?? (err as { code?: string })).code;
}

describe('interrupted runs and the gates', () => {
  it('hold their task but free their agent', { timeout: T }, async () => {
    const first = await agent('Interrupted Agent');
    const second = await agent('Waiting Agent');
    const held = await task('Held task');
    const other = await task('Other task');
    await interruptedRun(first, held);

    const sameTask = await queuedRun(second, held);
    expect(await admitRun(sameTask.id)).toBeUndefined();
    const keeper = new LeaseKeeper({ instance: 'gates-test' });
    const pass = await reconcileOnce(keeper);
    expect(pass.promoted).not.toContain(sameTask.id);
    const [stillQueued] = await db.select().from(runs).where(eq(runs.id, sameTask.id));
    expect(stillQueued!.status).toBe('queued');

    const sameAgent = await queuedRun(first, other);
    const admitted = await admitRun(sameAgent.id);
    expect(admitted?.run.status).toBe('running');
    await db.update(runs).set({ status: 'failed', leaseExpiresAt: null }).where(eq(runs.id, sameAgent.id));
    await db.update(runs).set({ status: 'failed' }).where(eq(runs.id, sameTask.id));
  });

  it('only exist as classified by recovery and without a lease', { timeout: T }, async () => {
    const agentId = await agent('Constraint Agent');
    const taskId = await task('Constraint task');
    const run = await queuedRun(agentId, taskId);

    const unclassified = await db
      .update(runs)
      .set({ status: 'interrupted' })
      .where(eq(runs.id, run.id))
      .then(() => undefined, pgCode);
    expect(unclassified).toBe('23514');
    const leased = await db
      .update(runs)
      .set({ status: 'interrupted', recoveryClass: 'interrupted', ownerInstance: 'x', leaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(runs.id, run.id))
      .then(() => undefined, pgCode);
    expect(leased).toBe('23514');
    await db.update(runs).set({ status: 'failed' }).where(eq(runs.id, run.id));
  });
});

describe('snapshots by kind', () => {
  it('keeps one run snapshot and one recovery snapshot per run, and only the first counts as a committed effect', { timeout: T }, async () => {
    const agentId = await agent('Snapshot Agent');
    const taskId = await task('Snapshot task');
    const run = await queuedRun(agentId, taskId);
    const base = {
      runId: run.id,
      beforeHead: 'a'.repeat(40),
      afterHead: 'a'.repeat(40),
      changeFingerprint: 'f'.repeat(64),
    };

    await db.insert(changeSnapshots).values({ ...base, kind: 'recovery' });
    expect((await readRunEffects(run.id)).captured).toBe(false);
    await db.insert(changeSnapshots).values({ ...base, kind: 'run' });
    expect((await readRunEffects(run.id)).captured).toBe(true);

    expect(await db.insert(changeSnapshots).values({ ...base, kind: 'recovery' }).then(() => undefined, pgCode)).toBe('23505');
    expect(
      await db
        .insert(changeSnapshots)
        .values({ ...base, kind: 'other' as 'run' })
        .then(() => undefined, pgCode)
    ).toBe('23514');
    await db.update(runs).set({ status: 'failed' }).where(eq(runs.id, run.id));
  });
});

describe('a pending decision blocks workspace actions', () => {
  it('refuses finalize, abandon, and lifting the quarantine until the run is decided', { timeout: T }, async () => {
    const agentId = await agent('Workspace Agent');
    const taskId = await task('Pending decision task', { repositoryId, leadAgentId: agentId });
    behavior = async (turn) => {
      fs.writeFileSync(path.join(turn.workspace, 'work.ts'), 'export const work = 1;\n');
      return 'Worked.';
    };
    await requestWake(userId, { agentId, taskId, trigger: 'manual' });
    await drainRunsForTests();
    const interrupted = await interruptedRun(agentId, taskId);
    await db.update(workspaces).set({ status: 'quarantined' }).where(eq(workspaces.taskId, taskId));

    for (const action of ['merge', 'keep-branch', 'abandon', 'reconcile']) {
      const res = await request(app)
        .post(`/api/tasks/${taskId}/workspace/${action}`)
        .set(auth())
        .send({ confirmCheckpoint: true, confirmDiscard: true });
      expect(res.status, action).toBe(409);
      expect(['run_interrupted', 'workspace_unavailable'], action).toContain(res.body.code);
    }
    const abandon = await request(app)
      .post(`/api/tasks/${taskId}/workspace/abandon`)
      .set(auth())
      .send({ confirmDiscard: true });
    expect(abandon.body.code).toBe('run_interrupted');
    const reconcile = await request(app).post(`/api/tasks/${taskId}/workspace/reconcile`).set(auth()).send({});
    expect(reconcile.body.code).toBe('run_interrupted');
    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.taskId, taskId));
    expect(workspace!.status).toBe('quarantined');

    await db.update(runs).set({ status: 'cancelled' }).where(eq(runs.id, interrupted.id));
    const lifted = await request(app).post(`/api/tasks/${taskId}/workspace/reconcile`).set(auth()).send({});
    expect(lifted.status).toBe(200);
    expect(lifted.body.workspace.status).toBe('dirty');
  });
});
