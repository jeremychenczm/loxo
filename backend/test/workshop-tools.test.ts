import { and, asc, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import { agents, dispatchReports, dispatches, runs, tasks, turns, type Agent, type WorkshopPhase } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { CONTROL_PLANE_TOOLS, toolsForRun } from '../src/modules/control-plane/names';
import { mintRunToken } from '../src/modules/control-plane/run-token';
import {
  buildControlPlaneToolDefs,
  submitDispatchReport,
  submitResult,
  type RunToolContext,
} from '../src/modules/control-plane/tools';
import { admitRun } from '../src/modules/runs/runs.service';
import { drainRunsForTests } from '../src/modules/runs/wake';
import { setWorkshopRunStarterForTests } from '../src/modules/workshop/advance';
import { PHASES } from '../src/modules/workshop/phases';

/**
 * What a workshop run is offered: its phase's report tool, and in a blind
 * phase nothing that would post where its peers could read it. The MCP
 * endpoint and the in-process tools of API agents offer the same set.
 */
const app = createApp();
let token = '';

const auth = () => ({ Authorization: `Bearer ${token}` });
const AGENT_PHASES = (Object.keys(PHASES) as WorkshopPhase[]).filter((p) => PHASES[p].kind === 'agent');

async function newAgent(name: string): Promise<string> {
  const res = await request(app).post('/api/agents').set(auth()).send({ name, runtime: 'claude-code' });
  return res.body.agent.id;
}

/** A started two-member workshop with the lead's explore run admitted and held by the test. */
async function heldExploreRun(title: string): Promise<RunToolContext> {
  setWorkshopRunStarterForTests(async () => {});
  const ids = [await newAgent(`${title} lead`), await newAgent(`${title} peer`)];
  const created = await request(app)
    .post('/api/tasks')
    .set(auth())
    .send({ title, playbook: 'build', leadAgentId: ids[0], memberAgentIds: ids });
  const taskId = created.body.task.id as string;
  await request(app).post(`/api/tasks/${taskId}/start`).set(auth());
  const [dispatch] = await db
    .select()
    .from(dispatches)
    .where(and(eq(dispatches.taskId, taskId), eq(dispatches.agentId, ids[0]!)));
  const [queued] = await db.select().from(runs).where(eq(runs.dispatchId, dispatch!.id)).orderBy(asc(runs.createdAt));
  const admission = await admitRun(queued!.id, { instance: 'workshop-tools-test' });
  const [agent] = await db.select().from(agents).where(eq(agents.id, ids[0]!));
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  return { run: admission!.run, epoch: admission!.run.ownerEpoch, agent: agent as Agent, task: task!, phase: 'explore' };
}

let callId = 0;
function mcp(ctx: RunToolContext, method: string, params?: Record<string, unknown>) {
  callId += 1;
  return request(app)
    .post('/mcp')
    .set({
      Authorization: `Bearer ${mintRunToken(ctx.run.id, ctx.epoch)}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    })
    .send({ jsonrpc: '2.0', id: callId, method, ...(params ? { params } : {}) });
}

const listed = async (ctx: RunToolContext) =>
  ((await mcp(ctx, 'tools/list')).body.result.tools as { name: string }[]).map((t) => t.name);

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  const reg = await request(app).post('/auth/register').send({
    email: 'workshop-tools@example.com',
    username: 'workshoptools',
    password: 'a-strong-password',
  });
  token = reg.body.token;
});

afterEach(() => setWorkshopRunStarterForTests(null));

afterAll(async () => {
  await drainRunsForTests();
});

describe('tools by phase', () => {
  it('offers each phase its report tool, and blind phases nothing their peers could read', () => {
    const run = { trigger: 'dispatch' as const, dispatchId: 'd' };
    expect(toolsForRun(run, 'explore')).toEqual(['get_task', 'submit_exploration']);
    expect(toolsForRun(run, 'plan')).toEqual(['get_task', 'comment_on_task', 'ask_blocker']);
    expect(toolsForRun(run, 'plan_review')).toEqual(['get_task']);
    expect(toolsForRun(run, 'build')).toEqual(['get_task', 'comment_on_task', 'ask_blocker', 'submit_result']);
    for (const phase of AGENT_PHASES) {
      const offered = toolsForRun(run, phase);
      const spec = PHASES[phase];
      if (spec.kind !== 'agent') continue;
      if (spec.blind) expect(offered).not.toEqual(expect.arrayContaining(['comment_on_task']));
      if (spec.blind) expect(offered).not.toEqual(expect.arrayContaining(['ask_blocker']));
      expect(offered).not.toEqual(expect.arrayContaining(['update_task_status']));
      // Every report tool offered is the phase's own.
      for (const tool of offered.filter((t) => t.startsWith('submit_'))) expect(tool).toBe(spec.reportTool);
    }
    // Legacy runs keep their sets.
    expect(toolsForRun({ trigger: 'assignment', dispatchId: null }, null)).toEqual([
      'get_task',
      'comment_on_task',
      'update_task_status',
      'ask_blocker',
      'submit_result',
    ]);
    expect(toolsForRun({ trigger: 'review', dispatchId: null }, null)).toEqual(['get_task', 'comment_on_task', 'submit_review']);
    // The permission policy lets every offered tool through without a person.
    for (const phase of AGENT_PHASES) {
      expect(CONTROL_PLANE_TOOLS).toEqual(expect.arrayContaining(toolsForRun(run, phase)));
    }
  });

  it('lists the same tools over MCP and to API agents in every phase', async () => {
    const ctx = await heldExploreRun('Same tools');
    for (const phase of AGENT_PHASES) {
      await db.update(dispatches).set({ phase }).where(eq(dispatches.id, ctx.run.dispatchId!));
      const expected = toolsForRun(ctx.run, phase);
      expect(await listed(ctx)).toEqual(expected);
      expect(buildControlPlaneToolDefs({ ...ctx, phase }).map((d) => d.name)).toEqual(expected);
    }
    await db.update(dispatches).set({ phase: 'explore' }).where(eq(dispatches.id, ctx.run.dispatchId!));
  });
});

describe('submit_exploration', () => {
  it('records a normalized exploration over MCP and refuses tools the phase does not offer', async () => {
    const ctx = await heldExploreRun('Explore over MCP');
    const comment = await mcp(ctx, 'tools/call', { name: 'comment_on_task', arguments: { body: 'peers would see this' } });
    expect(JSON.stringify(comment.body)).toMatch(/not found/i);
    const bad = await mcp(ctx, 'tools/call', {
      name: 'submit_exploration',
      arguments: { summary: 'Too many', questions: ['a', 'b', 'c', 'd', 'e', 'f'] },
    });
    expect(bad.body.result?.isError ?? bad.body.error).toBeTruthy();

    const res = await mcp(ctx, 'tools/call', {
      name: 'submit_exploration',
      arguments: { summary: '  Login lives in auth/session.ts.  ', questions: ['May we add a dependency?'] },
    });
    expect(res.body.result.isError).toBeUndefined();
    expect(JSON.parse(res.body.result.content[0].text)).toEqual({
      accepted: true,
      report: { summary: 'Login lives in auth/session.ts.', questions: ['May we add a dependency?'] },
    });
    const stored = await db.select().from(dispatchReports).where(eq(dispatchReports.dispatchId, ctx.run.dispatchId!));
    expect(stored.map((r) => r.report)).toEqual([
      { summary: 'Login lives in auth/session.ts.', questions: ['May we add a dependency?'] },
    ]);
    // Nothing reached the timeline.
    expect(await db.select().from(turns).where(eq(turns.taskId, ctx.task.id))).toEqual([]);
  });

  it('validates the same way for API agents, and refuses submit_result outside a building phase', async () => {
    const ctx = await heldExploreRun('Explore over API');
    const defs = buildControlPlaneToolDefs(ctx);
    const explore = defs.find((d) => d.name === 'submit_exploration')!;
    await expect(explore.execute({ questions: ['no summary'] })).rejects.toMatchObject({ code: 'invalid_report' });
    await expect(explore.execute({ summary: 'ok', extra: 1 })).rejects.toMatchObject({ code: 'invalid_report' });
    await expect(submitDispatchReport(ctx, 'submit_exploration', { summary: '   ' })).rejects.toMatchObject({
      code: 'invalid_report',
    });
    await expect(submitResult(ctx, 'Built it anyway.')).rejects.toMatchObject({ code: 'wrong_report_tool' });

    expect(JSON.parse(await explore.execute({ summary: 'Read the code.' }))).toEqual({
      accepted: true,
      report: { summary: 'Read the code.', questions: [] },
    });
    expect(await db.select().from(turns).where(eq(turns.taskId, ctx.task.id))).toEqual([]);
  });
});
