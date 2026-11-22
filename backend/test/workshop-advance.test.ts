import { and, asc, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import {
  dispatchReports,
  dispatches,
  humanRequests,
  phaseTransitions,
  repositories,
  runs,
  taskMembers,
  tasks,
  type Run,
} from '../src/db/schema';
import { createApp } from '../src/http/app';
import { LeaseKeeper } from '../src/modules/ownership/lease';
import { reconcileOnce } from '../src/modules/ownership/reconciler';
import { drainRunsForTests } from '../src/modules/runs/wake';
import { advanceTask, setWorkshopRunStarterForTests } from '../src/modules/workshop/advance';
import { memberFailedKey } from '../src/modules/workshop/engine';

/**
 * The advancing transaction against a real database. Runs the engine queues
 * are kept from starting, so each test sets dispatch outcomes by hand the
 * way the run-ending paths will.
 */
const app = createApp();
let token = '';
let userId = '';
let lead = '';
let peer = '';
let third = '';
let keeper: LeaseKeeper;
const started: Run[] = [];

const auth = () => ({ Authorization: `Bearer ${token}` });

async function newAgent(name: string): Promise<string> {
  const res = await request(app).post('/api/agents').set(auth()).send({ name, runtime: 'api' });
  return (res.body.agent ?? res.body).id;
}

async function newWorkshop(
  playbook: 'build' | 'solo' | 'legacy' = 'build',
  members = [lead, peer, third]
): Promise<string> {
  const res = await request(app)
    .post('/api/tasks')
    .set(auth())
    .send({ title: 'Two-step login', brief: 'Add TOTP.', playbook, leadAgentId: members[0], memberAgentIds: members });
  expect(res.status).toBe(201);
  return res.body.task.id;
}

const taskRow = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;
const dispatchRows = (taskId: string) =>
  db.select().from(dispatches).where(eq(dispatches.taskId, taskId)).orderBy(asc(dispatches.createdAt));
const transitions = async (taskId: string) =>
  (
    await db
      .select()
      .from(phaseTransitions)
      .where(eq(phaseTransitions.taskId, taskId))
      .orderBy(asc(phaseTransitions.createdAt))
  ).map((t) => `${t.fromPhase ?? '-'}>${t.toPhase}`);

/** Records a report and ends the dispatch, as the run-ending paths will. */
async function report(dispatchId: string, body: Record<string, unknown> = { ok: true }): Promise<void> {
  await db.insert(dispatchReports).values({ dispatchId, epoch: 1, tool: 'submit_exploration', report: body });
  await db.update(dispatches).set({ status: 'reported', endedAt: new Date() }).where(eq(dispatches.id, dispatchId));
}

async function flag(taskId: string): Promise<void> {
  await db.update(tasks).set({ advancePending: true }).where(eq(tasks.id, taskId));
}

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  setWorkshopRunStarterForTests(async (queued) => {
    started.push(...queued);
  });
  const reg = await request(app).post('/auth/register').send({
    email: 'advance@example.com',
    username: 'advance',
    password: 'a-strong-password',
  });
  token = reg.body.token;
  userId = reg.body.user.id;
  lead = await newAgent('Lead');
  peer = await newAgent('Peer');
  third = await newAgent('Third');
  keeper = new LeaseKeeper({ instance: 'workshop-advance-test' });
});

afterAll(async () => {
  await drainRunsForTests();
  setWorkshopRunStarterForTests(null);
  await keeper.stop();
});

beforeEach(() => {
  started.length = 0;
});

