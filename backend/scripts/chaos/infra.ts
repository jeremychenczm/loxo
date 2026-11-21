import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FAKE_AGENT_ENTRY, type Scenario } from '@swarmdev/fake-agent';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/** Building blocks of a chaos trial: databases, backend instances, the HTTP API, agent processes. */

export const CHAOS_ADMIN_URL = process.env.CHAOS_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5435/postgres';
export const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Short leases keep a trial to about half a minute; the self-fence margin (kill budget plus
// 1 s of timer jitter) must stay under half the ttl, and killing a launcher's job takes milliseconds.
export const LEASE_TTL_MS = 4_000;
export const KILL_BUDGET_MS = 800;
export const RETRY_BACKOFF_MS = 500;
export const MAX_ATTEMPTS = 3;
/** Longest reconciler period: half the ttl plus up to a tenth of it in jitter. */
export const CYCLE_MS = Math.ceil(LEASE_TTL_MS * 0.6);
/** Back-off before the last automatic retry. */
export const MAX_BACKOFF_MS = RETRY_BACKOFF_MS * 2 ** (MAX_ATTEMPTS - 2);

const TEMPLATE = 'chaos_template';
const TRIAL_DB_PREFIX = 'chaos_t_';
// Run tokens are signed with this; every instance of a trial must share it.
const SECRETS_KEY = crypto.randomBytes(32).toString('base64');

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withAdmin<T>(fn: (admin: pg.Client) => Promise<T>): Promise<T> {
  const admin = new pg.Client({ connectionString: CHAOS_ADMIN_URL, connectionTimeoutMillis: 5_000 });
  await admin.connect();
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

function databaseUrl(name: string): string {
  const url = new URL(CHAOS_ADMIN_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

/** Checks the chaos server, clears what earlier runs left, and migrates the trial template once. */
export async function prepareTemplate(): Promise<void> {
  await withAdmin(async (admin) => {
    const { rows } = await admin.query<{ on: string }>("SELECT current_setting('track_commit_timestamp') AS on");
    if (rows[0]?.on !== 'on') throw new Error('The chaos server needs track_commit_timestamp = on');
    const stale = await admin.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname = $1 OR datname LIKE $2`,
      [TEMPLATE, `${TRIAL_DB_PREFIX}%`]
    );
    for (const { datname } of stale.rows) await admin.query(`DROP DATABASE ${datname} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEMPLATE}`);
  });
  const pool = new pg.Pool({ connectionString: databaseUrl(TEMPLATE), max: 2 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: path.join(BACKEND_DIR, 'drizzle') });
  } finally {
    await pool.end();
  }
}

export async function createTrialDatabase(id: string): Promise<{ name: string; url: string }> {
  const name = `${TRIAL_DB_PREFIX}${id}`;
  await withAdmin((admin) => admin.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE}`));
  return { name, url: databaseUrl(name) };
}

export async function dropTrialDatabase(name: string): Promise<void> {
  await withAdmin((admin) => admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

export interface InstanceSpec {
  label: string;
  databaseUrl: string;
  storageRoot: string;
  /** Script the backend starts as the claude-code ACP adapter. */
  agentCommand: string;
  logDir: string;
  crashLog: string;
  /** LOXO_CRASH_AT value. */
  crashAt?: string;
  /** LOXO_STALL_AT value. */
  stallAt?: string;
  /** False starts agents directly, without the launcher (control trials). */
  launcher?: boolean;
  /** Database pool size; more concurrent runs need more. */
  poolMax?: number;
}

export interface InstanceExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  at: number;
}

export interface Instance {
  label: string;
  pid: number;
  baseUrl: string;
  readyAt: number;
  stderrFile: string;
  exit: Promise<InstanceExit>;
  hasExited(): boolean;
  /** Ends the process at once, as kill -9 does; agents go with it only if the launcher takes them. */
  kill(): void;
  /**
   * Asks for a graceful shutdown, as a deploy does: SIGTERM on POSIX, a
   * message over IPC on Windows, where a signal from outside cannot be caught.
   */
  shutdown(): void;
}

/** Starts one backend process the way production does, without npm or a file watcher, and waits for /health. */
export async function startInstance(spec: InstanceSpec): Promise<Instance> {
  const port = await freePort();
  const stdoutFile = path.join(spec.logDir, `${spec.label}.out.log`);
  const stderrFile = path.join(spec.logDir, `${spec.label}.err.log`);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ['LOXO_CRASH_AT', 'LOXO_STALL_AT', 'LOXO_AGENT_LAUNCHER', 'MCP_PUBLIC_URL', 'REPOSITORY_ROOTS']) {
    delete env[key];
  }
  Object.assign(env, {
    PORT: String(port),
    DATABASE_URL: spec.databaseUrl,
    DB_POOL_MAX: String(spec.poolMax ?? 10),
    JWT_SECRET: 'chaos-trial-jwt-secret',
    SECRETS_KEY,
    STORAGE_ROOT: spec.storageRoot,
    LOXO_CLAUDE_ACP_COMMAND: spec.agentCommand,
    RUN_LEASE_TTL_MS: String(LEASE_TTL_MS),
    RUN_KILL_BUDGET_MS: String(KILL_BUDGET_MS),
    RUN_RETRY_BACKOFF_MS: String(RETRY_BACKOFF_MS),
    RUN_MAX_ATTEMPTS: String(MAX_ATTEMPTS),
    LOXO_CRASH_LOG: spec.crashLog,
    ...(spec.crashAt ? { LOXO_CRASH_AT: spec.crashAt } : {}),
    ...(spec.stallAt ? { LOXO_STALL_AT: spec.stallAt } : {}),
    ...(spec.launcher === false ? { LOXO_AGENT_LAUNCHER: 'off' } : {}),
  });
  const out = fs.openSync(stdoutFile, 'a');
  const err = fs.openSync(stderrFile, 'a');
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: BACKEND_DIR,
    env,
    stdio: ['ignore', out, err, 'ipc'],
    windowsHide: true,
  });
  // The channel is only for shutdown(); it must not keep this process alive.
  child.channel?.unref();
  fs.closeSync(out);
  fs.closeSync(err);
  let exited = false;
  const exit = new Promise<InstanceExit>((resolve) => {
    child.once('exit', (code, signal) => {
      exited = true;
      resolve({ code, signal, at: Date.now() });
    });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (exited) break;
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1_000) });
      if (res.ok) {
        return {
          label: spec.label,
          pid: child.pid!,
          baseUrl,
          readyAt: Date.now(),
          stderrFile,
          exit,
          hasExited: () => exited,
          kill: () => {
            if (!exited) child.kill('SIGKILL');
          },
          shutdown: () => {
            if (exited) return;
            if (process.platform === 'win32') child.send({ type: 'shutdown' });
            else child.kill('SIGTERM');
          },
        };
      }
    } catch {
      // Not listening yet.
    }
    await sleep(100);
  }
  child.kill('SIGKILL');
  const tail = fs.readFileSync(stderrFile, 'utf8').slice(-2_000);
  throw new Error(`Instance ${spec.label} did not become ready${exited ? ' (it exited)' : ''}: ${tail}`);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/** Minimal client for the REST API; the token outlives instances because they share the JWT secret. */
