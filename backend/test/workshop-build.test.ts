import fs from 'node:fs';
import path from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import { agents, dispatches, platformOps, runs, tasks, workPackages, workspaces, type Agent } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { submitDispatchReport, submitResult } from '../src/modules/control-plane/tools';
import { setTaskHostFactoryForTests } from '../src/modules/runs/task-run';
import { drainRunsForTests } from '../src/modules/runs/wake';
import { agentPhase } from '../src/modules/workshop/phases';
import { setPlatformRetryBackoffForTests } from '../src/modules/workshop/platform-ops';
import { git, initFixtureRepo, makeSandbox, removeSandbox } from './fixtures/git-repo';
import { scriptedHost } from './support/scripted-host';

/**
 * Build on a repository: each package is branched in its owner's worktree,
 * built there, checkpointed and merged into the integration branch. Packages
 * of different owners are built at the same time; a package that depends on
 * another starts from the integration head with that one merged in; an owner
 * builds their packages one at a time, in the order the plan lists them.
 */
const app = createApp();
const T = 120_000;
const BUILD_MS = 700;
let token = '';
let repositoryId = '';
let sandbox = '';
let repoDir = '';
let base = '';

/** The plan the lead of the next workshop submits. */
let planFor: () => Record<string, unknown> = () => ({});
/** What each build found when it started, by package key. */
const builds = new Map<string, { branch: string; files: string[]; prompt: string }>();

const auth = () => ({ Authorization: `Bearer ${token}` });

async function newWorkshop(names: string[]): Promise<{ taskId: string; ids: string[] }> {
  const ids: string[] = [];
  for (const name of names) {
    const res = await request(app).post('/api/agents').set(auth()).send({ name, runtime: 'claude-code' });
    ids.push(res.body.agent.id);
  }
  const res = await request(app)
    .post('/api/tasks')
    .set(auth())
    .send({ title: `Build ${names[0]}`, playbook: 'build', repositoryId, leadAgentId: ids[0], memberAgentIds: ids });
  return { taskId: res.body.task.id, ids };
}

const pkg = (key: string, owner: string, dependsOn: string[] = []) => ({
  key,
  title: `The ${key} package`,
  owner,
  area: key,
  dependsOn,
  acceptance: [`${key}.txt exists`],
});

const taskRow = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;
const packagesOf = async (taskId: string) =>
  new Map((await db.select().from(workPackages).where(eq(workPackages.taskId, taskId))).map((p) => [p.key, p]));
const integrationOf = async (taskId: string) =>
  (await db.select().from(workspaces).where(and(eq(workspaces.taskId, taskId), eq(workspaces.kind, 'integration'))))[0]!;

/** Each build dispatch's run span, by package key. */
async function buildSpans(taskId: string): Promise<Map<string, { start: number; end: number; workspaceId: string | null }>> {
  const rows = await db
    .select({ key: dispatches.packageKey, run: runs })
    .from(runs)
    .innerJoin(dispatches, eq(dispatches.id, runs.dispatchId))
    .where(and(eq(runs.taskId, taskId), eq(dispatches.phase, 'build')));
  return new Map(
    rows.map((r) => [r.key, { start: r.run.startedAt!.getTime(), end: r.run.finishedAt!.getTime(), workspaceId: r.run.workspaceId }])
  );
}

/**
 * Each package operation by key: when the engine asked for it, and its run's span. The worktree gate does
 * not keep a waiting run ahead of one started right after an advance, so order is read off the requests.
 */
