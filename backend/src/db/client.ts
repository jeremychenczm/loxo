import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { config } from '../config';
import * as schema from './schema';

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.dbPoolMax,
  connectionTimeoutMillis: config.dbConnectTimeoutMs,
});
export const db = drizzle(pool, { schema });

export type Db = typeof db;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/**
 * The pool or an open transaction. Helpers that may run inside a transaction
 * take one, so a caller holding row locks never borrows a second connection.
 */
export type Executor = Db | Tx;

export async function closeDb(): Promise<void> {
  await pool.end();
}
