import path from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import { agents, dispatches, runs, tasks, turns, type Agent, type Dispatch } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { getTaskSnapshot, submitDispatchReport, type RunToolContext } from '../src/modules/control-plane/tools';
import { setTaskHostFactoryForTests, type HostRequest } from '../src/modules/runs/task-run';
import { drainRunsForTests } from '../src/modules/runs/wake';
import { setPlatformRetryBackoffForTests } from '../src/modules/workshop/platform-ops';
import { initFixtureRepo, makeSandbox, removeSandbox } from './fixtures/git-repo';
import { scriptedHost, type ScriptedReply, type ScriptedTurn } from './support/scripted-host';

/**
 * Explore: every member explores at once, each blind to the others. Nothing
 * one member writes during the phase, and no comment a person adds once it
 * has begun, reaches another member's prompt or get_task; a reply that is
 * not a report stays on its run instead of the timeline.
 */
const app = createApp();
const T = 90_000;
let token = '';
let repositoryId = '';
let sandbox = '';

const auth = () => ({ Authorization: `Bearer ${token}` });

/** What a scripted member sees and does on one turn. */
interface MemberTurn {
  turn: ScriptedTurn;
  dispatch: Dispatch;
  ctx: RunToolContext;
}
type Member = (t: MemberTurn) => Promise<ScriptedReply>;
const members = new Map<string, Member>();
/** Every prompt a member got outside explore, by `<agent>:<phase>:<round>`. */
const otherPrompts = new Map<string, string>();

async function turnContext(req: HostRequest): Promise<{ dispatch: Dispatch; ctx: RunToolContext }> {
  const [run] = await db.select().from(runs).where(and(eq(runs.status, 'running'), eq(runs.agentId, req.agent.id)));
  const [dispatch] = await db.select().from(dispatches).where(eq(dispatches.id, run!.dispatchId!));
  const [agent] = await db.select().from(agents).where(eq(agents.id, req.agent.id));
  const [task] = await db.select().from(tasks).where(eq(tasks.id, run!.taskId!));
  return { dispatch: dispatch!, ctx: { run: run!, epoch: run!.ownerEpoch, agent: agent as Agent, task: task!, phase: dispatch!.phase } };
}

async function newWorkshop(names: string[], options: { repository?: boolean; parallelism?: number } = {}) {
  const ids: string[] = [];
  for (const name of names) {
    const res = await request(app).post('/api/agents').set(auth()).send({ name, runtime: 'claude-code' });
    ids.push(res.body.agent.id);
  }
  const res = await request(app)
    .post('/api/tasks')
    .set(auth())
    .send({
      title: `Explore ${names[0]}`,
      brief: 'Add rate limiting to the login endpoint.',
      playbook: 'build',
      leadAgentId: ids[0],
      memberAgentIds: ids,
      ...(options.repository ? { repositoryId } : {}),
    });
  const taskId = res.body.task.id as string;
  if (options.parallelism) await db.update(tasks).set({ parallelism: options.parallelism }).where(eq(tasks.id, taskId));
  return { taskId, ids };
}

const exploreRuns = async (taskId: string) =>
  db
    .select({ run: runs, dispatch: dispatches })
    .from(runs)
    .innerJoin(dispatches, eq(dispatches.id, runs.dispatchId))
    .where(and(eq(dispatches.taskId, taskId), eq(dispatches.phase, 'explore')))
    .orderBy(asc(runs.startedAt));

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  setPlatformRetryBackoffForTests(0);
  setTaskHostFactoryForTests((req) =>
    scriptedHost(async (turn) => {
      const { dispatch, ctx } = await turnContext(req);
      const member = members.get(req.agent.name);
      if (!member || dispatch.phase !== 'explore') {
        otherPrompts.set(`${req.agent.name}:${dispatch.phase}:${dispatch.round}`, turn.prompt);
        return { text: `${req.agent.name} has nothing to add in ${dispatch.phase}.` };
      }
      return member({ turn, dispatch, ctx });
    })(req)
  );
  const reg = await request(app).post('/auth/register').send({
    email: 'workshop-explore@example.com',
    username: 'workshopexplore',
    password: 'a-strong-password',
  });
  token = reg.body.token;
  sandbox = makeSandbox('workshop-explore');
  const repoDir = await initFixtureRepo(path.join(sandbox, 'repo'));
  const repo = await request(app).post('/api/repositories').set(auth()).send({ rootPath: repoDir });
  repositoryId = repo.body.repository.id;
});

afterEach(async () => {
  await drainRunsForTests();
  members.clear();
  otherPrompts.clear();
});

afterAll(() => {
  setTaskHostFactoryForTests(null);
  setPlatformRetryBackoffForTests(null);
  removeSandbox(sandbox);
});