async function opSpans(taskId: string): Promise<Map<string, { kind: string; requested: number; start: number; end: number }>> {
  const rows = await db
    .select({ op: platformOps, run: runs })
    .from(runs)
    .innerJoin(platformOps, eq(platformOps.id, runs.opId))
    .where(eq(platformOps.taskId, taskId))
    .orderBy(asc(runs.createdAt));
  return new Map(
    rows.map((r) => [
      r.op.opKey,
      { kind: r.op.kind, requested: r.op.createdAt.getTime(), start: r.run.startedAt!.getTime(), end: r.run.finishedAt!.getTime() },
    ])
  );
}

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  setPlatformRetryBackoffForTests(0);
  setTaskHostFactoryForTests((req) =>
    scriptedHost(async (turn) => {
      const [run] = await db.select().from(runs).where(and(eq(runs.status, 'running'), eq(runs.agentId, req.agent.id)));
      const [dispatch] = await db.select().from(dispatches).where(eq(dispatches.id, run!.dispatchId!));
      const [agent] = await db.select().from(agents).where(eq(agents.id, req.agent.id));
      const [task] = await db.select().from(tasks).where(eq(tasks.id, run!.taskId!));
      const ctx = { run: run!, epoch: run!.ownerEpoch, agent: agent as Agent, task: task!, phase: dispatch!.phase };
      const tool = agentPhase(dispatch!.phase)!.reportTool;
      if (tool === 'submit_result') {
        const key = dispatch!.packageKey;
        const files = fs.readdirSync(turn.workspace).filter((f) => f !== '.git').sort();
        builds.set(key, { branch: await git(turn.workspace, 'rev-parse', '--abbrev-ref', 'HEAD'), files, prompt: turn.prompt });
        await new Promise((resolve) => setTimeout(resolve, BUILD_MS));
        fs.writeFileSync(path.join(turn.workspace, `${key}.txt`), `${agent!.name} built ${key}\n`);
        await submitResult(ctx, `Built ${key}.`);
      } else if (tool === 'submit_plan') {
        await submitDispatchReport(ctx, tool, planFor());
      } else if (tool === 'submit_plan_review') {
        await submitDispatchReport(ctx, tool, { verdict: 'approve' });
      } else {
        await submitDispatchReport(ctx, tool, { summary: 'Looked.' });
      }
      return { text: 'Done.' };
    })(req)
  );
  const reg = await request(app).post('/auth/register').send({
    email: 'workshop-build@example.com',
    username: 'workshopbuild',
    password: 'a-strong-password',
  });
  token = reg.body.token;
  sandbox = makeSandbox('workshop-build');
  repoDir = await initFixtureRepo(path.join(sandbox, 'repo'), { 'README.md': '# build\n' });
  base = await git(repoDir, 'rev-parse', 'HEAD');
  const repo = await request(app).post('/api/repositories').set(auth()).send({ rootPath: repoDir });
  repositoryId = repo.body.repository.id;
});

afterEach(async () => {
  await drainRunsForTests();
  builds.clear();
});

afterAll(() => {
  setTaskHostFactoryForTests(null);
  setPlatformRetryBackoffForTests(null);
  removeSandbox(sandbox);
});

