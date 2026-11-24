import fs from 'node:fs';
import path from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import { agents, dispatches, integrations, runs, tasks, workPackages, workspaces, type Agent } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { getTaskSnapshot, submitDispatchReport, submitResult } from '../src/modules/control-plane/tools';
import { setTaskHostFactoryForTests } from '../src/modules/runs/task-run';
import { drainRunsForTests } from '../src/modules/runs/wake';
import { agentPhase } from '../src/modules/workshop/phases';
import { setPlatformRetryBackoffForTests } from '../src/modules/workshop/platform-ops';
import { git, initFixtureRepo, makeSandbox, removeSandbox } from './fixtures/git-repo';
import { scriptedHost } from './support/scripted-host';

/**
 * Two packages built at the same time change the same line. The first in is
 * merged; the second conflicts, so its owner merges the integration head
 * into the package branch and resolves it there, the platform commits the
 * resolution with both parents, and the package then merges cleanly.
 */
const app = createApp();
const T = 120_000;
let token = '';
let repositoryId = '';
let sandbox = '';
let base = '';

/** What each resolve found when it started, by package key: the worktree, the prompt, get_task, and a report sent too early. */
const resolves = new Map<
  string,
  { branch: string; shared: string; prompt: string; snapshot: Record<string, unknown>; early: { code?: string; message?: string } }
>();
/** Each build's prompt, by package key. */
const buildPrompts = new Map<string, string>();

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
    .send({ title: `Conflict ${names[0]}`, playbook: 'build', repositoryId, leadAgentId: ids[0], memberAgentIds: ids });
  return { taskId: res.body.task.id, ids };
}

const pkg = (key: string, owner: string) => ({
  key,
  title: `The ${key} package`,
  owner,
  area: 'shared.txt',
  dependsOn: [],
  acceptance: [`shared.txt names ${key}`],
});

let names: [string, string] = ['', ''];

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
      const shared = path.join(turn.workspace, 'shared.txt');
      if (dispatch!.purpose === 'resolve') {
        const found = {
          branch: await git(turn.workspace, 'rev-parse', '--abbrev-ref', 'HEAD'),
          shared: fs.readFileSync(shared, 'utf8'),
          prompt: turn.prompt,
          snapshot: (await getTaskSnapshot(ctx)) as unknown as Record<string, unknown>,
          early: {} as { code?: string; message?: string },
        };
        // Reporting with the markers still in the file is refused, and the turn goes on.
        await submitResult(ctx, 'Done too soon.').catch((err: { code?: string; message?: string }) => {
          found.early = { code: err.code, message: err.message };
        });
        resolves.set(dispatch!.packageKey, found);
        fs.writeFileSync(shared, 'api and ui\n');
        await submitResult(ctx, 'Kept both changes.');
      } else if (tool === 'submit_result') {
        buildPrompts.set(dispatch!.packageKey, turn.prompt);
        // Long enough that both builds run at the same time, from base.
        await new Promise((resolve) => setTimeout(resolve, 500));
        fs.writeFileSync(shared, `${dispatch!.packageKey}\n`);
        fs.writeFileSync(path.join(turn.workspace, `${dispatch!.packageKey}.txt`), 'own file\n');
        await submitResult(ctx, `Built ${dispatch!.packageKey}.`);
      } else if (tool === 'submit_plan') {
        await submitDispatchReport(ctx, tool, {
          summary: 'Two packages on the same line.',
          packages: [pkg('api', names[0]), pkg('ui', names[1])],
          integration: 'They collide.',
          verification: 'Look.',
        });
      } else if (tool === 'submit_plan_review') {
        await submitDispatchReport(ctx, tool, { verdict: 'approve' });
      } else {
        await submitDispatchReport(ctx, tool, { summary: 'Looked.' });
      }
      return { text: 'Done.' };
    })(req)
  );
  const reg = await request(app).post('/auth/register').send({
    email: 'workshop-conflicts@example.com',
    username: 'workshopconflicts',
    password: 'a-strong-password',
  });
  token = reg.body.token;
  sandbox = makeSandbox('workshop-conflicts');
  const repoDir = await initFixtureRepo(path.join(sandbox, 'repo'), { 'README.md': '# conflicts\n', 'shared.txt': 'base\n' });
  base = await git(repoDir, 'rev-parse', 'HEAD');
  const repo = await request(app).post('/api/repositories').set(auth()).send({ rootPath: repoDir });
  repositoryId = repo.body.repository.id;
});

afterEach(async () => {
  await drainRunsForTests();
  resolves.clear();
  buildPrompts.clear();
});

afterAll(() => {
  setTaskHostFactoryForTests(null);
  setPlatformRetryBackoffForTests(null);
  removeSandbox(sandbox);
});

