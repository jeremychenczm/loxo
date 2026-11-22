import path from 'node:path';
import { and, asc, eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import { agents, dispatches, humanRequests, platformOps, runs, tasks, workspaces, type Agent, type Run } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { commentOnTask, type RunToolContext } from '../src/modules/control-plane/tools';
import { answerHumanRequest } from '../src/modules/human-requests/human-requests.service';
import { recoverRun } from '../src/modules/ownership/recovery';
import { decideInterruptedRun } from '../src/modules/ownership/recovery-decisions';
import { takeOverRun } from '../src/modules/ownership/takeover';
import { admitRun, ownerOf, settleRun } from '../src/modules/runs/runs.service';
import { drainRunsForTests, startQueuedRuns } from '../src/modules/runs/wake';
import { advanceTask, setWorkshopRunStarterForTests } from '../src/modules/workshop/advance';
import { noteRunEnded } from '../src/modules/workshop/dispatch-end';
import { notePlatformRunEnded } from '../src/modules/workshop/platform-ops';
import { git, initFixtureRepo, makeSandbox, removeSandbox } from './fixtures/git-repo';

/**
 * The system-wide lock order (run, then task, then dispatch and requests)
 * under forced interleavings: each test holds one lock in a transaction of
 * its own while the paths that need it run, then lets go. Every path must
 * finish, or fail for its own reason, never with a deadlock (40P01).
 *
 * Each runs twice: on a workshop without a repository, where no run has a
 * gate, and on one with a repository, where every worktree is a gate of its
 * own and one task holds several at once.
 */
const app = createApp();
let token = '';
let userId = '';
let repositoryId = '';
let baseCommit = '';
let sandbox = '';
// Platform runs execute for real (they need no agent); agent runs stay queued for the tests to admit.
let executePlatformRuns = true;

const auth = () => ({ Authorization: `Bearer ${token}` });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function startedWorkshop(prefix: string, onRepository: boolean): Promise<{ taskId: string; lead: string; peer: string }> {
  const ids: string[] = [];
  for (const name of [`${prefix} lead`, `${prefix} peer`]) {
    const res = await request(app).post('/api/agents').set(auth()).send({ name, runtime: 'claude-code' });
    ids.push((res.body.agent ?? res.body).id);
  }
  const res = await request(app)
    .post('/api/tasks')
    .set(auth())
    .send({
      title: prefix,
      playbook: 'build',
      leadAgentId: ids[0],
      memberAgentIds: ids,
      ...(onRepository ? { repositoryId } : {}),
    });
  const started = await request(app).post(`/api/tasks/${res.body.task.id}/start`).set(auth());
  expect(started.status).toBe(202);
  await drainRunsForTests();
  return { taskId: res.body.task.id, lead: ids[0]!, peer: ids[1]! };
}

async function dispatchOf(taskId: string, agentId: string) {
  const [row] = await db
    .select()
    .from(dispatches)
    .where(and(eq(dispatches.taskId, taskId), eq(dispatches.agentId, agentId)))
    .orderBy(asc(dispatches.createdAt));
  return row!;
}

async function admit(taskId: string, agentId: string, instance: string): Promise<RunToolContext> {
  const dispatch = await dispatchOf(taskId, agentId);
  const [queued] = await db.select().from(runs).where(and(eq(runs.dispatchId, dispatch.id), eq(runs.status, 'queued')));
  const admission = await admitRun(queued!.id, { instance });
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  return { run: admission!.run, epoch: admission!.run.ownerEpoch, agent: agent as Agent, task: task! };
}

/** Holds a row lock in a transaction of its own until released; `then` runs in it after the release. */
function hold(
  statement: ReturnType<typeof sql>,
  then?: ReturnType<typeof sql>
): { ready: Promise<void>; release: () => void; done: Promise<void> } {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let ready!: () => void;
  const readySignal = new Promise<void>((resolve) => (ready = resolve));
  const done = db.transaction(async (tx) => {
    await tx.execute(statement);
    ready();
    await released;
    if (then) await tx.execute(then);
  });
  return { ready: readySignal, release, done };
}

function settled<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error })
  );
}

function isDeadlock(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return e?.code === '40P01' || e?.cause?.code === '40P01';
}

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  setWorkshopRunStarterForTests(async (queued) => {
    if (executePlatformRuns) await startQueuedRuns(queued.filter((run) => run.actor === 'platform'));
  });
  const reg = await request(app).post('/auth/register').send({
    email: 'locks@example.com',
    username: 'locks',
    password: 'a-strong-password',
  });
  token = reg.body.token;
  userId = reg.body.user.id;
  sandbox = makeSandbox('workshop-locks');
  const repoDir = await initFixtureRepo(path.join(sandbox, 'repo'));
  baseCommit = await git(repoDir, 'rev-parse', 'HEAD');
  const repo = await request(app).post('/api/repositories').set(auth()).send({ rootPath: repoDir });
  repositoryId = repo.body.repository.id;
});

afterEach(async () => {
  await drainRunsForTests();
  executePlatformRuns = true;
});

afterAll(async () => {
  setWorkshopRunStarterForTests(null);
  removeSandbox(sandbox);
});

