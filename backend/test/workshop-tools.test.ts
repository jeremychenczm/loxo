import { and, asc, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import { agents, dispatchReports, dispatches, runs, taskMembers, tasks, turns, type Agent, type WorkshopPhase } from '../src/db/schema';
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
import { parseReport } from '../src/modules/workshop/reports';

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
    expect(toolsForRun(run, 'plan')).toEqual(['get_task', 'comment_on_task', 'ask_blocker', 'submit_plan']);
    expect(toolsForRun(run, 'plan_review')).toEqual(['get_task', 'submit_plan_review']);
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

describe('submit_plan', () => {
  const members = { members: [{ agentId: 'id-ada', name: 'Ada' }, { agentId: 'id-bo', name: 'Bo' }] };
  const pkg = (key: string, owner: string, dependsOn?: string[]) => ({
    key,
    title: `Package ${key}`,
    owner,
    area: `src/${key}`,
    ...(dependsOn ? { dependsOn } : {}),
    acceptance: [`${key} works`],
  });
  const plan = (packages: unknown[]) => ({ summary: 'Split it in two.', packages, integration: 'api first', verification: 'npm test' });
  const refused = (input: Record<string, unknown>) => {
    try {
      parseReport('submit_plan', input, members);
    } catch (error) {
      return error as { code: string; message: string };
    }
    throw new Error('the plan was accepted');
  };

  it('stores owners by agent id, matching member names without regard to case', () => {
    expect(parseReport('submit_plan', plan([pkg('api', 'ada'), pkg('ui', 'Bo', ['api'])]), members)).toEqual({
      summary: 'Split it in two.',
      packages: [
        { key: 'api', title: 'Package api', owner: 'id-ada', area: 'src/api', dependsOn: [], acceptance: ['api works'] },
        { key: 'ui', title: 'Package ui', owner: 'id-bo', area: 'src/ui', dependsOn: ['api'], acceptance: ['ui works'] },
      ],
      integration: 'api first',
      verification: 'npm test',
    });
  });

  it('refuses a plan that breaks the structure rules, naming every problem', () => {
    const problems = refused(
      plan([pkg('api', 'Ada', ['api']), pkg('api', 'Carol'), pkg('ui', 'Bo', ['db', 'jobs']), pkg('jobs', 'Bo', ['ui'])])
    );
    expect(problems.code).toBe('invalid_plan');
    expect(problems.message).toContain('"api" is used twice');
    expect(problems.message).toContain('owner "Carol" is not a member; use one of Ada, Bo');
    expect(problems.message).toContain('"api" depends on itself');
    expect(problems.message).toContain('"ui" depends on "db", which is not in the plan');
    expect(problems.message).toMatch(/cycle: (ui -> jobs -> ui|jobs -> ui -> jobs)/);
  });

  it('refuses a plan of the wrong shape', () => {
    const nine = Array.from({ length: 9 }, (_, i) => pkg(`p${i}`, 'Ada'));
    expect(refused(plan(nine))).toMatchObject({ code: 'invalid_report' });
    expect(refused(plan([]))).toMatchObject({ code: 'invalid_report' });
    expect(refused(plan([{ ...pkg('api', 'Ada'), acceptance: [] }]))).toMatchObject({ code: 'invalid_report' });
    expect(refused(plan([pkg('Not A Key', 'Ada')]))).toMatchObject({ code: 'invalid_report' });
    expect(refused({ ...plan([pkg('api', 'Ada')]), verification: '' })).toMatchObject({ code: 'invalid_report' });
  });

  it('accepts a plan over MCP against the members still taking part', async () => {
    const ctx = await heldExploreRun('Plan over MCP');
    await db.update(dispatches).set({ phase: 'plan', purpose: 'plan' }).where(eq(dispatches.id, ctx.run.dispatchId!));
    const [peer] = await db.select().from(agents).where(eq(agents.name, 'Plan over MCP peer'));
    const call = (args: Record<string, unknown>) => mcp(ctx, 'tools/call', { name: 'submit_plan', arguments: args });

    const wrongOwner = await call(plan([pkg('api', 'Nobody')]));
    expect(wrongOwner.body.result.isError).toBe(true);
    expect(wrongOwner.body.result.content[0].text).toMatch(/^invalid_plan: .*not a member; use one of Plan over MCP lead, Plan over MCP peer$/);

    // A skipped member cannot own a package.
    const skipped = and(eq(taskMembers.taskId, ctx.task.id), eq(taskMembers.agentId, peer!.id));
    await db.update(taskMembers).set({ state: 'skipped' }).where(skipped);
    const toSkipped = await call(plan([pkg('ui', 'Plan over MCP peer')]));
    expect(toSkipped.body.result.content[0].text).toMatch(/owner "Plan over MCP peer" is not a member; use one of Plan over MCP lead$/);
    await db.update(taskMembers).set({ state: 'active' }).where(skipped);

    const accepted = await call(plan([pkg('api', 'Plan over MCP lead'), pkg('ui', 'plan over mcp peer', ['api'])]));
    expect(accepted.body.result.isError).toBeUndefined();
    const [stored] = await db.select().from(dispatchReports).where(eq(dispatchReports.dispatchId, ctx.run.dispatchId!));
    expect((stored!.report.packages as { owner: string }[]).map((p) => p.owner)).toEqual([ctx.agent.id, peer!.id]);
  });
});

describe('submit_plan_review', () => {
  it('needs comments to object, and none to approve', () => {
    expect(() => parseReport('submit_plan_review', { verdict: 'object' })).toThrow(/an objection needs comments/);
    expect(() => parseReport('submit_plan_review', { verdict: 'object', comments: '   ' })).toThrow(/an objection needs comments/);
    expect(() => parseReport('submit_plan_review', { verdict: 'maybe' })).toThrow();
    expect(parseReport('submit_plan_review', { verdict: 'approve' })).toEqual({ verdict: 'approve', comments: '' });
    expect(parseReport('submit_plan_review', { verdict: 'object', comments: 'Split the UI.' })).toEqual({
      verdict: 'object',
      comments: 'Split the UI.',
    });
  });
});
