import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

const ADMIN_URL = 'postgres://postgres:postgres@localhost:5434/postgres';
const MIGRATIONS = path.resolve('drizzle');

export type Query = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;

export interface UpgradedDatabase {
  q: Query;
  drop(): Promise<void>;
}

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

async function admin(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: ADMIN_URL });
  await client.connect();
  await client.query(sql);
  await client.end();
}

/**
 * Fresh database migrated up to `lastIdx`, seeded in that older shape, then
 * migrated to the latest schema: the path a long-lived install takes.
 */
export async function upgradeDatabase(
  name: string,
  lastIdx: number,
  seed: (q: Query) => Promise<void>
): Promise<UpgradedDatabase> {
  await admin(`DROP DATABASE IF EXISTS ${name}`);
  await admin(`CREATE DATABASE ${name}`);
  const pool = new pg.Pool({ connectionString: `postgres://postgres:postgres@localhost:5434/${name}` });
  const q: Query = async (sql, params = []) => (await pool.query(sql, params)).rows;
  const partial = truncatedMigrations(lastIdx);
  try {
    await migrate(drizzle(pool), { migrationsFolder: partial });
    await seed(q);
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });
  } catch (err) {
    await pool.end();
    throw err;
  } finally {
    fs.rmSync(partial, { recursive: true, force: true });
  }
  return {
    q,
    async drop() {
      await pool.end();
      await admin(`DROP DATABASE IF EXISTS ${name}`);
    },
  };
}
