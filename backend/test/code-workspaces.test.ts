import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import {
  workspaces,
  approvals,
  repositories,
  turns,
  changeSnapshots,
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

function workspaceRow(overrides: Partial<typeof workspaces.$inferInsert> = {}) {
  return {
    userId,
    taskId,
    kind: 'integration' as const,
    worktreePath: `worktrees/${taskId}`,
    branchName: 'loxo/task-1-fixture',
    baseRef: 'main',
    baseCommit: 'a'.repeat(40),
    ...overrides,
  };
}

describe('workspace constraints', () => {
  it('allows at most one non-terminal integration workspace per task', async () => {
    const first = one(
      await db.insert(workspaces).values(workspaceRow({ status: 'ready' })).returning()
    );
    expect(first.status).toBe('ready');

    expect(await sqlState(db.insert(workspaces).values(workspaceRow()))).toBe('23505');

    // dirty is still active; the index guards every non-terminal status.
    await db
      .update(workspaces)
      .set({ status: 'dirty' })
      .where(eq(workspaces.id, first.id));
    expect(await sqlState(db.insert(workspaces).values(workspaceRow()))).toBe('23505');

    // A terminal row frees the slot for a fresh workspace.
    await db
      .update(workspaces)
      .set({ status: 'merged' })
      .where(eq(workspaces.id, first.id));
    const second = one(
      await db.insert(workspaces).values(workspaceRow({ status: 'preparing' })).returning()
    );
    expect(second.id).not.toBe(first.id);

    // Terminal rows coexist: merged history plus a retained one.
    await db
      .update(workspaces)
      .set({ status: 'retained' })
      .where(eq(workspaces.id, second.id));
    const third = one(await db.insert(workspaces).values(workspaceRow()).returning());
    expect(third.status).toBe('preparing');
  });
});

describe('multiple workspaces per task', () => {
  it('holds one active workspace per member and kind beside the integration one', async () => {
    const other = await request(app)
      .post('/api/agents')
      .set({ Authorization: `Bearer ${token}` })
      .send({ name: 'Second member', runtime: 'claude-code' });
    const otherId = other.body.agent.id as string;
    const task = await request(app)
      .post('/api/tasks')
      .set({ Authorization: `Bearer ${token}` })
      .send({ title: 'Parallel members' });
    const parallelTask = task.body.task.id as string;
    const row = (kind: 'integration' | 'member' | 'review', agent: string | null) => ({
      ...workspaceRow({ taskId: parallelTask, kind, agentId: agent }),
      worktreePath: `worktrees/${parallelTask}/${kind}-${agent ?? 'none'}`,
    });

    await db.insert(workspaces).values(row('integration', null));
    await db.insert(workspaces).values(row('member', agentId));
    await db.insert(workspaces).values(row('member', otherId));
    await db.insert(workspaces).values(row('review', agentId));

    expect(await sqlState(db.insert(workspaces).values(row('member', agentId)))).toBe('23505');
    expect(await sqlState(db.insert(workspaces).values(row('integration', null)))).toBe('23505');
  });

  it('admits one running writer per workspace while readers run freely', async () => {
    const task = await request(app)
      .post('/api/tasks')
      .set({ Authorization: `Bearer ${token}` })
      .send({ title: 'Single writer' });
    const writerTask = task.body.task.id as string;
    const workspace = one(
      await db
        .insert(workspaces)
        .values({ ...workspaceRow({ taskId: writerTask }), worktreePath: `worktrees/${writerTask}` })
        .returning()
    );
    let seq = 0;
    const turn = (permission: 'read_only' | 'edit' | 'full', status: 'running' | 'completed') => {
      seq += 1;
      return db
        .insert(turns)
        .values({ taskId: writerTask, seq, kind: 'agent', agentId, workspaceId: workspace.id, permission, status })
        .returning();
    };

    const writer = one(await turn('edit', 'running'));
    expect(await sqlState(turn('full', 'running'))).toBe('23505');
    expect(await sqlState(turn('read_only', 'running'))).toBeUndefined();
    expect(await sqlState(turn('read_only', 'running'))).toBeUndefined();

    await db.update(turns).set({ status: 'completed' }).where(eq(turns.id, writer.id));
    expect(await sqlState(turn('edit', 'running'))).toBeUndefined();
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
        .insert(changeSnapshots)
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
        db.insert(changeSnapshots).values({
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
    await db.delete(changeSnapshots).where(eq(changeSnapshots.id, snapshot.id));
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
