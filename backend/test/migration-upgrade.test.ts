import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Upgrades a database that holds pre-reshape data: migrate up to the last
 * pre-reshape migration, seed rows in the old shape, then apply the rest.
 */
const ADMIN_URL = 'postgres://postgres:postgres@localhost:5434/postgres';
const DB_NAME = 'swarmdev_upgrade_test';
const DB_URL = `postgres://postgres:postgres@localhost:5434/${DB_NAME}`;
const MIGRATIONS = path.resolve('drizzle');
const LAST_LEGACY_MIGRATION = 26;

let pool: pg.Pool;
let partialFolder = '';

/** Copy of the migrations folder that stops at `lastIdx`. */
function truncatedMigrations(lastIdx: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmdev-migrations-'));
  const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS, 'meta/_journal.json'), 'utf8'));
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= lastIdx);
  fs.mkdirSync(path.join(dir, 'meta'));
  fs.writeFileSync(path.join(dir, 'meta/_journal.json'), JSON.stringify(journal));
  for (const entry of journal.entries as { tag: string }[]) {
    fs.copyFileSync(path.join(MIGRATIONS, `${entry.tag}.sql`), path.join(dir, `${entry.tag}.sql`));
  }
  return dir;
}

async function recreateDatabase(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  await admin.end();
}

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await pool.query(sql, params)).rows as T[];

const ids = {
  user: '00000000-0000-4000-8000-000000000001',
  groupA: '00000000-0000-4000-8000-0000000000a1',
  groupB: '00000000-0000-4000-8000-0000000000a2',
  agent1: '00000000-0000-4000-8000-0000000000b1',
  agent2: '00000000-0000-4000-8000-0000000000b2',
  agent3: '00000000-0000-4000-8000-0000000000b3',
  project: '00000000-0000-4000-8000-0000000000c1',
  issue: '00000000-0000-4000-8000-0000000000d1',
  run: '00000000-0000-4000-8000-0000000000e1',
  conversation: '00000000-0000-4000-8000-0000000000f1',
  workspace: '00000000-0000-4000-8000-0000000000f2',
};

async function seedLegacyRows(): Promise<void> {
  await q(
    `INSERT INTO users (id, email, username, password_hash) VALUES ($1, 'legacy@example.com', 'legacy', 'x')`,
    [ids.user]
  );
  await q(
    `INSERT INTO agent_groups (id, user_id, name) VALUES ($1, $3, 'Research'), ($2, $3, 'Empty')`,
    [ids.groupA, ids.groupB, ids.user]
  );
  await q(
    `INSERT INTO agents (id, user_id, name, runtime, group_id, created_at) VALUES
      ($1, $4, 'First', 'api', $5, now() - interval '2 minutes'),
      ($2, $4, 'Second', 'api', $5, now() - interval '1 minute'),
      ($3, $4, 'Loner', 'api', NULL, now())`,
    [ids.agent1, ids.agent2, ids.agent3, ids.user, ids.groupA]
  );
  await q(`UPDATE users SET issue_counter = 7 WHERE id = $1`, [ids.user]);
  await q(`INSERT INTO projects (id, user_id, name) VALUES ($1, $2, 'Legacy')`, [ids.project, ids.user]);
  await q(
    `INSERT INTO issues (id, user_id, project_id, issue_number, title, description, status, assignee_agent_id)
     VALUES ($1, $2, $3, 7, 'Port the exporter', 'CSV first', 'in_progress', $4)`,
    [ids.issue, ids.user, ids.project, ids.agent1]
  );
  await q(
    `INSERT INTO issue_comments (issue_id, author_type, author_user_id, body) VALUES ($1, 'human', $2, 'Please add tests')`,
    [ids.issue, ids.user]
  );
  await q(
    `INSERT INTO runs (id, user_id, agent_id, agent_name, issue_id, trigger, status)
     VALUES ($1, $2, $3, 'First', $4, 'assignment', 'succeeded')`,
    [ids.run, ids.user, ids.agent1, ids.issue]
  );
  await q(`INSERT INTO conversations (id, user_id, agent_id) VALUES ($1, $2, $3)`, [
    ids.conversation,
    ids.user,
    ids.agent1,
  ]);
  await q(
    `INSERT INTO messages (conversation_id, role, content, meta) VALUES ($1, 'system', 'Filed', $2)`,
    [ids.conversation, JSON.stringify({ source: 'filing', issueId: ids.issue })]
  );
  const [binding] = await q<{ id: string }>(
    `INSERT INTO project_repositories (user_id, project_id, location) VALUES ($1, $2, 'server') RETURNING id`,
    [ids.user, ids.project]
  );
  await q(
    `INSERT INTO execution_workspaces
       (id, user_id, project_id, issue_id, repository_id, location, worktree_path, branch_name, base_ref, base_commit, status)
     VALUES ($1, $2, $3, $4, $5, 'server', '/legacy/worktree', 'swarmdev/issue-7-000000', 'main', $6, 'merged')`,
    [ids.workspace, ids.user, ids.project, ids.issue, binding!.id, 'a'.repeat(40)]
  );
}