export class Api {
  token = '';

  constructor(public baseUrl: string) {}

  async call<T = Record<string, unknown>>(method: string, route: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${route}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) throw new ApiError(res.status, `${method} ${route} -> ${res.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }
}

/**
 * Writes the script the backend starts as an agent. By default it plays
 * `scenario` behind a shell, the way an npm-installed CLI starts on Windows,
 * so an agent whose backend died without the launcher outlives it as it
 * would for real. `shim: false` loads the agent into the script's own
 * process instead, which saves two processes per agent when many run at once.
 */
export function writeAgentScript(
  file: string,
  scenario: Scenario,
  witnessDir: string,
  options: { shim?: boolean } = {}
): void {
  const resolve = createRequire(path.join(BACKEND_DIR, 'package.json')).resolve;
  if (options.shim === false) {
    const source = `// Chaos agent, generated by the chaos driver.
process.env.LOXO_FAKE_AGENT_SCENARIO = ${JSON.stringify(JSON.stringify(scenario))};
process.env.LOXO_FAKE_AGENT_WITNESS_DIR = ${JSON.stringify(witnessDir)};
const { register } = await import(${JSON.stringify(pathToFileURL(resolve('tsx/esm/api')).href)});
register();
await import(${JSON.stringify(pathToFileURL(FAKE_AGENT_ENTRY).href)});
`;
    fs.writeFileSync(file, source);
    return;
  }
  const tsx = pathToFileURL(resolve('tsx')).href;
  // The agent ignores the trailing pair; it puts this trial on the agent's command line (see stillRunning).
  const args = ['--import', tsx, FAKE_AGENT_ENTRY, '--chaos-agent', file];
  const source = `// Chaos trial agent, generated by the chaos driver.
import { spawn } from 'node:child_process';
const env = {
  ...process.env,
  LOXO_FAKE_AGENT_SCENARIO: ${JSON.stringify(JSON.stringify(scenario))},
  LOXO_FAKE_AGENT_WITNESS_DIR: ${JSON.stringify(witnessDir)},
};
const args = ${JSON.stringify(args)};
const child =
  process.platform === 'win32'
    ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', '"' + [process.execPath, ...args].map((a) => '"' + a + '"').join(' ') + '"'], {
        stdio: 'inherit',
        env,
        windowsVerbatimArguments: true,
      })
    : spawn('/bin/sh', ['-c', '"$0" "$@"; exit $?', process.execPath, ...args], { stdio: 'inherit', env });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
