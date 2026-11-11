import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import { agents, changeSnapshots, runs, turns } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { recordApproval } from '../src/modules/tasks/approvals.service';
import { setTaskTurnExecutorForTests } from '../src/modules/runs/task-run';
import { drainRunsForTests, requestWake } from '../src/modules/runs/wake';
import type { TurnRequest, TurnResult } from '../src/modules/runner/runner';
import { storage } from '../src/storage/layout';
import { initFixtureRepo, makeSandbox, removeSandbox } from './fixtures/git-repo';

const app = createApp();
const T = 30_000;

let token = '';
let userId = '';
let workerId = '';
let inspectorId = '';
let repositoryId = '';
let sandbox = '';

interface SeenTurn {
  workspace: string;
  permission: TurnRequest['permission'];
  trigger: string;
}
const seen: SeenTurn[] = [];
let onTurn: (req: TurnRequest) => void = () => {};

const auth = () => ({ Authorization: `Bearer ${token}` });

async function createTaskIn(title: string): Promise<{ id: string; number: number }> {
  const res = await request(app).post('/api/tasks').set(auth()).send({ title, repositoryId });
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

  sandbox = makeSandbox('runs');
});

afterAll(() => {
  setTaskTurnExecutorForTests(null);
  removeSandbox(sandbox);
});

afterEach(async () => {
  await drainRunsForTests();
  onTurn = () => {};
});

describe('repository registration', () => {
  it('registers a local repository and inspects it', { timeout: T }, async () => {
    const dir = await initFixtureRepo(path.join(sandbox, 'ledgerlite'));
    const created = await request(app).post('/api/repositories').set(auth()).send({ rootPath: dir });
    expect(created.status).toBe(201);
    expect(created.body.repository.defaultBranch).toBe('main');
    expect(created.body.repository.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    repositoryId = created.body.repository.id;

    const inspect = await request(app)
      .post(`/api/repositories/${repositoryId}/inspect`)
      .set(auth());
    expect(inspect.status).toBe(200);
    expect(inspect.body.inspection.valid).toBe(true);
    expect(inspect.body.inspection.dirty).toBe(false);
    expect(inspect.body.inspection.sameRepository).toBe(true);
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
    expect(turn.workspace).toBe(path.join(storage.worktreesRoot(userId), task.id));
    expect(turn.permission).toBe('edit');

    const ws = await workspaceOf(task.id);
    expect(ws?.status).toBe('dirty');
    expect(ws?.branchName).toBe(`loxo/task-${task.number}-${task.id.replace(/-/g, '').slice(0, 6)}`);

    const changes = await request(app).get(`/api/tasks/${task.id}/changes`).set(auth());
    expect(changes.status).toBe(200);
    expect(changes.body.snapshot.changedFiles).toBe(1);
    expect(changes.body.snapshot.afterSummaryJson.untracked).toEqual(['feature.txt']);
    expect(changes.body.drift.baseIsAncestor).toBe(true);

    const timeline = await db
      .select()
      .from(turns)
      .where(and(eq(turns.taskId, task.id), eq(turns.kind, 'system')));
    expect(timeline.some((t) => t.content.includes('Code changes captured'))).toBe(true);
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
      .from(changeSnapshots)
      .where(eq(changeSnapshots.runId, run!.id));
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
      .from(changeSnapshots)
      .where(eq(changeSnapshots.runId, reviewRun[0]!.id));
    expect(snapshot!.policyViolation).toBe(true);

    const timeline = await db
      .select()
      .from(turns)
      .where(and(eq(turns.taskId, task.id), eq(turns.kind, 'system')));
    expect(timeline.some((t) => t.content.includes('Read-only policy violation'))).toBe(true);
  });

  it('rejects an API worker on a code task with a visible failure', { timeout: T }, async () => {
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

    const approval = await recordApproval(userId, task.id, {
      decision: 'approved',
      body: 'Looks correct against the captured diff.',
    });
    expect(approval.changeSnapshotId).not.toBeNull();

    const after = await request(app).get(`/api/tasks/${task.id}`).set(auth());
    expect(after.body.task.status).toBe('in_review');
    expect(after.body.task.closedAt ?? null).toBeNull();
  });

  it('blocks task and repository removal while workspaces are active', { timeout: T }, async () => {
    const task = await createTaskIn('Deletion guard');
    await wake(workerId, task.id, 'manual');

    const delTask = await request(app).delete(`/api/tasks/${task.id}`).set(auth());
    expect(delTask.status).toBe(409);
    expect(delTask.body.code).toBe('workspace_active');

    const removeRepo = await request(app).delete(`/api/repositories/${repositoryId}`).set(auth());
    expect(removeRepo.status).toBe(409);
    expect(removeRepo.body.code).toBe('workspace_active');
  });

  it('leaves tasks without a repository on the plain approval path', { timeout: T }, async () => {
    const res = await request(app)
      .post('/api/tasks')
      .set(auth())
      .send({ title: 'Legacy approval' });
    const task = res.body.task as { id: string };
    for (const status of ['todo', 'in_progress', 'in_review']) {
      await request(app).post(`/api/tasks/${task.id}/move`).set(auth()).send({ status });
    }
    await drainRunsForTests();

    const approval = await recordApproval(userId, task.id, {
      decision: 'approved',
      body: 'Ship it.',
    });
    expect(approval.changeSnapshotId).toBeNull();

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
