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

  it('drops the legacy grouping storage', async () => {
    const tables = await q(`SELECT 1 FROM information_schema.tables WHERE table_name = 'agent_groups'`);
    expect(tables).toHaveLength(0);
    const columns = await q(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'agents' AND column_name = 'group_id'`
    );
    expect(columns).toHaveLength(0);
  });
});
