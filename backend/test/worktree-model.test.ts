import fs from 'node:fs';
import path from 'node:path';
import { and, desc, eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import { agents, changeSnapshots, runs, tasks, workspaces, type Agent, type Workspace } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { localGitDriver } from '../src/modules/code-workspaces/local-git-driver';
import { commentOnTask } from '../src/modules/control-plane/tools';
import { recoverRun } from '../src/modules/ownership/recovery';
import { takeOverRun } from '../src/modules/ownership/takeover';
import { admitRun, createQueuedRun, failQueuedRun } from '../src/modules/runs/runs.service';
import { setTaskHostFactoryForTests } from '../src/modules/runs/task-run';
import { drainRunsForTests } from '../src/modules/runs/wake';
import { git, initFixtureRepo, makeSandbox, removeSandbox } from './fixtures/git-repo';
import { scriptedHost } from './support/scripted-host';

/**
 * A task can have several worktrees: everything a run does to one (capture,
 * recovery, quarantine, reconcile) stays with the worktree it works in.
 */
const app = createApp();
const T = 60_000;
let token = '';
let userId = '';
let workerId = '';
let repositoryId = '';
let repoDir = '';
let sandbox = '';

const auth = () => ({ Authorization: `Bearer ${token}` });

async function newTask(title: string): Promise<string> {
  const res = await request(app)
    .post('/api/tasks')
    .set(auth())
    .send({ title, repositoryId, leadAgentId: workerId, memberAgentIds: [workerId] });
  return res.body.task.id;
}

async function integrationOf(taskId: string): Promise<Workspace> {
  const [row] = await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.taskId, taskId), eq(workspaces.kind, 'integration')));
  return row!;
}

/** A second worktree row on the task, as a workshop member's would be; only its row matters here. */
async function memberWorktree(taskId: string, base: Workspace): Promise<Workspace> {
  const [row] = await db
    .insert(workspaces)
    .values({
      userId,
      taskId,
      repositoryId,
      kind: 'member',
      agentId: workerId,
      worktreePath: path.join(sandbox, `member-${taskId}`),
      branchName: null,
      currentBranch: null,
      baseRef: base.baseRef,
      baseCommit: base.baseCommit,
      status: 'ready',
    })
    .returning();
  return row!;
}

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  setTaskHostFactoryForTests(
    scriptedHost(async (turn) => {
      fs.writeFileSync(path.join(turn.workspace, 'notes.txt'), 'untracked notes\n');
      return { text: 'Wrote notes.' };
    })
  );
  const reg = await request(app).post('/auth/register').send({
    email: 'worktrees@example.com',
    username: 'worktrees',
    password: 'a-strong-password',
  });
  token = reg.body.token;
  userId = reg.body.user.id;
  const agent = await request(app).post('/api/agents').set(auth()).send({ name: 'Worker', runtime: 'claude-code' });
  workerId = agent.body.agent.id;
  sandbox = makeSandbox('worktrees');
  repoDir = await initFixtureRepo(path.join(sandbox, 'repo'));
  const repo = await request(app).post('/api/repositories').set(auth()).send({ rootPath: repoDir });
  repositoryId = repo.body.repository.id;
});

afterEach(async () => {
  await drainRunsForTests();
});

afterAll(() => {
  setTaskHostFactoryForTests(null);
  removeSandbox(sandbox);
});

