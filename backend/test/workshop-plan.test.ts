import { and, asc, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import {
  agents,
  dispatches,
  humanRequests,
  phaseTransitions,
  plans,
  runs,
  tasks,
  workPackages,
  type Agent,
  type Dispatch,
} from '../src/db/schema';
import { createApp } from '../src/http/app';
import { submitDispatchReport, submitResult, type RunToolContext } from '../src/modules/control-plane/tools';
import { setTaskHostFactoryForTests, type HostRequest } from '../src/modules/runs/task-run';
import { drainRunsForTests } from '../src/modules/runs/wake';
import { planDisputeKey } from '../src/modules/workshop/engine';
import { planHash } from '../src/modules/workshop/plans';
import { sampleReport } from './support/reports';
import { scriptedHost } from './support/scripted-host';

/**
 * Plan and plan review end to end: the lead's plan is recorded as a version,
 * reviewed by the others, revised once on objection, put to a person if
 * objections remain, or degraded to one package when the lead gives none;
 * the plan that goes ahead is pinned and its packages written.
 */
const app = createApp();
let token = '';

const auth = () => ({ Authorization: `Bearer ${token}` });

/** What a member does in plan and plan review, by name; explore and build always report. */
type Behavior = (turn: { dispatch: Dispatch; ctx: RunToolContext }) => Promise<string | void>;
const behaviors = new Map<string, Behavior>();

async function turnContext(req: HostRequest): Promise<{ dispatch: Dispatch; ctx: RunToolContext }> {
  const [run] = await db.select().from(runs).where(and(eq(runs.status, 'running'), eq(runs.agentId, req.agent.id)));
  const [dispatch] = await db.select().from(dispatches).where(eq(dispatches.id, run!.dispatchId!));
  const [agent] = await db.select().from(agents).where(eq(agents.id, req.agent.id));
  const [task] = await db.select().from(tasks).where(eq(tasks.id, run!.taskId!));
  return { dispatch: dispatch!, ctx: { run: run!, epoch: run!.ownerEpoch, agent: agent as Agent, task: task!, phase: dispatch!.phase } };
}

async function newWorkshop(prefix: string): Promise<{ taskId: string; names: string[]; ids: string[] }> {
  const names = ['A', 'B', 'C'].map((n) => `${prefix} ${n}`);
  const ids: string[] = [];
  for (const name of names) {
    const res = await request(app).post('/api/agents').set(auth()).send({ name, runtime: 'claude-code' });
    ids.push(res.body.agent.id);
  }
  const res = await request(app)
    .post('/api/tasks')
    .set(auth())
    .send({ title: `${prefix} task`, brief: 'Add rate limiting to login.', playbook: 'build', leadAgentId: ids[0], memberAgentIds: ids });
  return { taskId: res.body.task.id, names, ids };
}

const twoPackages = (names: string[], extra: Record<string, unknown> = {}) => ({
  summary: 'API first, then the UI.',
  packages: [
    { key: 'api', title: 'Limiter middleware', owner: names[0], area: 'src/auth', acceptance: ['429 past the limit'] },
    { key: 'ui', title: 'Lockout message', owner: names[1], area: 'web/login', dependsOn: ['api'], acceptance: ['Shows the wait'] },
  ],
  integration: 'The UI reads the 429 body.',
  verification: 'npm test',
  ...extra,
});

const approve = { verdict: 'approve' };
const object = (comments: string) => ({ verdict: 'object', comments });

const taskRow = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;
const plansOf = (taskId: string) => db.select().from(plans).where(eq(plans.taskId, taskId)).orderBy(asc(plans.version));
const packagesOf = (taskId: string) =>
  db.select().from(workPackages).where(eq(workPackages.taskId, taskId)).orderBy(asc(workPackages.key));
const reviewRounds = async (taskId: string) =>
  [...new Set((await db.select().from(dispatches).where(and(eq(dispatches.taskId, taskId), eq(dispatches.phase, 'plan_review')))).map((d) => d.round))];

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  setTaskHostFactoryForTests((req) =>
    scriptedHost(async () => {
      const turn = await turnContext(req);
      const { dispatch, ctx } = turn;
      if (dispatch.phase === 'explore') await submitDispatchReport(ctx, 'submit_exploration', sampleReport('submit_exploration', ctx));
      else if (dispatch.phase === 'build') await submitResult(ctx, 'Built.');
      else {
        const text = await behaviors.get(req.agent.name)?.(turn);
        return { text: text ?? 'Done.' };
      }
      return { text: 'Done.' };
    })(req)
  );
  const reg = await request(app).post('/auth/register').send({
    email: 'workshop-plan@example.com',
    username: 'workshopplan',
    password: 'a-strong-password',
  });
  token = reg.body.token;
});

