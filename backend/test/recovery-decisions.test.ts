import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { and, eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import { humanRequests, runs, turns, workspaces, type Run } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { localGitDriver } from '../src/modules/code-workspaces/local-git-driver';
import { commentOnTask } from '../src/modules/control-plane/tools';
import { answerHumanRequest } from '../src/modules/human-requests/human-requests.service';
import { LeaseKeeper } from '../src/modules/ownership/lease';
import { reconcileOnce } from '../src/modules/ownership/reconciler';
import { setTaskHostFactoryForTests } from '../src/modules/runs/task-run';
import { drainRunsForTests } from '../src/modules/runs/wake';
import { git, initFixtureRepo, makeSandbox, removeSandbox } from './fixtures/git-repo';
import { deadRun as deadRunIn, type DeadRun, type DeadRunOptions } from './support/dead-run';
import { scriptedHost, type ScriptedTurn } from './support/scripted-host';

const app = createApp();
const T = 30_000;
let token = '';
let userId = '';
let repositoryId = '';
let sandbox = '';
let keeper: LeaseKeeper;
const seen: Array<{ prompt: string; files: string[] }> = [];
const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  setTaskHostFactoryForTests(
    scriptedHost(async (turn: ScriptedTurn) => {
      seen.push({ prompt: turn.prompt, files: fs.readdirSync(turn.workspace).sort() });
      return { text: 'Picked up where the last turn stopped.' };
    })
  );
  const reg = await request(app)
    .post('/auth/register')
    .send({ email: 'decisions@example.com', username: 'decisionsuser', password: 'a-strong-password' });
  token = reg.body.token;
  userId = reg.body.user.id;
  sandbox = makeSandbox('recovery-decisions');
  const repo = await initFixtureRepo(path.join(sandbox, 'repo'), {
    'README.md': '# decisions\n',
    'src/app.ts': 'export const app = 1;\n',
    'docs/old.md': 'retired before the run\n',
  });
  const created = await request(app).post('/api/repositories').set(auth()).send({ rootPath: repo });
  repositoryId = created.body.repository.id;
  keeper = new LeaseKeeper({ instance: 'decisions-test' });
});

afterEach(async () => {
  await drainRunsForTests();
  seen.length = 0;
});

afterAll(async () => {
  setTaskHostFactoryForTests(null);
  await keeper.stop();
  removeSandbox(sandbox);
});

const deadRun = (options: DeadRunOptions = {}, act?: (run: DeadRun) => Promise<void>) =>
  deadRunIn({ app, token, userId, repositoryId }, options, act);

/** A run interrupted by recovery, with its open retry request. */
async function interrupted(options: DeadRunOptions, act?: (run: DeadRun) => Promise<void>) {
  const dead = await deadRun(options, act);
  await reconcileOnce(keeper);
  const [decision] = await db
    .select()
    .from(humanRequests)
    .where(and(eq(humanRequests.runId, dead.ctx.run.id), eq(humanRequests.kind, 'retry')));
  expect(decision).toMatchObject({ status: 'open' });
  return { ...dead, decision: decision! };
}

function answer(requestId: string, choice: string) {
  return request(app).post(`/api/human-requests/${requestId}/answer`).set(auth()).send({ choice });
}

async function runRow(id: string): Promise<Run> {
  const [row] = await db.select().from(runs).where(eq(runs.id, id));
  return row!;
}

async function followUps(parentRunId: string): Promise<Run[]> {
  return db.select().from(runs).where(eq(runs.parentRunId, parentRunId));
}

async function workspaceOf(taskId: string) {
  const [row] = await db.select().from(workspaces).where(eq(workspaces.taskId, taskId));
  return row!;
}

