import fs from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import { changeSnapshots, runEvents, runs, turns, workspaces } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { fenceRejectionsForTests } from '../src/modules/ownership/fence';
import { RunEventRecorder } from '../src/modules/runs/run-events.service';
import { admitRun } from '../src/modules/runs/runs.service';
import { setTaskHostFactoryForTests } from '../src/modules/runs/task-run';
import { drainRunsForTests, requestWake } from '../src/modules/runs/wake';
import { initFixtureRepo, makeSandbox, removeSandbox } from './fixtures/git-repo';
import { scriptedHost, type ScriptedTurn } from './support/scripted-host';

const app = createApp();
const T = 30_000;
let token = '';
let userId = '';
let repositoryId = '';
let sandbox = '';
let behavior: (turn: ScriptedTurn) => Promise<string> = async () => 'done';

const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  setTaskHostFactoryForTests(scriptedHost(async (turn) => ({ text: await behavior(turn) })));
  const reg = await request(app)
    .post('/auth/register')
    .send({ email: 'epochs@example.com', username: 'epochsuser', password: 'a-strong-password' });
  token = reg.body.token;
  userId = reg.body.user.id;
  sandbox = makeSandbox('write-epochs');
  const repo = await initFixtureRepo(path.join(sandbox, 'repo'), { 'README.md': '# ledger\n' });
  const created = await request(app).post('/api/repositories').set(auth()).send({ rootPath: repo });
  repositoryId = created.body.repository.id;
});

afterAll(() => {
  setTaskHostFactoryForTests(null);
  removeSandbox(sandbox);
});

/** Runs one manual turn of a fresh CLI agent on a fresh task bound to the fixture repo. */
async function runOnCodeTask(name: string, act: (turn: ScriptedTurn, runId: string) => Promise<string>) {
  const agent = await request(app).post('/api/agents').set(auth()).send({ name, runtime: 'claude-code' });
  const agentId = agent.body.agent.id as string;
  const created = await request(app)
    .post('/api/tasks')
    .set(auth())
    .send({ title: `${name} task`, repositoryId, leadAgentId: agentId });
  const taskId = created.body.task.id as string;
  behavior = async (turn) => {
    const [run] = await db.select({ id: runs.id }).from(runs).where(eq(runs.taskId, taskId));
    return act(turn, run!.id);
  };
  await requestWake(userId, { agentId, taskId, trigger: 'manual' });
  await drainRunsForTests();
  const [run] = await db.select().from(runs).where(eq(runs.taskId, taskId));
  return { run: run!, taskId };
}

async function eventEpochs(runId: string) {
  const rows = await db.select({ epoch: runEvents.epoch }).from(runEvents).where(eq(runEvents.runId, runId));
  return rows.map((r) => r.epoch);
}

describe('run writes carry and respect the owner epoch', () => {
  it('stamps events, the capture, and its turns with the writing epoch', { timeout: T }, async () => {
    const { run, taskId } = await runOnCodeTask('Stamped Worker', async (turn) => {
      fs.writeFileSync(path.join(turn.workspace, 'export.ts'), 'export const csv = true;\n');
      return 'Added the export.';
    });

    expect(run).toMatchObject({ status: 'succeeded', ownerEpoch: 1 });
    const epochs = await eventEpochs(run.id);
    expect(epochs.length).toBeGreaterThan(0);
    expect(new Set(epochs)).toEqual(new Set([1]));
    const snapshots = await db.select().from(changeSnapshots).where(eq(changeSnapshots.runId, run.id));
    expect(snapshots).toMatchObject([{ epoch: 1, changedFiles: 1 }]);
    const timeline = await db
      .select({ kind: turns.kind, runId: turns.runId, epoch: turns.epoch, content: turns.content })
      .from(turns)
      .where(eq(turns.taskId, taskId))
      .orderBy(turns.seq);
    expect(timeline).toMatchObject([
      { kind: 'system', runId: run.id, epoch: 1, content: expect.stringContaining('Code changes captured: 1 file(s)') },
      { kind: 'agent', runId: run.id, epoch: 1, content: 'Added the export.' },
    ]);
  });

  it('stops recording events once another owner takes the run over', async () => {
    const agent = await request(app).post('/api/agents').set(auth()).send({ name: 'Recorder', runtime: 'claude-code' });
    const task = await request(app).post('/api/tasks').set(auth()).send({ title: 'Recorder task' });
    const [queued] = await db
      .insert(runs)
      .values({ userId, agentId: agent.body.agent.id, agentName: 'Recorder', taskId: task.body.task.id, trigger: 'manual' })
      .returning();
    const admission = await admitRun(queued!.id, { instance: 'old-owner' });
    const recorder = new RunEventRecorder({
      id: queued!.id,
      userId,
      taskId: task.body.task.id,
      epoch: admission!.run.ownerEpoch,
      instance: 'old-owner',
    });

    recorder.record({ kind: 'status', message: 'before the takeover' });
    await recorder.flush();
    expect(await eventEpochs(queued!.id)).toEqual([1]);

    await db
      .update(runs)
      .set({ ownerInstance: 'new-owner', ownerEpoch: sql`${runs.ownerEpoch} + 1` })
      .where(eq(runs.id, queued!.id));
    const before = fenceRejectionsForTests();
    recorder.record({ kind: 'status', message: 'after the takeover' });
    await recorder.flush();
    recorder.record({ kind: 'status', message: 'ignored once stopped' });
    await recorder.flush();

    expect(await eventEpochs(queued!.id)).toEqual([1]);
    expect(fenceRejectionsForTests()).toBe(before + 1);
  });

  it('refuses every later write of an owner that has not noticed a takeover', { timeout: T }, async () => {
    const before = fenceRejectionsForTests();
    const { run, taskId } = await runOnCodeTask('Overtaken Worker', async (turn, runId) => {
      fs.writeFileSync(path.join(turn.workspace, 'late.ts'), 'export const late = true;\n');
      // Another instance takes over mid-turn; this owner's lease has not renewed since.
      await db
        .update(runs)
        .set({ ownerInstance: 'other-instance', ownerEpoch: sql`${runs.ownerEpoch} + 1` })
        .where(eq(runs.id, runId));
      return 'Finished, as far as I know.';
    });

    expect(run).toMatchObject({ status: 'running', ownerInstance: 'other-instance', ownerEpoch: 2, finishedAt: null });
    expect(await eventEpochs(run.id)).toEqual([]);
    expect(await db.select().from(changeSnapshots).where(eq(changeSnapshots.runId, run.id))).toEqual([]);
    const [workspace] = await db
      .select({ lastRunId: workspaces.lastRunId })
      .from(workspaces)
      .where(eq(workspaces.taskId, taskId));
    expect(workspace!.lastRunId).toBeNull();
    expect(await db.select().from(turns).where(eq(turns.taskId, taskId))).toEqual([]);
    // Event, capture, fallback report, and settlement were each refused.
    expect(fenceRejectionsForTests() - before).toBeGreaterThanOrEqual(4);

    // Release the agent and task gates the abandoned row still holds.
    await db.update(runs).set({ status: 'failed', leaseExpiresAt: null }).where(eq(runs.id, run.id));
  });
});
