import 'dotenv/config';
import path from 'node:path';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5434/swarmdev',
  dbPoolMax: Number(process.env.DB_POOL_MAX ?? 20),
  /** How long a query waits for a free pool connection before failing instead of hanging. */
  dbConnectTimeoutMs: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 10_000),
  /** Run lease length on the database clock; owners renew every third of it. */
  runLeaseTtlMs: Number(process.env.RUN_LEASE_TTL_MS ?? 30_000),
  /** Attempts a run that lost its owner before committing anything gets in total. */
  runMaxAttempts: Number(process.env.RUN_MAX_ATTEMPTS ?? 3),
  /** Delay before the first automatic retry; it doubles with every further attempt. */
  runRetryBackoffMs: Number(process.env.RUN_RETRY_BACKOFF_MS ?? 5_000),
  /** How long an interrupted run waits for a person's decision before it is stopped. */
  retryDecisionTtlMs: Number(process.env.RETRY_DECISION_TTL_MS ?? 24 * 60 * 60_000),
  corsOrigins: (process.env.CORS_ORIGIN ?? 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  jwtSecret: () => required('JWT_SECRET'),
  secretsKey: () => required('SECRETS_KEY'),
  /** Control-plane URL handed to agent runtimes; override when agents run off-host. */
  mcpUrl: () =>
    process.env.MCP_PUBLIC_URL ?? `http://127.0.0.1:${Number(process.env.PORT ?? 4000)}/mcp`,
  /**
   * Directories a registered repository must live under. Empty means any
   * host path is accepted, which suits single-user local installs.
   */
  repositoryRoots: (): string[] =>
    (process.env.REPOSITORY_ROOTS ?? '')
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => path.resolve(entry)),
};

/** Fails fast at boot; individual modules use the lazy getters above. */
export function assertRequiredEnv(): void {
  config.jwtSecret();
  config.secretsKey();
}