beforeAll(async () => {
  await recreateDatabase();
  pool = new pg.Pool({ connectionString: DB_URL });
  partialFolder = truncatedMigrations(LAST_LEGACY_MIGRATION);
  await migrate(drizzle(pool), { migrationsFolder: partialFolder });
  await seedLegacyRows();
  await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  fs.rmSync(partialFolder, { recursive: true, force: true });
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await admin.end();
});

describe('migration upgrade from the pre-reshape schema', () => {
  it('turns agent groups into crews with members in creation order', async () => {
    const crews = await q<{ id: string; name: string }>(`SELECT id, name FROM crews ORDER BY name`);
    expect(crews).toEqual([
      { id: ids.groupB, name: 'Empty' },
      { id: ids.groupA, name: 'Research' },
    ]);
    const members = await q<{ agent_id: string; position: number }>(
      `SELECT agent_id, position FROM crew_members WHERE crew_id = $1 ORDER BY position`,
      [ids.groupA]
    );
    expect(members).toEqual([
      { agent_id: ids.agent1, position: 0 },
      { agent_id: ids.agent2, position: 1 },
    ]);
    const agents = await q(`SELECT count(*)::int AS n FROM agents`);
    expect(agents[0]).toEqual({ n: 3 });
  });

  it('carries issues over as tasks with their number, brief, and history', async () => {
    const [task] = await q(`SELECT number, title, brief, status FROM tasks WHERE id = $1`, [ids.issue]);
    expect(task).toEqual({ number: 7, title: 'Port the exporter', brief: 'CSV first', status: 'in_progress' });
    const [user] = await q(`SELECT task_counter FROM users WHERE id = $1`, [ids.user]);
    expect(user).toEqual({ task_counter: 7 });
    const [run] = await q(`SELECT task_id FROM runs WHERE id = $1`, [ids.run]);
    expect(run).toEqual({ task_id: ids.issue });
    const [message] = await q<{ meta: Record<string, string> }>(
      `SELECT meta FROM messages WHERE conversation_id = $1`,
      [ids.conversation]
    );
    expect(message!.meta).toEqual({ source: 'filing', taskId: ids.issue });
  });

  it('detaches tasks and workspaces from the removed project bindings', async () => {
    const [task] = await q(`SELECT repository_id FROM tasks WHERE id = $1`, [ids.issue]);
    expect(task).toEqual({ repository_id: null });
    const [workspace] = await q(
      `SELECT task_id, repository_id, status FROM execution_workspaces WHERE id = $1`,
      [ids.workspace]
    );
    expect(workspace).toEqual({ task_id: ids.issue, repository_id: null, status: 'merged' });
    const repositories = await q(`SELECT 1 FROM repositories`);
    expect(repositories).toHaveLength(0);
    const legacy = await q(
      `SELECT table_name FROM information_schema.tables
       WHERE table_name IN ('projects', 'project_agents', 'project_repositories')`
    );
    expect(legacy).toHaveLength(0);
  });

  it('drops the legacy grouping storage', async () => {
    const tables = await q(`SELECT 1 FROM information_schema.tables WHERE table_name = 'agent_groups'`);
    expect(tables).toHaveLength(0);
    const columns = await q(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'agents' AND column_name = 'group_id'`
    );
    expect(columns).toHaveLength(0);
  });
});
