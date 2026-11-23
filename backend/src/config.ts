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
  /** Time reserved before the lease ends to stop a run's agent processes; part of the self-fence margin. */
  runKillBudgetMs: Number(process.env.RUN_KILL_BUDGET_MS ?? 3_000),
  /** Attempts a run that lost its owner before committing anything gets in total. */
  runMaxAttempts: Number(process.env.RUN_MAX_ATTEMPTS ?? 3),
  /** Delay before the first automatic retry; it doubles with every further attempt. */
  runRetryBackoffMs: Number(process.env.RUN_RETRY_BACKOFF_MS ?? 5_000),
  /** How long an interrupted run waits for a person's decision before it is stopped. */
  retryDecisionTtlMs: Number(process.env.RETRY_DECISION_TTL_MS ?? 24 * 60 * 60_000),
  /** How long an agent's question on a workshop task stays open for a person. */
  blockerQuestionTtlMs: Number(process.env.BLOCKER_QUESTION_TTL_MS ?? 24 * 60 * 60_000),
  /** Time budget for a read-only workshop dispatch (explore, review, sign-off), counted while it runs. */
  workshopReadOnlyTimeoutMs: Number(process.env.WORKSHOP_READ_ONLY_TIMEOUT_MS ?? 10 * 60_000),
  /** Time budget for a workshop dispatch that writes code. */
  workshopWriteTimeoutMs: Number(process.env.WORKSHOP_WRITE_TIMEOUT_MS ?? 60 * 60_000),
  /** How long the members' explore questions wait for a person; Plan then goes ahead without answers. */
  workshopQuestionsTtlMs: Number(process.env.WORKSHOP_QUESTIONS_TTL_MS ?? 30 * 60_000),
  /** Default number of workshop dispatches running at once. */
  workshopMaxParallelism: Number(process.env.WORKSHOP_MAX_PARALLELISM ?? 4),
  /** Budget for a graceful shutdown, run handoffs included; past it the process exits and crash recovery takes over. */
  shutdownTimeoutMs: Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 25_000),
  /** After asking an agent to stop so its run can be handed off, how long to wait before killing it. */
  runHandoffGraceMs: Number(process.env.RUN_HANDOFF_GRACE_MS ?? 5_000),
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