async function statusLines(cwd: string): Promise<string[]> {
  const { stdout } = await promisify(execFile)('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return stdout.split('\n').filter(Boolean).sort();
}

describe('deciding on an interrupted run', () => {
  it('continue keeps the changes and queues a follow-up run that sees them', { timeout: T }, async () => {
    const { ctx, decision } = await interrupted({ repository: true }, async ({ worktree }) => {
      fs.writeFileSync(path.join(worktree!, 'half.ts'), 'export const half = true;\n');
    });

    const res = await answer(decision.id, 'continue');
    expect(res.status).toBe(200);
    expect(res.body.request).toMatchObject({ status: 'answered', answer: { choice: 'continue' } });
    await drainRunsForTests();

    expect(await runRow(ctx.run.id)).toMatchObject({ status: 'failed', error: 'Interrupted; continued in a new run' });
    const [next] = await followUps(ctx.run.id);
    expect(next).toMatchObject({ status: 'succeeded', attempt: 2, trigger: 'manual', agentId: ctx.agent.id });
    expect(next!.reason).toContain('still in the worktree');
    expect(next!.reason).toContain(ctx.run.reason);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.files).toContain('half.ts');
    expect(seen[0]!.prompt).toContain('interrupted before it finished');
    expect((await workspaceOf(ctx.task.id)).status).toBe('dirty');
  });

  it('discard puts the worktree back exactly as the run found it, then starts again', { timeout: T }, async () => {
    const { ctx, worktree, decision } = await interrupted(
      {
        repository: true,
        beforePin: (wt) => {
          fs.writeFileSync(path.join(wt, 'README.md'), '# edited before the run\n');
          fs.writeFileSync(path.join(wt, 'notes.md'), 'kept: untracked before the run\n');
          fs.rmSync(path.join(wt, 'docs/old.md'));
        },
      },
      async ({ worktree }) => {
        fs.writeFileSync(path.join(worktree!, 'README.md'), '# rewritten by the agent\n');
        fs.writeFileSync(path.join(worktree!, 'new.ts'), 'export const fresh = 1;\n');
        fs.rmSync(path.join(worktree!, 'src/app.ts'));
        await git(worktree!, 'add', '-A');
        await git(worktree!, 'commit', '-m', 'agent commit');
        fs.writeFileSync(path.join(worktree!, 'extra.ts'), 'export const extra = 1;\n');
      }
    );
    expect(decision.choices).toEqual(['continue', 'discard', 'stop']);
    const before = await runRow(ctx.run.id);

    const res = await answer(decision.id, 'discard');
    expect(res.status).toBe(200);
    await drainRunsForTests();

    const now = await localGitDriver.snapshotTree(worktree!);
    expect(now).toEqual({ head: before.beforeHead, tree: before.beforeTree });
    expect(fs.readFileSync(path.join(worktree!, 'README.md'), 'utf8')).toBe('# edited before the run\n');
    expect(fs.readFileSync(path.join(worktree!, 'src/app.ts'), 'utf8')).toBe('export const app = 1;\n');
    expect(fs.existsSync(path.join(worktree!, 'new.ts'))).toBe(false);
    expect(fs.existsSync(path.join(worktree!, 'extra.ts'))).toBe(false);
    expect(fs.existsSync(path.join(worktree!, 'docs/old.md'))).toBe(false);
    expect(await statusLines(worktree!)).toEqual([' D docs/old.md', ' M README.md', '?? notes.md']);
    expect(await runRow(ctx.run.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('discarded') });
    const [next] = await followUps(ctx.run.id);
    expect(next).toMatchObject({ status: 'succeeded', attempt: 2 });
    expect(next!.reason).toContain('were discarded');
    expect(seen[0]!.files).toEqual(expect.arrayContaining(['README.md', 'notes.md', 'src']));
    expect(seen[0]!.files).not.toContain('new.ts');
    expect((await workspaceOf(ctx.task.id)).status).toBe('dirty');
  });

  it('stop ends the run and leaves the workspace shut until it is reconciled', { timeout: T }, async () => {
    const { ctx, decision } = await interrupted({ repository: true }, async ({ worktree }) => {
      fs.writeFileSync(path.join(worktree!, 'stopped.ts'), 'export const stopped = true;\n');
    });

    expect((await answer(decision.id, 'stop')).status).toBe(200);
    expect(await runRow(ctx.run.id)).toMatchObject({ status: 'cancelled', error: 'Interrupted; stopped by a person' });
    expect(await followUps(ctx.run.id)).toEqual([]);
    expect(await workspaceOf(ctx.task.id)).toMatchObject({
      status: 'quarantined',
      lastError: expect.stringContaining('was stopped after it was interrupted'),
    });
    const notes = await db
      .select({ content: turns.content })
      .from(turns)
      .where(and(eq(turns.taskId, ctx.task.id), eq(turns.kind, 'system')));
    expect(notes.at(-1)!.content).toContain('stopped');

    const lifted = await request(app).post(`/api/tasks/${ctx.task.id}/workspace/reconcile`).set(auth()).send({});
    expect(lifted.status).toBe(200);
    expect(lifted.body.workspace.status).toBe('dirty');
  });

  it('accepts only the offered choices, once, and only while the run is still interrupted', { timeout: T }, async () => {
    const { ctx, decision } = await interrupted({}, async ({ ctx }) => {
      await commentOnTask(ctx, 'Started on the importer.');
    });
    expect(decision.choices).toEqual(['continue', 'stop']);
    const offTheMenu = await answer(decision.id, 'discard');
    expect(offTheMenu.status).toBe(400);
    expect(offTheMenu.body.code).toBe('invalid_choice');
    await expect(answerHumanRequest(userId, decision.id, { choice: 'stop' })).rejects.toMatchObject({
      status: 409,
      code: 'decision_path_required',
    });

    // The run moved on behind the request's back: the answer is refused and nothing commits.
    await db.update(runs).set({ status: 'cancelled' }).where(eq(runs.id, ctx.run.id));
    const raced = await answer(decision.id, 'continue');
    expect(raced.status).toBe(409);
    const [still] = await db.select().from(humanRequests).where(eq(humanRequests.id, decision.id));
    expect(still!.status).toBe('open');
    expect(await followUps(ctx.run.id)).toEqual([]);

    await db
      .update(runs)
      .set({ status: 'interrupted' })
      .where(eq(runs.id, ctx.run.id));
    expect((await answer(decision.id, 'stop')).status).toBe(200);
    const again = await answer(decision.id, 'stop');
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('request_closed');
  });

  it('refuses a late discard before touching the worktree', { timeout: T }, async () => {
    const { worktree, decision } = await interrupted({ repository: true }, async ({ worktree }) => {
      fs.writeFileSync(path.join(worktree!, 'keep-me.ts'), 'export const keep = true;\n');
    });
    await db.update(humanRequests).set({ expiresAt: sql`now() - interval '1 second'` }).where(eq(humanRequests.id, decision.id));
    const res = await answer(decision.id, 'discard');
    expect(res.status).toBe(409);
    expect(fs.existsSync(path.join(worktree!, 'keep-me.ts'))).toBe(true);
  });
});