describe.each([
  { variant: 'without a repository', onRepository: false },
  { variant: 'with a gate per worktree', onRepository: true },
])('lock order, $variant', ({ onRepository }) => {
  it('lets a settling run and an answer both wait behind an advance holding the task', { timeout: 30_000 }, async () => {
    const { taskId, lead, peer } = await startedWorkshop('Held task', onRepository);
    const ctx = await admit(taskId, lead, 'locks-owner');
    // An engine request to answer: the peer's dispatch failed.
    await db.update(dispatches).set({ status: 'failed' }).where(eq(dispatches.id, (await dispatchOf(taskId, peer)).id));
    await db.update(tasks).set({ advancePending: true }).where(eq(tasks.id, taskId));
    await advanceTask(taskId);
    const [req] = await db.select().from(humanRequests).where(eq(humanRequests.taskId, taskId));

    const advance = hold(sql`SELECT 1 FROM tasks WHERE id = ${taskId} FOR UPDATE`);
    await advance.ready;
    const settling = settled(
      db.transaction(async (tx) => {
        const row = await settleRun(ownerOf(ctx.run), { status: 'succeeded' }, 'idle', tx);
        return noteRunEnded(tx, row!.id, { kind: 'settled', status: 'succeeded' });
      })
    );
    const answering = settled(answerHumanRequest(userId, req!.id, { choice: 'retry' }));
    await pause(300);
    advance.release();
    await advance.done;

    const [s, a] = await Promise.all([settling, answering]);
    expect(s.ok).toBe(true);
    expect(a.ok).toBe(true);
    expect((await dispatchOf(taskId, lead)).status).toBe('no_report');
    const [after] = await db.select().from(humanRequests).where(eq(humanRequests.id, req!.id));
    expect(after!.status).toBe('answered');
  });

  it('has a retry decision take the run before the request, so a path holding the run cannot deadlock it', { timeout: 30_000 }, async () => {
    const { taskId, lead } = await startedWorkshop('Held run', onRepository);
    const ctx = await admit(taskId, lead, 'dead');
    await commentOnTask(ctx, 'Started.');
    await db.update(runs).set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(runs.id, ctx.run.id));
    const taken = await takeOverRun(ctx.run.id, { instance: 'recoverer', reason: 'test' });
    const interrupted: Run = await recoverRun(taken!);
    expect(interrupted.status).toBe('interrupted');
    const [retry] = await db
      .select()
      .from(humanRequests)
      .where(and(eq(humanRequests.runId, ctx.run.id), eq(humanRequests.kind, 'retry')));

    // A path that locks the run and then its open requests, such as cancelling them.
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let ready!: () => void;
    const readySignal = new Promise<void>((resolve) => (ready = resolve));
    const runFirst = settled(
      db.transaction(async (tx) => {
        await tx.execute(sql`SELECT 1 FROM runs WHERE id = ${ctx.run.id} FOR UPDATE`);
        ready();
        await released;
        await tx
          .update(humanRequests)
          .set({ status: 'cancelled' })
          .where(and(eq(humanRequests.id, retry!.id), eq(humanRequests.status, 'open')));
      })
    );
    await readySignal;
    const deciding = settled(decideInterruptedRun(userId, retry!, { choice: 'continue' }));
    await pause(300);
    release();

    const [r, d] = await Promise.all([runFirst, deciding]);
    expect(r.ok).toBe(true);
    // The request was cancelled first: the decision is refused as closed, not as a deadlock.
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(isDeadlock(d.error)).toBe(false);
      expect(d.error).toMatchObject({ code: 'request_closed' });
    }
  });
});

describe('lock order across the gates of one task', () => {
  it('settles runs on three gates at once while an advance holds the task', { timeout: 30_000 }, async () => {
    executePlatformRuns = false;
    const { taskId } = await startedWorkshop('Three gates', true);
    const queued = await db.select().from(runs).where(and(eq(runs.taskId, taskId), eq(runs.status, 'queued')));
    expect(queued).toHaveLength(3);
    expect(new Set(queued.map((r) => r.gateKey)).size).toBe(3);
    const admitted: Run[] = [];
    for (const run of queued) admitted.push((await admitRun(run.id, { instance: 'gates-owner' }))!.run);

    // An advance takes the task and then the worktrees; a settlement that took its worktree first would deadlock it.
    const advance = hold(
      sql`SELECT 1 FROM tasks WHERE id = ${taskId} FOR UPDATE`,
      sql`SELECT 1 FROM workspaces WHERE task_id = ${taskId} FOR UPDATE`
    );
    await advance.ready;
    // Each settlement takes its run, then the task, the operation, and last its worktree row.
    const settlements = admitted.map((run) =>
      settled(
        db.transaction(async (tx) => {
          const row = await settleRun(ownerOf(run), { status: 'succeeded' }, 'idle', tx);
          return notePlatformRunEnded(tx, row!, {
            kind: 'done',
            result: { worktree: { id: run.workspaceId!, status: 'ready', headCommit: baseCommit, lastError: null } },
          });
        })
      )
    );
    const advancing = settled(advanceTask(taskId));
    await pause(300);
    advance.release();
    await advance.done;

    for (const outcome of await Promise.all([...settlements, advancing])) {
      if (!outcome.ok) expect(isDeadlock(outcome.error)).toBe(false);
      expect(outcome.ok).toBe(true);
    }
    const ops = await db.select().from(platformOps).where(eq(platformOps.taskId, taskId));
    expect(ops.map((o) => o.status)).toEqual(['done', 'done', 'done']);
    const rows = await db.select().from(workspaces).where(eq(workspaces.taskId, taskId));
    expect(rows.map((w) => w.status)).toEqual(['ready', 'ready', 'ready']);

    // The next advance sends both members out at once, each under its own worktree's gate.
    await advanceTask(taskId);
    const explore = await db
      .select({ gateKey: runs.gateKey })
      .from(runs)
      .innerJoin(dispatches, eq(dispatches.id, runs.dispatchId))
      .where(and(eq(runs.taskId, taskId), eq(dispatches.phase, 'explore')));
    expect(explore).toHaveLength(2);
    expect(new Set(explore.map((r) => r.gateKey)).size).toBe(2);
  });
});