`;
  fs.writeFileSync(file, source);
}

export function initRepository(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Chaos Driver');
  git('config', 'user.email', 'chaos@example.invalid');
  fs.writeFileSync(path.join(dir, 'README.md'), '# chaos trial\n');
  git('add', '.');
  git('commit', '-m', 'initial');
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Kills a process and everything under it that can still be found. */
export function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

/** Command lines of the given pids that still exist; throws when the process table cannot be read. */
function commandLines(pids: number[]): Map<number, string> {
  const lines = new Map<number, string>();
  if (process.platform === 'win32') {
    const filter = pids.map((pid) => `ProcessId=${pid}`).join(' OR ');
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { [string]$_.ProcessId + [char]9 + $_.CommandLine }`,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 30_000 }
    );
    for (const line of out.split(/\r?\n/)) {
      const tab = line.indexOf('\t');
      if (tab > 0) lines.set(Number(line.slice(0, tab)), line.slice(tab + 1));
    }
  } else if (process.platform === 'linux') {
    for (const pid of pids) {
      try {
        lines.set(pid, fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' '));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
  } else {
    let out: string;
    try {
      out = execFileSync('ps', ['-o', 'pid=,command=', '-p', pids.join(',')], { encoding: 'utf8' });
    } catch (err) {
      // ps exits 1 when none of the pids exist.
      out = String((err as { stdout?: string }).stdout ?? '');
    }
    for (const line of out.split('\n')) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (match) lines.set(Number(match[1]), match[2]!);
    }
  }
  return lines;
}

const comparable = (text: string) => (process.platform === 'win32' ? text.replace(/\//g, '\\').toLowerCase() : text);

/**
 * The pids that are still the processes they were: alive, and running a
 * command line that contains `marker`. Windows hands a dead process's pid to
 * a new one within seconds, so liveness alone can name an unrelated process.
 */
export function stillRunning(pids: number[], marker: string): number[] {
  const alive = pids.filter(isAlive);
  if (alive.length === 0) return [];
  const lines = commandLines(alive);
  const needle = comparable(marker);
  return alive.filter((pid) => comparable(lines.get(pid) ?? '').includes(needle));
}

/** Gives the processes `waitMs` to end, then kills and returns the ones still running. */
export async function endLeftovers(pids: number[], marker: string, waitMs = 5_000): Promise<number[]> {
  const until = Date.now() + waitMs;
  let running = stillRunning(pids, marker);
  while (running.length > 0 && Date.now() < until) {
    await sleep(200);
    running = stillRunning(running, marker);
  }
  for (const pid of running) killTree(pid);
  return running;
}

/** Runs `instance` holds now, matched by its owner id (host:pid:random, see ownership/instance.ts). */
export async function runsHeldBy(
  db: pg.Pool,
  instance: Pick<Instance, 'pid'>
): Promise<{ runId: string; epoch: number }[]> {
  const { rows } = await db.query<{ id: string; owner_epoch: number }>(
    "SELECT id, owner_epoch FROM runs WHERE status = 'running' AND owner_instance LIKE $1",
    [`${os.hostname()}:${instance.pid}:%`]
  );
  return rows.map((r) => ({ runId: r.id, epoch: r.owner_epoch }));
}

/** Deterministic random numbers (mulberry32), so a seed reproduces a trial's kill timing. */
export function seededRandom(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}
