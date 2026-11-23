import fs from 'node:fs';
import path from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import request from 'supertest';
import type { TurnPermission } from '@swarmdev/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import { agents, dispatches, humanRequests, platformOps, runs, tasks, workPackages, workspaces, type Agent } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { workspaceLeaf } from '../src/modules/code-workspaces/branch-name';
import { submitDispatchReport, submitResult } from '../src/modules/control-plane/tools';
import { setTaskHostFactoryForTests } from '../src/modules/runs/task-run';
import { drainRunsForTests } from '../src/modules/runs/wake';
import { advanceTask, stopWorkshopWithin } from '../src/modules/workshop/advance';
import { agentPhase } from '../src/modules/workshop/phases';
import { setPlatformRetryBackoffForTests } from '../src/modules/workshop/platform-ops';
import { storage } from '../src/storage/layout';
import { git, initFixtureRepo, makeSandbox, removeSandbox } from './fixtures/git-repo';
import { sampleReport } from './support/reports';
import { scriptedHost } from './support/scripted-host';

/**
 * A workshop on a repository: Brief prepares the integration worktree and
 * one worktree per member through platform runs, each member then works in
 * its own worktree, the built package is merged into the integration branch,
 * and the members' worktrees are removed once it ends.
 */
const app = createApp();
const T = 90_000;
let token = '';
let userId = '';
let repositoryId = '';
let repoDir = '';
let sandbox = '';
let base = '';
const turns: { agent: string; phase: string; workspace: string; permission: TurnPermission }[] = [];

const auth = () => ({ Authorization: `Bearer ${token}` });

async function newAgent(name: string): Promise<string> {
  const res = await request(app).post('/api/agents').set(auth()).send({ name, runtime: 'claude-code' });
  return res.body.agent.id;
}

async function newWorkshop(names: string[]): Promise<{ taskId: string; ids: string[] }> {
  const ids = [];
  for (const name of names) ids.push(await newAgent(name));
  const res = await request(app)
    .post('/api/tasks')
    .set(auth())
    .send({ title: `Worktrees ${names[0]}`, playbook: 'build', repositoryId, leadAgentId: ids[0], memberAgentIds: ids });
  return { taskId: res.body.task.id, ids };
}

const worktreesOf = (taskId: string) => db.select().from(workspaces).where(eq(workspaces.taskId, taskId));
const taskRow = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  setPlatformRetryBackoffForTests(0);
  setTaskHostFactoryForTests((req) =>
    scriptedHost(async (turn) => {
      const [run] = await db
        .select()
        .from(runs)
        .where(and(eq(runs.status, 'running'), eq(runs.agentId, req.agent.id)));
      const [dispatch] = await db.select().from(dispatches).where(eq(dispatches.id, run!.dispatchId!));
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.agent.id));
      const [task] = await db.select().from(tasks).where(eq(tasks.id, run!.taskId!));
      turns.push({ agent: agent!.name, phase: dispatch!.phase, workspace: turn.workspace, permission: turn.permission });
      const ctx = { run: run!, epoch: run!.ownerEpoch, agent: agent as Agent, task: task! };
      const tool = agentPhase(dispatch!.phase)!.reportTool;
      if (tool === 'submit_result') {
        fs.writeFileSync(path.join(turn.workspace, 'built.txt'), `${agent!.name} built ${dispatch!.packageKey}\n`);
        await submitResult(ctx, 'Built.');
      } else await submitDispatchReport(ctx, tool, sampleReport(tool, ctx));
      return { text: 'Done.' };
    })(req)
  );
  const reg = await request(app).post('/auth/register').send({
    email: 'workshop-worktrees@example.com',
    username: 'workshopworktrees',
    password: 'a-strong-password',
  });
  token = reg.body.token;
  userId = reg.body.user.id;
  sandbox = makeSandbox('workshop-worktrees');
  repoDir = await initFixtureRepo(path.join(sandbox, 'repo'));
  base = await git(repoDir, 'rev-parse', 'HEAD');
  const repo = await request(app).post('/api/repositories').set(auth()).send({ rootPath: repoDir });
  repositoryId = repo.body.repository.id;
});

afterEach(async () => {
  await drainRunsForTests();
  turns.length = 0;
});

afterAll(() => {
  setTaskHostFactoryForTests(null);
  setPlatformRetryBackoffForTests(null);
  removeSandbox(sandbox);
});

