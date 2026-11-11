import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import {
  executionWorkspaces,
  approvals,
  repositories,
  runChangeSnapshots,
  runs,
} from '../src/db/schema';
import { createApp } from '../src/http/app';

const app = createApp();
let token = '';
let userId = '';
let agentId = '';
let taskId = '';

function one<T>(rows: T[]): T {
  const row = rows[0];
  if (!row) throw new Error('expected a returned row');
  return row;
}

/** pg surfaces SQLSTATE on the error; drizzle may wrap it as the cause. */
async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code;
  }
}

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');

  const reg = await request(app).post('/auth/register').send({
    email: 'workspaces@example.com',
    username: 'workspacesuser',
    password: 'a-strong-password',
  });
  token = reg.body.token;
  userId = reg.body.user.id;

  const agent = await request(app)
    .post('/api/agents')
    .set({ Authorization: `Bearer ${token}` })
    .send({ name: 'Workspace worker', runtime: 'claude-code' });
  agentId = agent.body.agent.id;

  const task = await request(app)
    .post('/api/tasks')
    .set({ Authorization: `Bearer ${token}` })
    .send({ title: 'Workspace constraint fixture' });
  taskId = task.body.task.id;
});

function workspaceRow(overrides: Partial<typeof executionWorkspaces.$inferInsert> = {}) {
  return {
    userId,
    taskId,
    worktreePath: `worktrees/${taskId}`,
    branchName: 'loxo/task-1-fixture',
    baseRef: 'main',
    baseCommit: 'a'.repeat(40),
    ...overrides,
  };
}

describe('execution workspace constraints', () => {
  it('allows at most one non-terminal workspace per task', async () => {
    const first = one(
      await db.insert(executionWorkspaces).values(workspaceRow({ status: 'ready' })).returning()
    );
    expect(first.status).toBe('ready');

    expect(await sqlState(db.insert(executionWorkspaces).values(workspaceRow()))).toBe('23505');

    // dirty is still active; the index guards every non-terminal status.
    await db
      .update(executionWorkspaces)
      .set({ status: 'dirty' })
      .where(eq(executionWorkspaces.id, first.id));
    expect(await sqlState(db.insert(executionWorkspaces).values(workspaceRow()))).toBe('23505');

    // A terminal row frees the slot for a fresh workspace.
    await db
      .update(executionWorkspaces)
      .set({ status: 'merged' })
      .where(eq(executionWorkspaces.id, first.id));
    const second = one(
      await db.insert(executionWorkspaces).values(workspaceRow({ status: 'preparing' })).returning()
    );
    expect(second.id).not.toBe(first.id);

    // Terminal rows coexist: merged history plus a retained one.
    await db
      .update(executionWorkspaces)
      .set({ status: 'retained' })
      .where(eq(executionWorkspaces.id, second.id));
    const third = one(await db.insert(executionWorkspaces).values(workspaceRow()).returning());
    expect(third.status).toBe('preparing');
  });
});

describe('repository constraints', () => {
  it('registers a root path at most once per user with default settings', async () => {
    const values = { userId, name: 'fixture', rootPath: '/srv/fixture', fingerprint: 'fp' };
    const repository = one(await db.insert(repositories).values(values).returning());
    expect(repository.defaultBranch).toBe('main');
    expect(repository.checks).toEqual([]);
    expect(repository.setupCommand).toBeNull();

    expect(await sqlState(db.insert(repositories).values(values))).toBe('23505');

    await db.delete(repositories).where(eq(repositories.id, repository.id));
  });
});

describe('run change snapshots and approval binding', () => {
  it('stores one snapshot per run and keeps the approval fingerprint when the snapshot goes away', async () => {
    const run = one(
      await db
        .insert(runs)
        .values({ userId, agentId, agentName: 'Workspace worker', taskId, trigger: 'manual' })
        .returning()
    );

    const snapshot = one(
      await db
        .insert(runChangeSnapshots)
        .values({
          runId: run.id,
          beforeHead: 'b'.repeat(40),
          afterHead: 'c'.repeat(40),
          changeFingerprint: 'fp-fixture',
        })
        .returning()
    );
    expect(snapshot.beforeSummaryJson).toEqual({ files: [], untracked: [] });
    expect(snapshot.policyViolation).toBe(false);

    expect(
      await sqlState(
        db.insert(runChangeSnapshots).values({
          runId: run.id,
          beforeHead: 'd'.repeat(40),
          afterHead: 'e'.repeat(40),
          changeFingerprint: 'fp-duplicate',
        })
      )
    ).toBe('23505');

    const approval = one(
      await db
        .insert(approvals)
        .values({
          userId,
          taskId,
          changeSnapshotId: snapshot.id,
          fingerprint: snapshot.changeFingerprint,
          decision: 'approved',
          body: 'Verified against the snapshot fingerprint.',
        })
        .returning()
    );
    expect(approval.changeSnapshotId).toBe(snapshot.id);

    // The pinned fingerprint outlives the snapshot row, so staleness checks keep working.
    await db.delete(runChangeSnapshots).where(eq(runChangeSnapshots.id, snapshot.id));
    const after = one(await db.select().from(approvals).where(eq(approvals.id, approval.id)));
    expect(after.changeSnapshotId).toBeNull();
    expect(after.fingerprint).toBe('fp-fixture');
  });
});

describe('agent permission level', () => {
  it('defaults to edit for newly created agents', async () => {
    const res = await request(app)
      .get(`/api/agents/${agentId}`)
      .set({ Authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    expect(res.body.agent.permissionLevel).toBe('edit');
  });
});
