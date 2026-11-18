import { and, asc, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { db, pool } from '../src/db/client';
import { agents, controlPlaneRequests, runs, tasks, turns } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { mintRunToken } from '../src/modules/control-plane/run-token';
import { buildControlPlaneToolDefs } from '../src/modules/control-plane/tools';
import { armCrashPointForTests } from '../src/modules/ownership/crash-points';
import { fenceRejectionsForTests } from '../src/modules/ownership/fence';
import { setTaskHostFactoryForTests } from '../src/modules/runs/task-run';
import { drainRunsForTests } from '../src/modules/runs/wake';
import { scriptedHost } from './support/scripted-host';

const app = createApp();
let token = '';
const releases: Array<() => void> = [];
let entered: () => void = () => {};
/** Off while a test winds down, so runs its wakes started finish instead of parking. */
let parkRuns = true;

const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  setTaskHostFactoryForTests(
    scriptedHost(async () => {
      entered();
      if (parkRuns) await new Promise<void>((resolve) => releases.push(resolve));
      return { text: 'done' };
    })
  );
  const reg = await request(app)
    .post('/auth/register')
    .send({ email: 'cptx@example.com', username: 'cptxuser', password: 'a-strong-password' });
  token = reg.body.token;
});

afterAll(() => setTaskHostFactoryForTests(null));

afterEach(async () => {
  parkRuns = false;
  for (const release of releases.splice(0)) release();
  await drainRunsForTests();
  parkRuns = true;
});

/** A fresh agent and task (in todo) with the agent's run parked in `running` under epoch 1. */
async function startHeldRun(name: string) {
  const parked = new Promise<void>((resolve) => (entered = resolve));
  const agent = await request(app).post('/api/agents').set(auth()).send({ name, runtime: 'claude-code' });
  const created = await request(app).post('/api/tasks').set(auth()).send({ title: `${name} task` });
  const taskId = created.body.task.id as string;
  await request(app).post(`/api/tasks/${taskId}/move`).set(auth()).send({ status: 'todo' });
  await request(app).patch(`/api/tasks/${taskId}`).set(auth()).send({ leadAgentId: agent.body.agent.id });
  await parked;
  const [run] = await db.select().from(runs).where(eq(runs.taskId, taskId));
  expect(run).toMatchObject({ status: 'running', ownerEpoch: 1 });
  const [agentRow] = await db.select().from(agents).where(eq(agents.id, agent.body.agent.id));
  const [taskRow] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  const tools = buildControlPlaneToolDefs({ run: run!, epoch: 1, agent: agentRow!, task: taskRow! });
  const tool = (name: string) => tools.find((def) => def.name === name)!;
  return { run: run!, taskId, tool };
}