afterEach(async () => {
  await drainRunsForTests();
  behaviors.clear();
});

afterAll(() => {
  setTaskHostFactoryForTests(null);
});

describe('plan and plan review', () => {
  it('pins a plan every reviewer approves and writes its packages', async () => {
    const { taskId, names, ids } = await newWorkshop('Once');
    behaviors.set(names[0]!, async ({ ctx }) => void (await submitDispatchReport(ctx, 'submit_plan', twoPackages(names))));
    behaviors.set(names[1]!, async ({ ctx }) => void (await submitDispatchReport(ctx, 'submit_plan_review', approve)));
    behaviors.set(names[2]!, async ({ ctx }) => void (await submitDispatchReport(ctx, 'submit_plan_review', approve)));
    await request(app).post(`/api/tasks/${taskId}/start`).set(auth());
    await drainRunsForTests();

    const [v1, ...more] = await plansOf(taskId);
    expect(more).toEqual([]);
    expect(v1).toMatchObject({ version: 1, source: 'lead', cycle: 0 });
    expect(v1!.hash).toBe(planHash(v1!.content as never));
    const task = await taskRow(taskId);
    expect(task).toMatchObject({ phase: 'build', planHash: v1!.hash });
    expect((await packagesOf(taskId)).map((p) => [p.key, p.ownerAgentId, p.dependsOn, p.planId, p.status])).toEqual([
      ['api', ids[0], [], v1!.id, 'pending'],
      ['ui', ids[1], ['api'], v1!.id, 'pending'],
    ]);
  });

  it('revises once on an objection and pins the revised plan', async () => {
    const { taskId, names, ids } = await newWorkshop('Revise');
    behaviors.set(names[0]!, async ({ ctx }) => {
      const revising = (await plansOf(taskId)).length > 0;
      const plan = revising
        ? twoPackages(names, {
            packages: [
              { key: 'api', title: 'Limiter middleware', owner: names[0], area: 'src/auth', acceptance: ['429'] },
              { key: 'store', title: 'Redis store', owner: names[2], area: 'src/store', acceptance: ['Counts survive restarts'] },
              { key: 'ui', title: 'Lockout message', owner: names[1], area: 'web/login', dependsOn: ['api'], acceptance: ['Wait shown'] },
            ],
          })
        : twoPackages(names);
      await submitDispatchReport(ctx, 'submit_plan', plan);
    });
    behaviors.set(names[1]!, async ({ ctx }) => {
      const first = (await plansOf(taskId)).length === 1;
      await submitDispatchReport(ctx, 'submit_plan_review', first ? object('Where do the counts live?') : approve);
    });
    behaviors.set(names[2]!, async ({ ctx }) => void (await submitDispatchReport(ctx, 'submit_plan_review', approve)));
    await request(app).post(`/api/tasks/${taskId}/start`).set(auth());
    await drainRunsForTests();

    const versions = await plansOf(taskId);
    expect(versions.map((p) => [p.version, p.source])).toEqual([
      [1, 'lead'],
      [2, 'lead'],
    ]);
    expect(await reviewRounds(taskId)).toHaveLength(2);
    expect((await taskRow(taskId)).planHash).toBe(versions[1]!.hash);
    expect((await packagesOf(taskId)).map((p) => [p.key, p.ownerAgentId, p.planId])).toEqual([
      ['api', ids[0], versions[1]!.id],
      ['store', ids[2], versions[1]!.id],
      ['ui', ids[1], versions[1]!.id],
    ]);
    const transitions = await db.select().from(phaseTransitions).where(eq(phaseTransitions.taskId, taskId));
    expect(transitions.map((t) => `${t.fromPhase}>${t.toPhase}`)).toEqual([
      'null>brief',
      'brief>explore',
      'explore>plan',
      'plan>plan_review',
      'plan_review>plan',
      'plan>plan_review',
      'plan_review>build',
    ]);
  });

  async function disputedWorkshop(prefix: string) {
    const workshop = await newWorkshop(prefix);
    const { names } = workshop;
    behaviors.set(names[0]!, async ({ ctx }) => void (await submitDispatchReport(ctx, 'submit_plan', twoPackages(names))));
    behaviors.set(names[1]!, async ({ ctx }) => void (await submitDispatchReport(ctx, 'submit_plan_review', object('Too coarse.'))));
    behaviors.set(names[2]!, async ({ ctx }) => void (await submitDispatchReport(ctx, 'submit_plan_review', approve)));
    await request(app).post(`/api/tasks/${workshop.taskId}/start`).set(auth());
    await drainRunsForTests();
    const [dispute] = await db
      .select()
      .from(humanRequests)
      .where(and(eq(humanRequests.taskId, workshop.taskId), eq(humanRequests.dedupeKey, planDisputeKey(0))));
    return { ...workshop, dispute: dispute! };
  }

  it('puts a plan still objected to after its revision to a person, and goes ahead when told to', async () => {
    const { taskId, dispute } = await disputedWorkshop('Proceed');
    const versions = await plansOf(taskId);
    expect(versions).toHaveLength(2);
    expect(dispute).toMatchObject({ kind: 'plan_dispute', status: 'open', choices: ['proceed', 'stop'], expiresAt: null });
    expect(dispute.payload).toMatchObject({ planId: versions[1]!.id, version: 2 });
    expect(await taskRow(taskId)).toMatchObject({ phase: 'plan_review', planHash: null });

    const answered = await request(app).post(`/api/human-requests/${dispute.id}/answer`).set(auth()).send({ choice: 'proceed' });
    expect(answered.status).toBe(200);
    await drainRunsForTests();
    expect(await taskRow(taskId)).toMatchObject({ phase: 'build', planHash: versions[1]!.hash });
    expect((await packagesOf(taskId)).map((p) => p.planId)).toEqual([versions[1]!.id, versions[1]!.id]);
  });

  it('stops the workshop when the person says stop', async () => {
    const { taskId, dispute } = await disputedWorkshop('Stop');
    await request(app).post(`/api/human-requests/${dispute.id}/answer`).set(auth()).send({ choice: 'stop' });
    await drainRunsForTests();
    expect(await taskRow(taskId)).toMatchObject({ phase: 'stopped', status: 'cancelled', planHash: null });
    expect(await packagesOf(taskId)).toEqual([]);
  });

  it('degrades to one package for the lead when the lead gives no plan, even asked again', async () => {
    const { taskId, names, ids } = await newWorkshop('Degrade');
    let refused = 0;
    behaviors.set(names[0]!, async ({ ctx }) => {
      // An invalid plan is refused; the lead then ends the turn without one.
      await submitDispatchReport(ctx, 'submit_plan', twoPackages(names, { packages: [{ key: 'x', title: 'X', owner: 'Nobody', area: 'a', acceptance: ['b'] }] })).catch(() => {
        refused += 1;
      });
      return 'I could not settle on a plan.';
    });
    behaviors.set(names[1]!, async ({ ctx }) => void (await submitDispatchReport(ctx, 'submit_plan_review', approve)));
    behaviors.set(names[2]!, async ({ ctx }) => void (await submitDispatchReport(ctx, 'submit_plan_review', approve)));
    await request(app).post(`/api/tasks/${taskId}/start`).set(auth());
    await drainRunsForTests();

    expect(refused).toBe(2);
    const leadPlans = (await db.select().from(dispatches).where(and(eq(dispatches.taskId, taskId), eq(dispatches.phase, 'plan')))).map((d) => [d.round, d.status]);
    expect(leadPlans).toEqual([
      [0, 'no_report'],
      [1, 'no_report'],
    ]);
    const [degraded] = await plansOf(taskId);
    expect(degraded).toMatchObject({ version: 1, source: 'degraded', dispatchId: null });
    expect(await db.select().from(humanRequests).where(eq(humanRequests.taskId, taskId))).toEqual([]);
    expect(await taskRow(taskId)).toMatchObject({ phase: 'build', planHash: degraded!.hash });
    const [only] = await packagesOf(taskId);
    expect(only).toMatchObject({ key: 'main', title: 'Degrade task', ownerAgentId: ids[0] });
    expect(only!.acceptance).toEqual(['The brief is met: Add rate limiting to login.']);
  });
});