describe('explore', () => {
  it('has the members explore at the same time, each in their own worktree', { timeout: T }, async () => {
    const explore: Member = async ({ ctx }) => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      await submitDispatchReport(ctx, 'submit_exploration', { summary: `${ctx.agent.name} read the login handler.` });
      return { text: 'Reported.' };
    };
    members.set('Concurrent A', explore);
    members.set('Concurrent B', explore);
    const { taskId } = await newWorkshop(['Concurrent A', 'Concurrent B'], { repository: true });
    await request(app).post(`/api/tasks/${taskId}/start`).set(auth());
    await drainRunsForTests();

    const rows = await exploreRuns(taskId);
    expect(rows.map((r) => r.dispatch.status)).toEqual(['reported', 'reported']);
    expect(new Set(rows.map((r) => r.run.workspaceId)).size).toBe(2);
    const spans = rows.map((r) => ({ start: r.run.startedAt!.getTime(), end: r.run.finishedAt!.getTime() }));
    const wall = Math.max(...spans.map((s) => s.end)) - Math.min(...spans.map((s) => s.start));
    const total = spans.reduce((sum, s) => sum + (s.end - s.start), 0);
    expect(wall).toBeLessThan(total);
    expect(Math.max(...spans.map((s) => s.start))).toBeLessThan(Math.min(...spans.map((s) => s.end)));
  });

  it("keeps each member's exploration and mid-phase comments from the others", { timeout: T }, async () => {
    const prompts = new Map<string, string>();
    const views = new Map<string, string>();
    let taskId = '';
    members.set('Blind A', async ({ turn, dispatch, ctx }) => {
      if (dispatch.round === 0) {
        prompts.set('A0', turn.prompt);
        views.set('A0', JSON.stringify(await getTaskSnapshot(ctx)));
        await request(app).post(`/api/tasks/${taskId}/turns`).set(auth()).send({ content: 'MID-EXPLORE-NOTE from a person' });
        return { text: 'A-FALLBACK-SECRET: the limiter belongs in middleware.' };
      }
      prompts.set('A1', turn.prompt);
      await submitDispatchReport(ctx, 'submit_exploration', { summary: 'A-REPORT-SECRET: use a token bucket.' });
      return { text: 'Reported.' };
    });
    members.set('Blind B', async ({ turn, ctx }) => {
      prompts.set('B', turn.prompt);
      views.set('B', JSON.stringify(await getTaskSnapshot(ctx)));
      await submitDispatchReport(ctx, 'submit_exploration', { summary: 'B looked at the session store.' });
      return { text: 'Reported.' };
    });
    // One dispatch at a time: A's two rounds finish before B starts, so A's work exists when B's turn is built.
    ({ taskId } = await newWorkshop(['Blind A', 'Blind B'], { parallelism: 1 }));
    await request(app).post(`/api/tasks/${taskId}/turns`).set(auth()).send({ content: 'BEFORE-START-NOTE from a person' });
    await request(app).post(`/api/tasks/${taskId}/start`).set(auth());
    await drainRunsForTests();

    const rows = await exploreRuns(taskId);
    expect(rows.map((r) => [r.run.agentName, r.dispatch.round, r.dispatch.status])).toEqual([
      ['Blind A', 0, 'no_report'],
      ['Blind A', 1, 'reported'],
      ['Blind B', 0, 'reported'],
    ]);
    // Both on the database clock: B was dispatched only after A's report had ended A's dispatch.
    expect(rows[2]!.dispatch.createdAt.getTime()).toBeGreaterThanOrEqual(rows[1]!.dispatch.endedAt!.getTime());

    // The prompt and get_task of B: the brief and what was there before the phase, nothing of A's, no mid-phase comment.
    for (const seen of [prompts.get('B')!, views.get('B')!]) {
      expect(seen).toContain('Add rate limiting to the login endpoint.');
      expect(seen).toContain('BEFORE-START-NOTE');
      expect(seen).not.toContain('MID-EXPLORE-NOTE');
      expect(seen).not.toContain('A-FALLBACK-SECRET');
      expect(seen).not.toContain('A-REPORT-SECRET');
    }
    expect(JSON.parse(views.get('B')!).workshop).toMatchObject({
      phase: 'explore',
      role: 'member',
      reportTool: 'submit_exploration',
      members: ['Blind A', 'Blind B'],
    });
    expect(prompts.get('B')).toContain('submit_exploration');
    expect(prompts.get('B')).not.toContain('comment_on_task');

    // A's first round was dispatched in the transaction that began the phase; it still sees what came before.
    for (const seen of [prompts.get('A0')!, views.get('A0')!]) {
      expect(seen).toContain('BEFORE-START-NOTE');
      expect(seen).not.toContain('MID-EXPLORE-NOTE');
    }

    // A's text reply stayed on its run; asked again, A saw its own reply and nobody else's.
    const timeline = await db.select().from(turns).where(eq(turns.taskId, taskId));
    expect(timeline.map((t) => t.content).join('\n')).not.toContain('A-FALLBACK-SECRET');
    expect(rows[0]!.run.output).toContain('A-FALLBACK-SECRET');
    expect(prompts.get('A1')).toContain('A-FALLBACK-SECRET');
    expect(prompts.get('A1')).toContain('counts as no report');

    // Plan is not blind: the lead's reply lands on the timeline as before, and the comment is visible again.
    const planRuns = await db
      .select({ run: runs })
      .from(runs)
      .innerJoin(dispatches, eq(dispatches.id, runs.dispatchId))
      .where(and(eq(dispatches.taskId, taskId), eq(dispatches.phase, 'plan')));
    expect(planRuns.length).toBeGreaterThan(0);
    expect(timeline.map((t) => t.content)).toContain('Blind A has nothing to add in plan.');
    expect(otherPrompts.get('Blind A:plan:0')).toContain('MID-EXPLORE-NOTE');
  });
});

