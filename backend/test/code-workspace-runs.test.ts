import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import { agents, taskComments, runChangeSnapshots, runs } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { createReview } from '../src/modules/tasks/reviews.service';
import { setTaskTurnExecutorForTests } from '../src/modules/runs/task-run';
import { drainRunsForTests, requestWake } from '../src/modules/runs/wake';
import type { TurnRequest, TurnResult } from '../src/modules/runner/runner';
import { storage } from '../src/storage/layout';

const execFileAsync = promisify(execFile);
const app = createApp();
const T = 30_000;

let token = '';
let userId = '';
let workerId = '';
let inspectorId = '';
let projectId = '';

interface SeenTurn {
  workspace: string;
  permission: TurnRequest['permission'];
  trigger: string;
}
const seen: SeenTurn[] = [];
let onTurn: (req: TurnRequest) => void = () => {};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true });
  return stdout.trim();
}

async function initProjectRepo(): Promise<string> {
  const dir = storage.projectWorkspace(userId, projectId);
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'config', 'user.email', 'fixture@swarmdev.test');
  await git(dir, 'config', 'user.name', 'SwarmDev Fixture');
  await git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'README.md'), '# project\n');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'initial');
  return dir;
}

const auth = () => ({ Authorization: `Bearer ${token}` });

async function createTaskIn(title: string): Promise<{ id: string; number: number }> {
  const res = await request(app).post('/api/tasks').set(auth()).send({ title, projectId });
  expect(res.status).toBe(201);
  return res.body.task;
}

async function wake(agentId: string, taskId: string, trigger: 'manual' | 'review') {
  await requestWake(userId, { agentId, taskId, trigger });
  await drainRunsForTests();
}

async function workspaceOf(taskId: string) {
  const res = await request(app).get(`/api/tasks/${taskId}/workspace`).set(auth());
  expect(res.status).toBe(200);
  return res.body.workspace as {
    id: string;
    status: string;
    branchName: string;
    worktreePath: string;
    baseCommit: string;
  } | null;
}

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  setTaskTurnExecutorForTests(async (req) => {
    seen.push({
      workspace: req.workspace,
      permission: req.permission,
      trigger: req.prompt.includes('REVIEWER') ? 'review' : 'work',
    });
    onTurn(req);
    return { text: 'stub output', durationMs: 5 } satisfies TurnResult;
  });

  const reg = await request(app).post('/auth/register').send({
    email: 'codews@example.com',
    username: 'codewsuser',
    password: 'a-strong-password',
  });
  token = reg.body.token;
  userId = reg.body.user.id;

  for (const name of ['Code Worker', 'Code Inspector']) {
    const res = await request(app)
      .post('/api/agents')
      .set(auth())
      .send({ name, runtime: 'claude-code' });
    if (name === 'Code Worker') workerId = res.body.agent.id;
    else inspectorId = res.body.agent.id;
  }

  const project = await request(app)
    .post('/api/projects')
    .set(auth())
    .send({ name: 'LedgerLite' });
  projectId = project.body.project.id;
});

afterAll(() => {
  setTaskTurnExecutorForTests(null);
});

afterEach(async () => {
  await drainRunsForTests();
  onTurn = () => {};
});