describe('an unanswered decision', () => {
  it('stops the run once the request expires, whether or not it was already marked expired', { timeout: T }, async () => {
    const first = await interrupted({ repository: true }, async ({ worktree }) => {
      fs.writeFileSync(path.join(worktree!, 'idle.ts'), 'export const idle = 1;\n');
    });
    const second = await interrupted({}, async ({ ctx }) => {
      await commentOnTask(ctx, 'Partway.');
    });
    for (const { decision } of [first, second]) {
      await db.update(humanRequests).set({ expiresAt: sql`now() - interval '1 second'` }).where(eq(humanRequests.id, decision.id));
    }
    // Listing requests marks overdue ones expired; the reconciler must still stop their runs.
    await request(app).get('/api/human-requests').set(auth());

    const pass = await reconcileOnce(keeper);
    expect(pass.stopped.sort()).toEqual([first.ctx.run.id, second.ctx.run.id].sort());
    for (const { ctx, decision } of [first, second]) {
      expect(await runRow(ctx.run.id)).toMatchObject({
        status: 'cancelled',
        error: 'Interrupted; stopped when its retry request expired',
      });
      const [row] = await db.select().from(humanRequests).where(eq(humanRequests.id, decision.id));
      expect(row!.status).toBe('expired');
    }
    expect(await workspaceOf(first.ctx.task.id)).toMatchObject({
      status: 'quarantined',
      lastError: expect.stringContaining('was stopped after it was interrupted'),
    });
    expect((await reconcileOnce(keeper)).stopped).toEqual([]);
  });
});