describe('conflicting packages', () => {
  it('has the owner of the package that conflicts resolve it on its branch, then merges it cleanly', { timeout: T }, async () => {
    names = ['Clash Lead', 'Clash Peer'];
    const { taskId, ids } = await newWorkshop(names);
    await request(app).post(`/api/tasks/${taskId}/start`).set(auth());
    await drainRunsForTests();

    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(task!.phase).toBe('check');
    const rows = await db.select().from(integrations).where(eq(integrations.taskId, taskId)).orderBy(asc(integrations.createdAt));
    expect(rows.map((r) => r.outcome)).toEqual(['merged', 'conflicted', 'merged']);
    const [first, clash, after] = rows;
    // Whichever package went in first, the other is the one that conflicted, with that merge.
    expect(clash!.packageKey).not.toBe(first!.packageKey);
    expect(after!.packageKey).toBe(clash!.packageKey);
    expect(clash).toMatchObject({ ontoCommit: first!.mergeCommit, conflictFiles: ['shared.txt'], mergeCommit: null });

    const key = clash!.packageKey;
    const owner = ids[key === 'api' ? 0 : 1]!;
    const packages = new Map((await db.select().from(workPackages).where(eq(workPackages.taskId, taskId))).map((p) => [p.key, p]));
    const resolved = packages.get(key)!;
    expect(resolved).toMatchObject({ status: 'integrated', resolves: 1, resolveOnto: first!.mergeCommit, startCommit: base });

    // The owner resolved on the package branch, in their own worktree, with the conflict in front of them.
    const [resolveDispatch] = await db
      .select()
      .from(dispatches)
      .where(and(eq(dispatches.taskId, taskId), eq(dispatches.purpose, 'resolve')));
    const [member] = await db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.taskId, taskId), eq(workspaces.kind, 'member'), eq(workspaces.agentId, owner)));
    expect(resolveDispatch).toMatchObject({ phase: 'build', packageKey: key, agentId: owner, workspaceId: member!.id, status: 'reported' });
    const seen = resolves.get(key)!;
    expect(seen.branch).toBe(`loxo/t${task!.number}/p/${key}`);
    expect(seen.shared).toMatch(/^<<<<<<< [^\n]*\n[a-z]+\n=======\n[a-z]+\n>>>>>>> /);
    // Reporting before the markers were gone was refused, naming the file.
    expect(seen.early).toMatchObject({ code: 'unresolved_conflicts' });
    expect(seen.early.message).toContain('Conflict markers remain in shared.txt');

    // The resolve is told what it is for, which files conflict, and what is on the other side.
    const other = first!.packageKey;
    const otherOwner = names[other === 'api' ? 0 : 1];
    expect(seen.prompt).toContain('Current phase: build, resolving a conflict.');
    expect(seen.prompt).toContain('Build phase: resolve a conflict.');
    expect(seen.prompt).toContain(`Integration commit merged into your branch: ${first!.mergeCommit}`);
    expect(seen.prompt).toContain('Files in conflict: shared.txt');
    expect(seen.prompt).toContain(`- ${other}: The ${other} package (owner ${otherOwner}; area shared.txt)`);
    expect(seen.prompt).toContain(`Your package: ${key}: The ${key} package`);
    const workshop = seen.snapshot.workshop as { purpose: string; phase: string; materials: Record<string, unknown> };
    expect(workshop).toMatchObject({ phase: 'build', purpose: 'resolve' });
    expect(workshop.materials.conflict).toEqual({
      files: ['shared.txt'],
      onto: first!.mergeCommit,
      merged: [{ key: other, title: `The ${other} package`, owner: otherOwner, area: 'shared.txt' }],
    });
    // Builds carry no conflict.
    for (const prompt of buildPrompts.values()) {
      expect(prompt).toContain('Current phase: build.');
      expect(prompt).not.toContain('resolving a conflict');
      expect(prompt).not.toContain('Files in conflict');
    }

    // The resolution is a merge of the package's own commit and the head it conflicted with.
    expect(await git(member!.worktreePath, 'rev-parse', `${resolved.headCommit}^1`, `${resolved.headCommit}^2`)).toBe(
      `${clash!.packageHead}\n${first!.mergeCommit}`
    );
    expect(await git(member!.worktreePath, 'log', '-1', '--format=%an | %cn', resolved.headCommit!)).toBe(
      `${names[key === 'api' ? 0 : 1]} via Loxo | Loxo`
    );
    const [integration] = await db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.taskId, taskId), eq(workspaces.kind, 'integration')));
    const cwd = integration!.worktreePath;
    expect(await git(cwd, 'rev-parse', 'HEAD^1', 'HEAD^2')).toBe(`${first!.mergeCommit}\n${resolved.headCommit}`);
    expect(await git(cwd, 'show', 'HEAD:shared.txt')).toBe('api and ui');
    expect(await git(cwd, 'ls-files')).toBe('README.md\napi.txt\nshared.txt\nui.txt');
    expect(await git(cwd, 'status', '--porcelain')).toBe('');
  });
});