describe('worktrees of a task', () => {
  it('records the worktree a legacy run used, and the tree its capture saw', { timeout: T }, async () => {
    const taskId = await newTask('Record the worktree');
    await request(app).post(`/api/tasks/${taskId}/move`).set(auth()).send({ status: 'todo' });
    await drainRunsForTests();

    const workspace = await integrationOf(taskId);
    const [run] = await db.select().from(runs).where(eq(runs.taskId, taskId));
    expect(run).toMatchObject({ status: 'succeeded', workspaceId: workspace.id });
    expect(workspace.currentBranch).toBe(workspace.branchName);

    const [snapshot] = await db
      .select()
      .from(changeSnapshots)
      .where(eq(changeSnapshots.runId, run!.id))
      .orderBy(desc(changeSnapshots.capturedAt));
    // The untracked file is part of the recorded tree.
    const now = await localGitDriver.snapshotTree(workspace.worktreePath);
    expect(snapshot!.treeId).toBe(now.tree);
    fs.rmSync(path.join(workspace.worktreePath, 'notes.txt'));
    const withoutNotes = await localGitDriver.snapshotTree(workspace.worktreePath);
    expect(snapshot!.treeId).not.toBe(withoutNotes.tree);
  });

  it('admits a run unless its own worktree is quarantined', { timeout: T }, async () => {
    const taskId = await newTask('Quarantine one worktree');
    await request(app).post(`/api/tasks/${taskId}/workspace/prepare`).set(auth());
    const integration = await integrationOf(taskId);
    const member = await memberWorktree(taskId, integration);
    await db.update(workspaces).set({ status: 'quarantined' }).where(eq(workspaces.id, member.id));

    const onMember = await createQueuedRun(userId, {
      agentId: workerId,
      agentName: 'Worker',
      taskId,
      trigger: 'manual',
      workspaceId: member.id,
    });
    expect(await admitRun(onMember.id, { instance: 'quarantine-test' })).toBeUndefined();
    await failQueuedRun(onMember.id, 'cleanup');

    const onIntegration = await createQueuedRun(userId, {
      agentId: workerId,
      agentName: 'Worker',
      taskId,
      trigger: 'manual',
      workspaceId: integration.id,
    });
    const admitted = await admitRun(onIntegration.id, { instance: 'quarantine-test' });
    expect(admitted?.run.status).toBe('running');
    await db.update(runs).set({ status: 'failed', leaseExpiresAt: null }).where(eq(runs.id, onIntegration.id));
    await db.update(agents).set({ status: 'idle' }).where(eq(agents.id, workerId));
  });

  it("quarantines only the worktree of a run that lost its owner", { timeout: T }, async () => {
    const taskId = await newTask('Recover one worktree');
    await request(app).post(`/api/tasks/${taskId}/workspace/prepare`).set(auth());
    const integration = await integrationOf(taskId);
    const member = await memberWorktree(taskId, integration);
    const queued = await createQueuedRun(userId, {
      agentId: workerId,
      agentName: 'Worker',
      taskId,
      trigger: 'manual',
      workspaceId: member.id,
    });
    const admitted = await admitRun(queued.id, { instance: 'dead' });
    const [agent] = await db.select().from(agents).where(eq(agents.id, workerId));
    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    await commentOnTask({ run: admitted!.run, epoch: admitted!.run.ownerEpoch, agent: agent as Agent, task: task! }, 'Halfway.');
    await db.update(runs).set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(runs.id, queued.id));
    const resolved = await recoverRun((await takeOverRun(queued.id, { instance: 'recoverer', reason: 'test' }))!);
    expect(resolved.status).toBe('interrupted');

    const [memberAfter] = await db.select().from(workspaces).where(eq(workspaces.id, member.id));
    const integrationAfter = await integrationOf(taskId);
    expect(memberAfter!.status).toBe('quarantined');
    expect(integrationAfter.status).not.toBe('quarantined');
  });

  it('reconciles one worktree of a task by id, and only one that belongs to it', { timeout: T }, async () => {
    const taskId = await newTask('Reconcile by id');
    await request(app).post(`/api/tasks/${taskId}/workspace/prepare`).set(auth());
    const integration = await integrationOf(taskId);
    const ok = await request(app)
      .post(`/api/tasks/${taskId}/workspaces/${integration.id}/reconcile`)
      .set(auth());
    expect(ok.status).toBe(200);
    expect(ok.body.workspace).toMatchObject({ id: integration.id, status: 'ready' });

    const otherTask = await newTask('Someone else');
    const wrong = await request(app)
      .post(`/api/tasks/${otherTask}/workspaces/${integration.id}/reconcile`)
      .set(auth());
    expect(wrong.status).toBe(404);
  });

  it('reconciles a detached worktree, and reports it missing once it is gone', { timeout: T }, async () => {
    const detached = path.join(sandbox, 'detached-review');
    const head = await git(repoDir, 'rev-parse', 'HEAD');
    await git(repoDir, 'worktree', 'add', '--detach', detached, head);
    const present = await localGitDriver.reconcileWorkspace({
      repositoryRoot: repoDir,
      worktreePath: detached,
      branchName: null,
      baseCommit: head,
    });
    expect(present).toMatchObject({ state: 'ready', branchName: null, headCommit: head });

    fs.rmSync(detached, { recursive: true, force: true });
    const gone = await localGitDriver.reconcileWorkspace({
      repositoryRoot: repoDir,
      worktreePath: detached,
      branchName: null,
      baseCommit: head,
    });
    expect(gone.state).toBe('missing');
  });
});
