import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upgradeDatabase, type Query, type UpgradedDatabase } from './support/upgrade-db';

/**
 * Upgrades a database written by a backend without run leases while one run
 * was still marked running (the backend died mid-turn before the upgrade).
 */
const LAST_PRE_LEASE_MIGRATION = 34;

const ids = {
  user: '00000000-0000-4000-8000-000000000001',
  busy: '00000000-0000-4000-8000-0000000000b1',
  task: '00000000-0000-4000-8000-0000000000d1',
  running: '00000000-0000-4000-8000-0000000000e1',
  done: '00000000-0000-4000-8000-0000000000e2',
};

let upgraded: UpgradedDatabase;
const q: Query = (sql, params) => upgraded.q(sql, params);

async function seed(q: Query): Promise<void> {
  await q(`INSERT INTO users (id, email, username, password_hash) VALUES ($1, 'l@example.com', 'l', 'x')`, [
    ids.user,
  ]);
  await q(
    `INSERT INTO agents (id, user_id, name, runtime, status) VALUES ($1, $2, 'Busy', 'api', 'busy')`,
    [ids.busy, ids.user]
  );
  await q(`INSERT INTO tasks (id, user_id, number, title) VALUES ($1, $2, 1, 'Stuck')`, [ids.task, ids.user]);
  await q(
    `INSERT INTO runs (id, user_id, agent_id, agent_name, task_id, trigger, status, started_at, finished_at) VALUES
      ($1, $3, $4, 'Busy', $5, 'assignment', 'running', now(), NULL),
      ($2, $3, $4, 'Busy', $5, 'assignment', 'succeeded', now() - interval '1 hour', now() - interval '50 minutes')`,
    [ids.running, ids.done, ids.user, ids.busy, ids.task]
  );
  await q(`UPDATE tasks SET active_run_id = $1 WHERE id = $2`, [ids.running, ids.task]);
}

beforeAll(async () => {
  upgraded = await upgradeDatabase('swarmdev_upgrade_lease_test', LAST_PRE_LEASE_MIGRATION, seed);
}, 120_000);

afterAll(async () => {
  await upgraded?.drop();
});

describe('migration to run leases', () => {
  it('gives a run left running an already-expired lease the reconciler will take over', async () => {
    const [row] = await q<{ owner_instance: string; owner_epoch: number; expired: boolean; attempt: number }>(
      `SELECT owner_instance, owner_epoch, lease_expires_at <= now() AS expired, attempt FROM runs WHERE id = $1`,
      [ids.running]
    );
    expect(row).toEqual({ owner_instance: 'pre-lease', owner_epoch: 0, expired: true, attempt: 1 });
  });

  it('leaves finished runs without an owner', async () => {
    const [row] = await q(`SELECT owner_instance, lease_expires_at, parent_run_id FROM runs WHERE id = $1`, [ids.done]);
    expect(row).toEqual({ owner_instance: null, lease_expires_at: null, parent_run_id: null });
  });

  it('adds the retry back-off and request ownership columns empty', async () => {
    const [run] = await q(`SELECT not_before FROM runs WHERE id = $1`, [ids.running]);
    expect(run).toEqual({ not_before: null });
    const columns = await q(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'human_requests' AND column_name = 'run_id'`
    );
    expect(columns).toHaveLength(1);
  });
});