describe('project repository binding', () => {
  it('rejects binding before the workspace is a Git repository', { timeout: T }, async () => {
    const res = await request(app)
      .put(`/api/projects/${projectId}/repository`)
      .set(auth())
      .send({ location: 'server' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('not_a_repository');
  });

  it('rejects code execution on the default project', { timeout: T }, async () => {
    const fallbackTask = await request(app)
      .post('/api/tasks')
      .set(auth())
      .send({ title: 'Default project fixture' });
    const res = await request(app)
      .put(`/api/projects/${fallbackTask.body.task.projectId}/repository`)
      .set(auth())
      .send({ location: 'server' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('default_project');
  });

  it('binds the server repository and inspects it', { timeout: T }, async () => {
    await initProjectRepo();
    const bind = await request(app)
      .put(`/api/projects/${projectId}/repository`)
      .set(auth())
      .send({ location: 'server' });
    expect(bind.status).toBe(200);
    expect(bind.body.repository.defaultBaseRef).toBe('main');
    expect(bind.body.repository.repositoryFingerprint).toMatch(/^[0-9a-f]{64}$/);

    const inspect = await request(app)
      .post(`/api/projects/${projectId}/repository/inspect`)
      .set(auth());
    expect(inspect.status).toBe(200);
    expect(inspect.body.valid).toBe(true);
    expect(inspect.body.dirty).toBe(false);
  });
});

describe('runs in isolated task workspaces', () => {
  it('runs the worker in a worktree and captures its changes', { timeout: T }, async () => {
    const task = await createTaskIn('Add ledger export');
    onTurn = (req) => {
      fs.writeFileSync(path.join(req.workspace, 'feature.txt'), 'export ledger\n');
    };
    await wake(workerId, task.id, 'manual');

    const turn = seen[seen.length - 1]!;
    expect(turn.workspace).toContain(path.join('worktrees', task.id));
    expect(turn.workspace).not.toBe(storage.projectWorkspace(userId, projectId));
    expect(turn.permission).toBe('edit');

    const ws = await workspaceOf(task.id);
    expect(ws?.status).toBe('dirty');
    expect(ws?.branchName).toBe(`swarmdev/task-${task.number}-${task.id.replace(/-/g, '').slice(0, 6)}`);

    const changes = await request(app).get(`/api/tasks/${task.id}/changes`).set(auth());
    expect(changes.status).toBe(200);
    expect(changes.body.snapshot.changedFiles).toBe(1);
    expect(changes.body.snapshot.afterSummaryJson.untracked).toEqual(['feature.txt']);
    expect(changes.body.drift.baseIsAncestor).toBe(true);

    const timeline = await db
      .select()
      .from(taskComments)
      .where(and(eq(taskComments.taskId, task.id), eq(taskComments.authorType, 'system')));
    expect(timeline.some((c) => c.body.includes('Code changes captured'))).toBe(true);
  });

  it('reuses the same worktree for rework and for the reviewer', { timeout: T }, async () => {
    const task = await createTaskIn('Rework reuse');
    onTurn = (req) => {
      fs.writeFileSync(path.join(req.workspace, 'draft.txt'), 'v1\n');
    };
    await wake(workerId, task.id, 'manual');
    const firstPath = seen[seen.length - 1]!.workspace;

    let sawPreviousWork = false;
    onTurn = (req) => {
      sawPreviousWork = fs.existsSync(path.join(req.workspace, 'draft.txt'));
    };
    await wake(workerId, task.id, 'manual');
    expect(seen[seen.length - 1]!.workspace).toBe(firstPath);
    expect(sawPreviousWork).toBe(true);

    await wake(inspectorId, task.id, 'review');
    const reviewTurn = seen[seen.length - 1]!;
    expect(reviewTurn.workspace).toBe(firstPath);
    expect(reviewTurn.permission).toBe('read_only');
  });

  it('keeps concurrent tasks in separate worktrees', { timeout: T }, async () => {
    const a = await createTaskIn('Iso A');
    const b = await createTaskIn('Iso B');
    await wake(workerId, a.id, 'manual');
    const pathA = seen[seen.length - 1]!.workspace;
    await wake(workerId, b.id, 'manual');
    const pathB = seen[seen.length - 1]!.workspace;
    expect(pathA).not.toBe(pathB);
  });

  it('captures evidence from failed runs and keeps the workspace', { timeout: T }, async () => {
    const task = await createTaskIn('Failing run');
    onTurn = (req) => {
      fs.writeFileSync(path.join(req.workspace, 'partial.txt'), 'half done\n');
      throw new Error('runtime exploded');
    };
    await wake(workerId, task.id, 'manual');

    const [run] = await db.select().from(runs).where(eq(runs.taskId, task.id));
    expect(run!.status).toBe('failed');
    const [snapshot] = await db
      .select()
      .from(runChangeSnapshots)
      .where(eq(runChangeSnapshots.runId, run!.id));
    expect(snapshot).toBeDefined();
    expect(snapshot!.changedFiles).toBe(1);
    expect((await workspaceOf(task.id))?.status).toBe('dirty');
  });

  it('flags a read-only run that mutated tracked files', { timeout: T }, async () => {
    const task = await createTaskIn('Read-only violation');
    await wake(workerId, task.id, 'manual'); // prepare workspace with a clean run
    onTurn = (req) => {
      fs.writeFileSync(path.join(req.workspace, 'README.md'), '# tampered\n');
    };
    await wake(inspectorId, task.id, 'review');

    const reviewRun = await db
      .select()
      .from(runs)
      .where(and(eq(runs.taskId, task.id), eq(runs.trigger, 'review')));
    const [snapshot] = await db
      .select()
      .from(runChangeSnapshots)
      .where(eq(runChangeSnapshots.runId, reviewRun[0]!.id));
    expect(snapshot!.policyViolation).toBe(true);

    const timeline = await db
      .select()
      .from(taskComments)
      .where(and(eq(taskComments.taskId, task.id), eq(taskComments.authorType, 'system')));
    expect(timeline.some((c) => c.body.includes('Read-only policy violation'))).toBe(true);
  });

  it('rejects an API worker on a code project with a visible failure', { timeout: T }, async () => {
    const apiAgent = await request(app)
      .post('/api/agents')
      .set(auth())
      .send({ name: 'API Writer', runtime: 'api' });
    const task = await createTaskIn('API worker rejection');
    await wake(apiAgent.body.agent.id, task.id, 'manual');

    const [run] = await db.select().from(runs).where(eq(runs.taskId, task.id));
    expect(run!.status).toBe('failed');
    expect(run!.error).toContain('API-hosted');
    expect(await workspaceOf(task.id)).toBeNull();
  });
});

describe('review binding and lifecycle guards', () => {
  it('binds human approval to the captured snapshot and keeps the task in review', { timeout: T }, async () => {
    const task = await createTaskIn('Approval binding');
    onTurn = (req) => {
      fs.writeFileSync(path.join(req.workspace, 'work.txt'), 'done\n');
    };
    await wake(workerId, task.id, 'manual');

    for (const status of ['todo', 'in_progress', 'in_review']) {
      const res = await request(app)
        .post(`/api/tasks/${task.id}/move`)
        .set(auth())
        .send({ status });
      expect(res.status).toBe(200);
    }
    await drainRunsForTests();

    const review = await createReview(userId, task.id, {
      decision: 'approved',
      body: 'Looks correct against the captured diff.',
      reviewer: { userId },
    });
    expect(review.changeSnapshotId).not.toBeNull();

    const after = await request(app).get(`/api/tasks/${task.id}`).set(auth());
    expect(after.body.task.status).toBe('in_review');
    expect(after.body.task.closedAt ?? null).toBeNull();
  });

  it('blocks task and project deletion while workspaces are active', { timeout: T }, async () => {
    const task = await createTaskIn('Deletion guard');
    await wake(workerId, task.id, 'manual');

    const delTask = await request(app).delete(`/api/tasks/${task.id}`).set(auth());
    expect(delTask.status).toBe(409);
    expect(delTask.body.code).toBe('workspace_active');

    const delProject = await request(app).delete(`/api/projects/${projectId}`).set(auth());
    expect(delProject.status).toBe(409);

    const unbind = await request(app).delete(`/api/projects/${projectId}/repository`).set(auth());
    expect(unbind.status).toBe(409);
  });

  it('leaves non-code projects on the legacy approval path', { timeout: T }, async () => {
    const res = await request(app)
      .post('/api/tasks')
      .set(auth())
      .send({ title: 'Legacy approval' });
    const task = res.body.task as { id: string };
    for (const status of ['todo', 'in_progress', 'in_review']) {
      await request(app).post(`/api/tasks/${task.id}/move`).set(auth()).send({ status });
    }
    await drainRunsForTests();

    const review = await createReview(userId, task.id, {
      decision: 'approved',
      body: 'Ship it.',
      reviewer: { userId },
    });
    expect(review.changeSnapshotId).toBeNull();

    const after = await request(app).get(`/api/tasks/${task.id}`).set(auth());
    expect(after.body.task.status).toBe('done');
  });
});

describe('workspace diagnostics', () => {
  it('reconciles a worktree deleted out of band', { timeout: T }, async () => {
    const task = await createTaskIn('Reconcile recovery');
    await wake(workerId, task.id, 'manual');
    const ws = await workspaceOf(task.id);
    fs.rmSync(ws!.worktreePath, { recursive: true, force: true, maxRetries: 5 });

    const res = await request(app)
      .post(`/api/tasks/${task.id}/workspace/reconcile`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(['ready', 'dirty']).toContain(res.body.workspace.status);
    expect(fs.existsSync(ws!.worktreePath)).toBe(true);
  });

  it('reports the agent permission ceiling through the agent API', async () => {
    await db
      .update(agents)
      .set({ permissionLevel: 'read_only' })
      .where(eq(agents.id, inspectorId));
    const res = await request(app).get(`/api/agents/${inspectorId}`).set(auth());
    expect(res.body.agent.permissionLevel).toBe('read_only');
  });
});