describe('build on a repository', () => {
  it('builds packages of different owners at the same time, each on its own branch from base, and merges both', { timeout: T }, async () => {
    planFor = () => ({
      summary: 'Two independent packages.',
      packages: [pkg('api', 'Par Lead'), pkg('ui', 'Par Peer')],
      integration: 'Independent.',
      verification: 'Look.',
    });
    const { taskId, ids } = await newWorkshop(['Par Lead', 'Par Peer']);
    await request(app).post(`/api/tasks/${taskId}/start`).set(auth());
    await drainRunsForTests();

    const task = await taskRow(taskId);
    expect(task.phase).toBe('check');
    const spans = await buildSpans(taskId);
    const api = spans.get('api')!;
    const ui = spans.get('ui')!;
    expect(Math.max(api.start, ui.start)).toBeLessThan(Math.min(api.end, ui.end));
    const members = await db.select().from(workspaces).where(and(eq(workspaces.taskId, taskId), eq(workspaces.kind, 'member')));
    const worktreeOf = (agentId: string) => members.find((w) => w.agentId === agentId)!.id;
    expect(api.workspaceId).toBe(worktreeOf(ids[0]!));
    expect(ui.workspaceId).toBe(worktreeOf(ids[1]!));
    // Each started on its own branch at base, without the other's work.
    for (const key of ['api', 'ui']) {
      expect(builds.get(key)).toMatchObject({ branch: `loxo/t${task.number}/p/${key}`, files: ['README.md'] });
      expect(builds.get(key)!.prompt).toContain(`Your worktree is on branch loxo/t${task.number}/p/${key}.`);
      expect(builds.get(key)!.prompt).toContain('It depends on no other package.');
    }
    const packages = await packagesOf(taskId);
    for (const key of ['api', 'ui']) expect(packages.get(key)).toMatchObject({ status: 'integrated', startCommit: base });

    const integration = await integrationOf(taskId);
    expect(await git(integration.worktreePath, 'ls-files')).toBe('README.md\napi.txt\nui.txt');
    const merges = (await git(integration.worktreePath, 'log', '--merges', '--format=%s', `${base}..HEAD`)).split('\n');
    expect(merges.sort()).toEqual(['Integrate package api: The api package', 'Integrate package ui: The ui package']);
    expect(await git(integration.worktreePath, 'status', '--porcelain')).toBe('');
  });

  it('starts a dependent package from the integration head, with what it depends on already in its worktree', { timeout: T }, async () => {
    planFor = () => ({
      summary: 'ui after api.',
      packages: [pkg('api', 'Dep Lead'), pkg('ui', 'Dep Peer', ['api'])],
      integration: 'ui reads api.',
      verification: 'Look.',
    });
    const { taskId } = await newWorkshop(['Dep Lead', 'Dep Peer']);
    await request(app).post(`/api/tasks/${taskId}/start`).set(auth());
    await drainRunsForTests();

    const task = await taskRow(taskId);
    expect(task.phase).toBe('check');
    const packages = await packagesOf(taskId);
    const api = packages.get('api')!;
    const ui = packages.get('ui')!;
    // ui starts from the merge of api into the integration branch.
    expect(await git(repoDir, 'rev-parse', `${ui.startCommit}^1`, `${ui.startCommit}^2`)).toBe(`${base}\n${api.headCommit}`);
    expect(builds.get('ui')).toMatchObject({ branch: `loxo/t${task.number}/p/ui`, files: ['README.md', 'api.txt'] });
    expect(builds.get('ui')!.prompt).toContain('It builds on api, already merged into the commit your branch starts from.');
    const ops = await opSpans(taskId);
    expect(ops.get('branch_package:0:0:ui')!.requested).toBeGreaterThanOrEqual(ops.get('integrate:0:0:api')!.end);

    const integration = await integrationOf(taskId);
    expect(await git(integration.worktreePath, 'ls-files')).toBe('README.md\napi.txt\nui.txt');
    expect(await git(integration.worktreePath, 'rev-parse', 'HEAD^1', 'HEAD^2')).toBe(`${ui.startCommit}\n${ui.headCommit}`);
  });

  it('gives one owner their packages one at a time, in the order the plan lists them', { timeout: T }, async () => {
    planFor = () => ({
      summary: 'Two packages for the lead, listed out of key order.',
      packages: [pkg('zeta', 'One Lead'), pkg('alpha', 'One Lead')],
      integration: 'Independent.',
      verification: 'Look.',
    });
    const { taskId } = await newWorkshop(['One Lead', 'One Peer']);
    await request(app).post(`/api/tasks/${taskId}/start`).set(auth());
    await drainRunsForTests();

    const task = await taskRow(taskId);
    expect(task.phase).toBe('check');
    const spans = await buildSpans(taskId);
    expect(spans.get('zeta')!.end).toBeLessThanOrEqual(spans.get('alpha')!.start);
    const ops = await opSpans(taskId);
    // alpha's branch is asked for only once zeta's work is committed, and from base: zeta's file is not in it.
    expect(ops.get('branch_package:0:0:alpha')!.requested).toBeGreaterThanOrEqual(ops.get('checkpoint:0:0:zeta')!.end);
    expect(builds.get('alpha')).toMatchObject({ branch: `loxo/t${task.number}/p/alpha`, files: ['README.md'] });
    const packages = await packagesOf(taskId);
    expect(packages.get('alpha')).toMatchObject({ status: 'integrated', startCommit: base });
    expect(packages.get('zeta')).toMatchObject({ status: 'integrated', startCommit: base });
    const integration = await integrationOf(taskId);
    expect(await git(integration.worktreePath, 'ls-files')).toBe('README.md\nalpha.txt\nzeta.txt');
  });
});
