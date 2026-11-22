import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upgradeDatabase, type Query, type UpgradedDatabase } from './support/upgrade-db';

/**
 * Upgrades a database written before workshops existed: tasks driven by
 * status, runs gated per task, one integration worktree per task.
 */
const LAST_PRE_WORKSHOP_MIGRATION = 42;

const ids = {
  user: '00000000-0000-4000-8000-000000000001',
  agent: '00000000-0000-4000-8000-0000000000b1',
  repo: '00000000-0000-4000-8000-0000000000c1',
  task: '00000000-0000-4000-8000-0000000000d1',
  bare: '00000000-0000-4000-8000-0000000000d2',
  oldWorkspace: '00000000-0000-4000-8000-0000000000f1',
  workspace: '00000000-0000-4000-8000-0000000000f2',
  queued: '00000000-0000-4000-8000-0000000000e1',
  done: '00000000-0000-4000-8000-0000000000e2',
  bareRun: '00000000-0000-4000-8000-0000000000e3',
};

let upgraded: UpgradedDatabase;
const q: Query = (sql, params) => upgraded.q(sql, params);

async function seed(q: Query): Promise<void> {
  await q(`INSERT INTO users (id, email, username, password_hash) VALUES ($1, 'w@example.com', 'w', 'x')`, [ids.user]);
  await q(`INSERT INTO agents (id, user_id, name, runtime) VALUES ($1, $2, 'Lead', 'api')`, [ids.agent, ids.user]);
  await q(`INSERT INTO repositories (id, user_id, name, root_path, fingerprint) VALUES ($1, $2, 'r', '/tmp/r', 'f')`, [
    ids.repo,
    ids.user,
  ]);
  await q(
    `INSERT INTO tasks (id, user_id, repository_id, number, title, status) VALUES
      ($1, $3, $4, 1, 'With code', 'in_progress'),
      ($2, $3, NULL, 2, 'No code', 'todo')`,
    [ids.task, ids.bare, ids.user, ids.repo]
  );
  await q(
    `INSERT INTO workspaces (id, user_id, task_id, repository_id, kind, worktree_path, branch_name, base_ref, base_commit, status, created_at) VALUES
      ($1, $3, $4, $5, 'integration', '/tmp/w1', 'loxo/t1-old', 'main', 'abc', 'abandoned', now() - interval '1 hour'),
      ($2, $3, $4, $5, 'integration', '/tmp/w2', 'loxo/t1', 'main', 'abc', 'ready', now())`,
    [ids.oldWorkspace, ids.workspace, ids.user, ids.task, ids.repo]
  );
  await q(
    `INSERT INTO runs (id, user_id, agent_id, agent_name, task_id, trigger, status) VALUES
      ($1, $4, $5, 'Lead', $6, 'assignment', 'queued'),
      ($2, $4, $5, 'Lead', $6, 'review', 'succeeded'),
      ($3, $4, $5, 'Lead', $7, 'manual', 'succeeded')`,
    [ids.queued, ids.done, ids.bareRun, ids.user, ids.agent, ids.task, ids.bare]
  );
  await q(
    `INSERT INTO runs (user_id, agent_name, trigger, status) VALUES ($1, 'Gone', 'manual', 'failed')`,
    [ids.user]
  );
}

beforeAll(async () => {
  upgraded = await upgradeDatabase('swarmdev_upgrade_workshop_test', LAST_PRE_WORKSHOP_MIGRATION, seed);
}, 120_000);

afterAll(async () => {
  await upgraded?.drop();
});

describe('migration to workshops', () => {
  it('keeps existing tasks on the legacy playbook with no phase', async () => {
    const rows = await q<{ playbook: string; phase: string | null; cycle: number; advance_pending: boolean }>(
      `SELECT playbook, phase, cycle, advance_pending FROM tasks ORDER BY number`
    );
    expect(rows).toEqual([
      { playbook: 'legacy', phase: null, cycle: 0, advance_pending: false },
      { playbook: 'legacy', phase: null, cycle: 0, advance_pending: false },
    ]);
  });

  it('gates existing task runs by their task, as before', async () => {
    const rows = await q<{ id: string; gate_key: string | null; actor: string }>(
      `SELECT id, gate_key, actor FROM runs WHERE task_id IS NOT NULL ORDER BY id`
    );
    expect(rows).toEqual([
      { id: ids.queued, gate_key: `task:${ids.task}`, actor: 'agent' },
      { id: ids.done, gate_key: `task:${ids.task}`, actor: 'agent' },
      { id: ids.bareRun, gate_key: `task:${ids.bare}`, actor: 'agent' },
    ]);
    const [taskless] = await q<{ gate_key: string | null }>(`SELECT gate_key FROM runs WHERE task_id IS NULL`);
    expect(taskless).toEqual({ gate_key: null });
  });

  it("points existing runs at their task's latest integration worktree", async () => {
    const rows = await q<{ id: string; workspace_id: string | null }>(
      `SELECT id, workspace_id FROM runs WHERE task_id IS NOT NULL ORDER BY id`
    );
    expect(rows).toEqual([
      { id: ids.queued, workspace_id: ids.workspace },
      { id: ids.done, workspace_id: ids.workspace },
      { id: ids.bareRun, workspace_id: null },
    ]);
  });

  it('starts every existing worktree with its branch checked out', async () => {
    const rows = await q<{ id: string; branch_name: string; current_branch: string }>(
      `SELECT id, branch_name, current_branch FROM workspaces ORDER BY id`
    );
    expect(rows).toEqual([
      { id: ids.oldWorkspace, branch_name: 'loxo/t1-old', current_branch: 'loxo/t1-old' },
      { id: ids.workspace, branch_name: 'loxo/t1', current_branch: 'loxo/t1' },
    ]);
  });

  it('treats the workshop report tools as terminal: once per run', async () => {
    const insert = (seq: number) =>
      q(
        `INSERT INTO control_plane_requests (run_id, epoch, seq, tool, args_hash) VALUES ($1, 1, $2, 'submit_plan', 'h')`,
        [ids.done, seq]
      );
    await insert(1);
    await expect(insert(2)).rejects.toMatchObject({ code: '23505', constraint: 'control_plane_requests_terminal' });
  });

  it('accepts one report per dispatch', async () => {
    const [dispatch] = await q<{ id: string }>(
      `INSERT INTO dispatches (task_id, phase, purpose, cycle, round, agent_id, timeout_ms)
       VALUES ($1, 'explore', 'explore', 0, 0, $2, 600000) RETURNING id`,
      [ids.task, ids.agent]
    );
    const report = () =>
      q(`INSERT INTO dispatch_reports (dispatch_id, run_id, epoch, tool, report) VALUES ($1, $2, 1, 'submit_exploration', '{}')`, [
        dispatch!.id,
        ids.done,
      ]);
    await report();
    await expect(report()).rejects.toMatchObject({ code: '23505', constraint: 'dispatch_reports_dispatch' });
  });
});