describe('a workshop on a repository', () => {
  it('prepares the worktrees in Brief, has each member work in their own, and merges the built package', { timeout: T }, async () => {
    const { taskId, ids } = await newWorkshop(['Wt Lead', 'Wt Peer']);
    const started = await request(app).post(`/api/tasks/${taskId}/start`).set(auth());
    expect(started.status).toBe(202);
    expect((await taskRow(taskId)).snapshot).toMatchObject({ baseCommit: base, baseRef: 'main' });
    await drainRunsForTests();

    const rows = await worktreesOf(taskId);
    const integration = rows.find((w) => w.kind === 'integration')!;
    const members = new Map(rows.filter((w) => w.kind === 'member').map((w) => [w.agentId, w]));
    expect(integration).toMatchObject({ status: 'ready', currentBranch: expect.stringMatching(/^loxo\/t\d+\/integration$/) });
    expect([...members.keys()].sort()).toEqual([...ids].sort());
    for (const member of members.values()) {
      expect(member).toMatchObject({ status: expect.stringMatching(/^(ready|dirty)$/), branchName: null, baseCommit: base });
      expect(fs.existsSync(member.worktreePath)).toBe(true);
    }
    const ops = await db.select().from(platformOps).where(eq(platformOps.taskId, taskId));
    expect(ops.filter((o) => o.kind === 'prepare_worktree').map((o) => o.status)).toEqual(['done', 'done', 'done']);

    // Every turn ran in the member's own worktree; only build may write.
    const lead = members.get(ids[0]!)!;
    const peer = members.get(ids[1]!)!;
    expect(turns.map((t) => `${t.phase}:${t.agent}`)).toEqual(
      expect.arrayContaining(['explore:Wt Lead', 'explore:Wt Peer', 'plan:Wt Lead', 'plan_review:Wt Peer', 'build:Wt Lead'])
    );
    for (const t of turns) {
      const own = t.agent === 'Wt Lead' ? lead : peer;
      expect(path.resolve(t.workspace)).toBe(path.resolve(own.worktreePath));
      expect(t.permission).toBe(t.phase === 'build' ? 'edit' : 'read_only');
    }
    const explore = await db.select().from(dispatches).where(and(eq(dispatches.taskId, taskId), eq(dispatches.phase, 'explore')));
    for (const d of explore) expect(d.workspaceId).toBe(members.get(d.agentId)!.id);
    const exploreRuns = await db.select().from(runs).where(and(eq(runs.taskId, taskId), eq(runs.trigger, 'dispatch')));
    for (const r of exploreRuns) expect(r.gateKey).toBe(`ws:${r.workspaceId}`);

    // The plan's one package: branched at base in the lead's worktree, built, checkpointed, merged.
    const task = await taskRow(taskId);
    const branch = `loxo/t${task.number}/p/main`;
    const [pkg] = await db.select().from(workPackages).where(eq(workPackages.taskId, taskId));
    expect(pkg).toMatchObject({ key: 'main', status: 'integrated', branch, startCommit: base });
    expect(await git(lead.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branch);
    expect(await git(lead.worktreePath, 'log', '-1', '--format=%an | %cn | %s', pkg!.headCommit!)).toBe(
      'Wt Lead via Loxo | Loxo | Package main: The whole task'
    );
    expect(await git(integration.worktreePath, 'rev-parse', 'HEAD^1', 'HEAD^2')).toBe(`${base}\n${pkg!.headCommit}`);
    expect(fs.readFileSync(path.join(integration.worktreePath, 'built.txt'), 'utf8')).toBe('Wt Lead built main\n');
    const packageOps = (await db.select().from(platformOps).where(eq(platformOps.taskId, taskId)).orderBy(asc(platformOps.createdAt))).filter(
      (o) => o.kind !== 'prepare_worktree'
    );
    expect(packageOps.map((o) => [o.kind, o.status, o.workspaceId])).toEqual([
      ['branch_package', 'done', lead.id],
      ['checkpoint', 'done', lead.id],
      ['integrate', 'done', integration.id],
    ]);
    expect(task.phase).toBe('check');
  });

  it("removes the members' worktrees once the workshop ends and keeps the integration worktree", { timeout: T }, async () => {
    const { taskId } = await newWorkshop(['End Lead', 'End Peer']);
    await request(app).post(`/api/tasks/${taskId}/start`).set(auth());
    await drainRunsForTests();
    await db.transaction(async (tx) => stopWorkshopWithin(tx, await taskRow(taskId), { reason: 'test' }));
    await advanceTask(taskId);
    await drainRunsForTests();

    const rows = await worktreesOf(taskId);
    for (const member of rows.filter((w) => w.kind === 'member')) {
      expect(member.status).toBe('abandoned');
      expect(fs.existsSync(member.worktreePath)).toBe(false);
    }
    const integration = rows.find((w) => w.kind === 'integration')!;
    expect(integration.status).toBe('ready');
    expect(fs.existsSync(integration.worktreePath)).toBe(true);
    // Advancing again finds the worktrees cleaned and asks for nothing more.
    expect((await advanceTask(taskId)).applied).toEqual([]);
  });

  it('waits in Brief with a request when a worktree cannot be prepared, and goes on after a retry', { timeout: T }, async () => {
    const { taskId, ids } = await newWorkshop(['Blocked Lead', 'Blocked Peer']);
    const blockedPath = path.join(storage.worktreesRoot(userId), workspaceLeaf(taskId, 'member', ids[1]!));
    fs.mkdirSync(blockedPath, { recursive: true });
    fs.writeFileSync(path.join(blockedPath, 'not-a-worktree.txt'), 'in the way\n');

    await request(app).post(`/api/tasks/${taskId}/start`).set(auth());
    await drainRunsForTests();
    expect((await taskRow(taskId)).phase).toBe('brief');
    const [req] = await db
      .select()
      .from(humanRequests)
      .where(and(eq(humanRequests.taskId, taskId), eq(humanRequests.kind, 'engine_error')));
    expect(req).toMatchObject({ status: 'open', payload: { operation: 'prepare_worktree', attempts: 3 } });

    fs.rmSync(blockedPath, { recursive: true, force: true });
    await request(app).post(`/api/human-requests/${req!.id}/answer`).set(auth()).send({ choice: 'retry' });
    await drainRunsForTests();
    expect((await taskRow(taskId)).phase).toBe('check');
  });
});