describe('starting a workshop', () => {
  it('refuses tasks that are not workshops, have the wrong roster, or name a repository that is not there', async () => {
    const legacy = await newWorkshop('legacy');
    expect((await request(app).post(`/api/tasks/${legacy}/start`).set(auth())).body).toMatchObject({
      code: 'not_a_workshop',
    });
    const lonely = await newWorkshop('build', [lead]);
    expect((await request(app).post(`/api/tasks/${lonely}/start`).set(auth())).body).toMatchObject({
      code: 'invalid_roster',
    });
    const crowdedSolo = await newWorkshop('solo', [lead, peer]);
    expect((await request(app).post(`/api/tasks/${crowdedSolo}/start`).set(auth())).body).toMatchObject({
      code: 'invalid_roster',
    });
    const [repo] = await db
      .insert(repositories)
      .values({ userId, name: 'r', rootPath: '/tmp/r', fingerprint: 'f' })
      .returning();
    const bound = await newWorkshop('build');
    await db.update(tasks).set({ repositoryId: repo!.id }).where(eq(tasks.id, bound));
    expect((await request(app).post(`/api/tasks/${bound}/start`).set(auth())).body).toMatchObject({
      code: 'not_a_repository',
    });
  });

  it('freezes the snapshot and sends every member to explore in one advance', async () => {
    const id = await newWorkshop();
    const res = await request(app).post(`/api/tasks/${id}/start`).set(auth());
    expect(res.status).toBe(202);
    expect(res.body.task).toMatchObject({ phase: 'explore', status: 'in_progress', parallelism: 3 });

    const task = await taskRow(id);
    expect(task.snapshot).toMatchObject({ roster: [lead, peer, third], leadAgentId: lead, brief: 'Add TOTP.' });
    expect(task.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(task.advancePending).toBe(false);
    expect(await transitions(id)).toEqual(['->brief', 'brief>explore']);

    const rows = await dispatchRows(id);
    expect(rows.map((d) => [d.phase, d.agentId, d.status, d.cycle, d.round])).toEqual([
      ['explore', lead, 'pending', 0, 0],
      ['explore', peer, 'pending', 0, 0],
      ['explore', third, 'pending', 0, 0],
    ]);
    const queued = await db.select().from(runs).where(eq(runs.taskId, id));
    expect(queued).toHaveLength(3);
    for (const run of queued) {
      // No repository, no worktrees: members share no gate and explore at the same time.
      expect(run).toMatchObject({ trigger: 'dispatch', status: 'queued', gateKey: null });
      expect(rows.map((d) => d.id)).toContain(run.dispatchId);
    }
    expect(started.map((r) => r.id).sort()).toEqual(queued.map((r) => r.id).sort());
  });

  it('refuses to start a workshop twice', async () => {
    const id = await newWorkshop();
    await request(app).post(`/api/tasks/${id}/start`).set(auth());
    expect((await request(app).post(`/api/tasks/${id}/start`).set(auth())).body).toMatchObject({
      code: 'workshop_started',
    });
  });
});

describe('advancing', () => {
  it('adds nothing when advanced again without news', async () => {
    const id = await newWorkshop();
    await request(app).post(`/api/tasks/${id}/start`).set(auth());
    const again = await advanceTask(id);
    expect(again.applied).toEqual([]);
    expect(await dispatchRows(id)).toHaveLength(3);
  });

  it('catches up on the reconciler pass when the process died between settling and advancing', async () => {
    const id = await newWorkshop();
    await request(app).post(`/api/tasks/${id}/start`).set(auth());
    for (const d of await dispatchRows(id)) await report(d.id);
    // The settling transaction committed with the flag set; the advance never ran.
    await flag(id);

    const result = await reconcileOnce(keeper);
    expect(result.advanced).toContain(id);
    const task = await taskRow(id);
    expect(task).toMatchObject({ phase: 'plan', advancePending: false });
    const plan = (await dispatchRows(id)).filter((d) => d.phase === 'plan');
    expect(plan.map((d) => d.agentId)).toEqual([lead]);
    expect(await transitions(id)).toEqual(['->brief', 'brief>explore', 'explore>plan']);
  });

  it('opens one member_failed request and follows the answer given through the API', async () => {
    const id = await newWorkshop();
    await request(app).post(`/api/tasks/${id}/start`).set(auth());
    const rows = await dispatchRows(id);
    const peerDispatch = rows.find((d) => d.agentId === peer)!;
    await db.update(dispatches).set({ status: 'failed' }).where(eq(dispatches.id, peerDispatch.id));
    await flag(id);
    await advanceTask(id);
    await flag(id);
    await advanceTask(id);

    const key = memberFailedKey('explore', 0, 0, peer);
    const open = await db.select().from(humanRequests).where(eq(humanRequests.taskId, id));
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ kind: 'member_failed', dedupeKey: key, status: 'open', choices: ['retry', 'skip', 'stop'] });

    for (const d of rows.filter((d) => d.agentId !== peer)) await report(d.id);
    const answer = await request(app)
      .post(`/api/human-requests/${open[0]!.id}/answer`)
      .set(auth())
      .send({ choice: 'skip' });
    expect(answer.status).toBe(200);

    const [member] = await db
      .select()
      .from(taskMembers)
      .where(and(eq(taskMembers.taskId, id), eq(taskMembers.agentId, peer)));
    expect(member!.state).toBe('skipped');
    expect((await taskRow(id)).phase).toBe('plan');
  });

  it('asks a person after three failed advances and stops when told to', async () => {
    const id = await newWorkshop();
    const [repo] = await db
      .insert(repositories)
      .values({ userId, name: 'broken', rootPath: '/tmp/broken', fingerprint: 'g' })
      .returning();
    // Brief on a repository without a frozen base commit cannot prepare worktrees: every advance fails.
    await db
      .update(tasks)
      .set({ phase: 'brief', repositoryId: repo!.id, advancePending: true })
      .where(eq(tasks.id, id));
    for (let i = 0; i < 3; i += 1) await advanceTask(id);

    const task = await taskRow(id);
    expect(task).toMatchObject({ advanceFailures: 3, advancePending: false });
    const [req] = await db.select().from(humanRequests).where(eq(humanRequests.taskId, id));
    expect(req).toMatchObject({ kind: 'engine_error', status: 'open', choices: ['retry', 'stop'] });
    expect(String(req!.payload.error)).toContain('needs its base commit');

    const res = await request(app).post(`/api/human-requests/${req!.id}/answer`).set(auth()).send({ choice: 'stop' });
    expect(res.status).toBe(200);
    expect(await taskRow(id)).toMatchObject({ phase: 'stopped', status: 'cancelled' });
  });

  it('retries after an engine_error answer of retry, counting failures from zero', async () => {
    const id = await newWorkshop();
    const [repo] = await db
      .insert(repositories)
      .values({ userId, name: 'broken-2', rootPath: '/tmp/broken-2', fingerprint: 'h' })
      .returning();
    await db
      .update(tasks)
      .set({ phase: 'brief', repositoryId: repo!.id, advancePending: true })
      .where(eq(tasks.id, id));
    for (let i = 0; i < 3; i += 1) await advanceTask(id);
    const [req] = await db.select().from(humanRequests).where(eq(humanRequests.taskId, id));
    await request(app).post(`/api/human-requests/${req!.id}/answer`).set(auth()).send({ choice: 'retry' });
    // The retry ran at once and failed again: one failure, still flagged for the reconciler.
    expect(await taskRow(id)).toMatchObject({ advanceFailures: 1, advancePending: true });
  });

  it('tells running dispatches to stop when a workshop is stopped', async () => {
    const id = await newWorkshop();
    await request(app).post(`/api/tasks/${id}/start`).set(auth());
    const [first] = await dispatchRows(id);
    await db.update(dispatches).set({ status: 'failed' }).where(eq(dispatches.id, first!.id));
    await flag(id);
    await advanceTask(id);
    const [req] = await db.select().from(humanRequests).where(eq(humanRequests.taskId, id));
    // The lead failed: retry or stop only.
    expect(req!.choices).toEqual(['retry', 'stop']);
    await request(app).post(`/api/human-requests/${req!.id}/answer`).set(auth()).send({ choice: 'stop' });

    expect(await taskRow(id)).toMatchObject({ phase: 'stopped', status: 'cancelled' });
    const rest = (await dispatchRows(id)).filter((d) => d.status === 'pending');
    expect(rest).toHaveLength(2);
    for (const d of rest) expect(d.cancelRequestedAt).not.toBeNull();
  });
});
