import fs from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import { agents, runs, tasks, type Run, type RunTrigger, type TaskStatus } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { mintRunToken } from '../src/modules/control-plane/run-token';
import { buildControlPlaneToolDefs, type RunToolContext } from '../src/modules/control-plane/tools';
import { armCrashPointForTests } from '../src/modules/ownership/crash-points';
import { hasCommittedEffects, readRunLedger } from '../src/modules/runs/run-ledger';
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
let behavior: (turn: ScriptedTurn) => Promise<string> = async () => 'done';
const auth = () => ({ Authorization: `Bearer ${token}` });

const EMPTY = { controlPlaneWrites: 0, terminal: null, captured: false, timelineEntries: 0 };

/** Arguments for every control-plane tool; a new tool must be added here before the suite passes. */
const SAMPLE_ARGS: Record<string, Record<string, unknown>> = {
  get_task: {},
  comment_on_task: { body: 'Progress note.' },
  ask_blocker: { question: 'Which currency should totals use?' },
  update_task_status: { status: 'in_progress' },
  submit_result: { summary: 'Totals now use the ledger currency.' },
  submit_review: { decision: 'approved', feedback: 'Matches the brief.' },
};
const READ_ONLY_TOOLS = new Set(['get_task']);
const CALL_ORDER = Object.keys(SAMPLE_ARGS);

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  setTaskHostFactoryForTests(scriptedHost(async (turn) => ({ text: await behavior(turn) })));
  const reg = await request(app)
    .post('/auth/register')
    .send({ email: 'ledger@example.com', username: 'ledgeruser', password: 'a-strong-password' });
  token = reg.body.token;
  userId = reg.body.user.id;
  sandbox = makeSandbox('run-ledger');
});

afterAll(() => {
  setTaskHostFactoryForTests(null);
  removeSandbox(sandbox);
});

/** A running run of a fresh agent on a fresh task without a lead, so tool moves wake nobody. */
async function heldRun(name: string, trigger: RunTrigger, status: TaskStatus): Promise<RunToolContext> {
  const agentRes = await request(app).post('/api/agents').set(auth()).send({ name, runtime: 'claude-code' });
  const taskRes = await request(app).post('/api/tasks').set(auth()).send({ title: `${name} task` });
  const taskId = taskRes.body.task.id as string;
  await db.update(tasks).set({ status }).where(eq(tasks.id, taskId));
  const [queued] = await db
    .insert(runs)
    .values({ userId, agentId: agentRes.body.agent.id, agentName: name, taskId, trigger })
    .returning();
  const admission = await admitRun(queued!.id, {});
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentRes.body.agent.id));
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  return { run: admission!.run, epoch: admission!.run.ownerEpoch, agent: agent!, task: task! };
}

async function settleByHand(run: Run): Promise<void> {
  await db.update(runs).set({ status: 'succeeded', leaseExpiresAt: null }).where(eq(runs.id, run.id));
}