let callId = 0;
function callTool(runToken: string, name: string, args: Record<string, unknown> = {}) {
  callId += 1;
  return request(app)
    .post('/mcp')
    .set({
      Authorization: `Bearer ${runToken}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    })
    .send({ jsonrpc: '2.0', id: callId, method: 'tools/call', params: { name, arguments: args } });
}

function toolText(res: request.Response): string {
  expect(res.status).toBe(200);
  expect(res.body.result.isError).toBeFalsy();
  return res.body.result.content[0].text as string;
}

async function agentTurns(taskId: string): Promise<string[]> {
  const rows = await db
    .select({ content: turns.content })
    .from(turns)
    .where(and(eq(turns.taskId, taskId), eq(turns.kind, 'agent')))
    .orderBy(asc(turns.seq));
  return rows.map((r) => r.content);
}

async function requestRows(runId: string) {
  return db
    .select({ seq: controlPlaneRequests.seq, tool: controlPlaneRequests.tool, epoch: controlPlaneRequests.epoch })
    .from(controlPlaneRequests)
    .where(eq(controlPlaneRequests.runId, runId))
    .orderBy(asc(controlPlaneRequests.seq));
}

async function taskStatus(taskId: string) {
  const [row] = await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId));
  return row!.status;
}

describe('control-plane writes as single fenced transactions', () => {
  it('applies submit_result once however often it is called', async () => {
    const { run, taskId } = await startHeldRun('Submitter');
    const runToken = mintRunToken(run.id, 1);

    const first = await callTool(runToken, 'submit_result', { summary: 'Shipped the export.' });
    const again = await callTool(runToken, 'submit_result', { summary: 'Shipped the export.' });
    const reworded = await callTool(runToken, 'submit_result', { summary: 'A different summary.' });

    for (const res of [first, again, reworded]) expect(JSON.parse(toolText(res))).toEqual({ status: 'in_review' });
    expect(await agentTurns(taskId)).toEqual(['Shipped the export.']);
    const [turn] = await db.select({ epoch: turns.epoch }).from(turns).where(eq(turns.runId, run.id));
    expect(turn!.epoch).toBe(1);
    expect(await taskStatus(taskId)).toBe('in_review');
    expect(await requestRows(run.id)).toEqual([{ seq: 1, tool: 'submit_result', epoch: 1 }]);
  });

  it('serializes concurrent repeats of a terminal tool to one effect', async () => {
    const { run, taskId } = await startHeldRun('Racer');
    const runToken = mintRunToken(run.id, 1);

    const results = await Promise.all(
      [1, 2, 3, 4].map((n) => callTool(runToken, 'submit_result', { summary: `Attempt ${n}` }))
    );

    for (const res of results) expect(JSON.parse(toolText(res))).toEqual({ status: 'in_review' });
    expect(await agentTurns(taskId)).toHaveLength(1);
    expect(await requestRows(run.id)).toHaveLength(1);
  });

  it('rolls back every write of a call that fails before commit', async () => {
    const { run, taskId, tool } = await startHeldRun('Crasher');
    const disarm = armCrashPointForTests('control_plane.before_record');
    try {
      // From todo this posts the question and moves the task twice (via in_progress).
      await expect(tool('ask_blocker').execute({ question: 'Which region?' })).rejects.toThrow(
        'crash point control_plane.before_record'
      );
    } finally {
      disarm();
    }
    expect(await agentTurns(taskId)).toEqual([]);
    expect(await taskStatus(taskId)).toBe('todo');
    expect(await requestRows(run.id)).toEqual([]);

    expect(JSON.parse(await tool('ask_blocker').execute({ question: 'Which region?' }))).toEqual({
      status: 'blocked',
    });
    expect(await agentTurns(taskId)).toEqual(['[BLOCKER] Which region?']);
    expect(await requestRows(run.id)).toEqual([{ seq: 1, tool: 'ask_blocker', epoch: 1 }]);
  });

  it('answers a non-terminal tool from its result only when it repeats the latest call', async () => {
    const { run, taskId, tool } = await startHeldRun('Commenter');
    const comment = tool('comment_on_task');
    for (const body of ['halfway', 'halfway', 'tests pass', 'halfway']) await comment.execute({ body });
    expect(await agentTurns(taskId)).toEqual(['halfway', 'tests pass', 'halfway']);

    const status = tool('update_task_status');
    await status.execute({ status: 'in_progress' });
    await tool('ask_blocker').execute({ question: 'Need a key' });
    expect(JSON.parse(await status.execute({ status: 'in_progress' }))).toEqual({ status: 'in_progress' });
    expect(await taskStatus(taskId)).toBe('in_progress');
    expect((await requestRows(run.id)).map((r) => r.tool)).toEqual([
      'comment_on_task',
      'comment_on_task',
      'comment_on_task',
      'update_task_status',
      'ask_blocker',
      'update_task_status',
    ]);
  });

  it('refuses the write when a takeover commits while the call waits on the run row', async () => {
    const { run, taskId, tool } = await startHeldRun('Raced Worker');
    const other = new pg.Client({ connectionString: config.databaseUrl });
    await other.connect();
    try {
      await other.query('BEGIN');
      await other.query('SELECT 1 FROM runs WHERE id = $1 FOR UPDATE', [run.id]);

      const before = fenceRejectionsForTests();
      const call = tool('comment_on_task').execute({ body: 'written under epoch 1' });
      const outcome = call.then(
        () => 'committed',
        (error: { status?: number }) => error.status
      );
      // The entry check is a plain read and passes; the fenced transaction then queues behind the lock.
      await waitForLockWaiter();

      await other.query(
        `UPDATE runs SET owner_epoch = owner_epoch + 1, owner_instance = 'other-instance',
           lease_expires_at = clock_timestamp() + interval '30 seconds' WHERE id = $1`,
        [run.id]
      );
      await other.query('COMMIT');

      expect(await outcome).toBe(401);
      expect(fenceRejectionsForTests()).toBe(before + 1);
      expect(await agentTurns(taskId)).toEqual([]);
      expect(await requestRows(run.id)).toEqual([]);
    } finally {
      await other.end();
    }
  });
});

async function waitForLockWaiter(): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const [row] = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query ILIKE '%for key share%'`
    ).then((r) => r.rows);
    if (row && row.n > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('the control-plane call never queued behind the run row lock');
}