let callId = 0;
async function mcpToolNames(run: Run, epoch: number): Promise<string[]> {
  callId += 1;
  const res = await request(app)
    .post('/mcp')
    .set({
      Authorization: `Bearer ${mintRunToken(run.id, epoch)}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    })
    .send({ jsonrpc: '2.0', id: callId, method: 'tools/list' });
  expect(res.status).toBe(200);
  return (res.body.result.tools as Array<{ name: string }>).map((t) => t.name).sort();
}

describe('the run ledger', () => {
  it('records exactly one entry per committed write on every tool surface', { timeout: T }, async () => {
    const lead = await heldRun('Ledger Lead', 'manual', 'in_progress');
    const reviewer = await heldRun('Ledger Reviewer', 'review', 'in_review');

    for (const ctx of [lead, reviewer]) {
      expect(await readRunLedger(ctx.run.id)).toEqual(EMPTY);
      const defs = buildControlPlaneToolDefs(ctx);
      expect(await mcpToolNames(ctx.run, ctx.epoch)).toEqual(defs.map((d) => d.name).sort());
      for (const def of defs) expect(SAMPLE_ARGS, `sample args for ${def.name}`).toHaveProperty(def.name);

      const ordered = [...defs].sort((a, b) => CALL_ORDER.indexOf(a.name) - CALL_ORDER.indexOf(b.name));
      for (const def of ordered) {
        const before = await readRunLedger(ctx.run.id);
        await def.execute(SAMPLE_ARGS[def.name]!);
        const after = await readRunLedger(ctx.run.id);
        expect(after.controlPlaneWrites - before.controlPlaneWrites, def.name).toBe(READ_ONLY_TOOLS.has(def.name) ? 0 : 1);
      }
    }

    expect(await readRunLedger(lead.run.id)).toEqual({
      controlPlaneWrites: 4,
      terminal: { tool: 'submit_result', result: { status: 'in_review' } },
      captured: false,
      timelineEntries: 3,
    });
    const review = await readRunLedger(reviewer.run.id);
    expect(review).toMatchObject({ controlPlaneWrites: 2, terminal: { tool: 'submit_review' }, captured: false });
    expect(review.terminal!.result).toMatchObject({ status: 'in_review', halted: false });
    expect(hasCommittedEffects(review)).toBe(true);
    await settleByHand(lead.run);
    await settleByHand(reviewer.run);
  });

  it('shows nothing for a write that rolled back', { timeout: T }, async () => {
    const ctx = await heldRun('Rolled Back', 'manual', 'in_progress');
    const comment = buildControlPlaneToolDefs(ctx).find((d) => d.name === 'comment_on_task')!;
    const disarm = armCrashPointForTests('control_plane.before_record');
    try {
      await expect(comment.execute(SAMPLE_ARGS.comment_on_task!)).rejects.toThrow('crash point');
    } finally {
      disarm();
    }
    const ledger = await readRunLedger(ctx.run.id);
    expect(ledger).toEqual(EMPTY);
    expect(hasCommittedEffects(ledger)).toBe(false);
    await settleByHand(ctx.run);
  });

  describe('on a code task', () => {
    let repositoryId = '';

    beforeAll(async () => {
      const repo = await initFixtureRepo(path.join(sandbox, 'repo'), { 'README.md': '# ledger\n' });
      const created = await request(app).post('/api/repositories').set(auth()).send({ rootPath: repo });
      repositoryId = created.body.repository.id;
    });

    async function runOnCodeTask(name: string, act: (turn: ScriptedTurn, runId: string) => Promise<string>) {
      const agent = await request(app).post('/api/agents').set(auth()).send({ name, runtime: 'claude-code' });
      const task = await request(app)
        .post('/api/tasks')
        .set(auth())
        .send({ title: `${name} task`, repositoryId, leadAgentId: agent.body.agent.id });
      const taskId = task.body.task.id as string;
      behavior = async (turn) => {
        const [run] = await db.select({ id: runs.id }).from(runs).where(eq(runs.taskId, taskId));
        return act(turn, run!.id);
      };
      await requestWake(userId, { agentId: agent.body.agent.id, taskId, trigger: 'manual' });
      await drainRunsForTests();
      const [run] = await db.select().from(runs).where(eq(runs.taskId, taskId));
      return run!;
    }

    it('counts the capture and the timeline entries it committed', { timeout: T }, async () => {
      const run = await runOnCodeTask('Capturing Worker', async (turn) => {
        fs.writeFileSync(path.join(turn.workspace, 'totals.ts'), 'export const total = 0;\n');
        return 'Added totals.';
      });
      expect(run.status).toBe('succeeded');
      expect(await readRunLedger(run.id)).toEqual({
        controlPlaneWrites: 0,
        terminal: null,
        captured: true,
        timelineEntries: 2,
      });
    });

    it('stays empty for an owner whose writes were fenced off', { timeout: T }, async () => {
      const run = await runOnCodeTask('Fenced Worker', async (turn, runId) => {
        fs.writeFileSync(path.join(turn.workspace, 'late.ts'), 'export const late = true;\n');
        await db
          .update(runs)
          .set({ ownerInstance: 'other-instance', ownerEpoch: sql`${runs.ownerEpoch} + 1` })
          .where(eq(runs.id, runId));
        return 'Finished, as far as I know.';
      });
      expect(run).toMatchObject({ status: 'running', ownerInstance: 'other-instance' });
      expect(await readRunLedger(run.id)).toEqual(EMPTY);
      await db.update(runs).set({ status: 'failed', leaseExpiresAt: null }).where(eq(runs.id, run.id));
    });
  });
});
