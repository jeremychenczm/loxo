import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import type { CrashPoint } from '../../src/modules/ownership/crash-points';
import {
  Api,
  createTrialDatabase,
  CYCLE_MS,
  dropTrialDatabase,
  initRepository,
  isAlive,
  killTree,
  LEASE_TTL_MS,
  MAX_ATTEMPTS,
  MAX_BACKOFF_MS,
  seededRandom,
  sleep,
  startInstance,
  writeAgentScript,
  type Instance,
} from './infra';
import { checkInvariants, readExecutions, type Violation } from './invariants';
import { RUN_KIND_SPECS, type RunKind, type RunKindSpec } from './scenarios';

/**
 * One chaos trial: a backend instance is made to die mid-run, the next one
 * recovers, and at a fixed check time the invariant checker reads the trial's
 * own database and the agents' witness logs.
 */

export interface NamedFault {
  point: CrashPoint;
  hit?: number;
}

export interface TrialSpec {
  kind: RunKind;
  /** Where the first instance dies: at a named point, or killed from outside at a random moment of the run. */
  first: NamedFault | 'random';
  /** Where the instance recovering from the first crash dies too. */
  second?: NamedFault;
  /** Answer the interrupted run's retry request with this once it opens (and again after a crash). */
  answer?: 'continue' | 'discard' | 'stop';
  /** False starts agents without the launcher: the control that shows what an orphan does. */
  launcher?: boolean;
  seed: number;
}

export interface TrialResult {
  id: string;
  kind: RunKind;
  fault: string;
  launcher: boolean;
  seed: number;
  /** Each run at the check, oldest first, as status or status/recovery class. */
  runs: string[];
  /** Every armed crash point fired. */
  reached: boolean;
  crashes: number;
  killDelayMs: number | null;
  /** Last crash until the next instance answered /health. */
  restartMs: number | null;
  /** Longest an agent kept working after the backend it worked for died. */
  afterlifeMs: number | null;
  /** Last crash until every run the dead instance owned had left running. */
  recoveredMs: number | null;
  /** Last crash until every wake had settled: final, or waiting on a person. */
  settledMs: number | null;
  violations: Violation[];
  fenceRejections: number;
  /** Agent or launcher processes still alive after the trial's instances were gone. */
  leftovers: number[];
  error: string | null;
  startedAt: string;
  durationMs: number;
}

const CHECK_SLACK_MS = 6_000;
const POLL_MS = 200;

const faultValue = (fault: NamedFault) => `${fault.point}@${fault.hit ?? 1}`;

export function faultLabel(spec: TrialSpec): string {
  const first = spec.first === 'random' ? 'random' : faultValue(spec.first);
  const second = spec.second ? `+${faultValue(spec.second)}` : '';
  const answer = spec.answer ? `/${spec.answer}` : '';
  return `${first}${second}${answer}`;
}

class Unreached extends Error {}

interface TrialPaths {
  dir: string;
  storage: string;
  witness: string;
  logs: string;
  repo: string;
  agent: string;
  crashLog: string;
}

interface Setup {
  taskId: string | null;
  wakeAccepted: boolean;
}

async function setUp(api: Api, kind: RunKindSpec, paths: TrialPaths, id: string, setup: Setup): Promise<void> {
  const reg = await api.call<{ token: string }>('POST', '/auth/register', {
    email: `chaos-${id}@example.com`,
    username: `chaos${id}`,
    password: 'chaos-trial-password',
  });
  api.token = reg.token;
  const { agent } = await api.call<{ agent: { id: string } }>('POST', '/api/agents', {
    name: 'Chaos agent',
    runtime: 'claude-code',
  });
  let repositoryId: string | undefined;
  if (kind.repository) {
    initRepository(paths.repo);
    const { repository } = await api.call<{ repository: { id: string } }>('POST', '/api/repositories', {
      rootPath: paths.repo,
    });
    repositoryId = repository.id;
  }
  const { task } = await api.call<{ task: { id: string } }>('POST', '/api/tasks', {
    title: `Chaos trial ${id}`,
    leadAgentId: agent.id,
    ...(repositoryId ? { repositoryId } : {}),
  });
  setup.taskId = task.id;
  // Entering todo wakes the lead through the outbox, as a person dragging the card does.
  await api.call('POST', `/api/tasks/${task.id}/move`, { status: 'todo' });
  setup.wakeAccepted = true;
}

/** Resolves with the exit, or null when the instance is still up at the deadline. */
async function exitWithin(instance: Instance, ms: number) {
  return Promise.race([instance.exit, sleep(ms).then(() => null)]);
}

function crashRecord(file: string, nth: number, point: string): number {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  const record = lines[nth - 1] ? (JSON.parse(lines[nth - 1]!) as { point: string; at: string }) : null;
  if (!record) throw new Unreached(`crash point ${point} not reached`);
  if (record.point !== point) throw new Error(`expected a crash at ${point}, the log says ${record.point}`);
  return Date.parse(record.at);
}

async function runningRuns(db: pg.Pool): Promise<string[]> {
  return (await db.query<{ id: string }>("SELECT id FROM runs WHERE status = 'running'")).rows.map((r) => r.id);
}

async function stillRunning(db: pg.Pool, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const { rows } = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM runs WHERE id = ANY($1::uuid[]) AND status = 'running'",
    [ids]
  );
  return rows[0]!.n;
}

async function hasSettled(db: pg.Pool): Promise<boolean> {
  const { rows } = await db.query<{ settled: boolean }>(
    `SELECT NOT EXISTS (SELECT 1 FROM runs WHERE status IN ('queued', 'running'))
       AND NOT EXISTS (
         SELECT 1 FROM runs r WHERE r.status = 'interrupted' AND NOT EXISTS (
           SELECT 1 FROM human_requests h WHERE h.run_id = r.id AND h.kind = 'retry' AND h.status = 'open'))
       AS settled`
  );
  return rows[0]!.settled;
}

async function openRetryRequest(db: pg.Pool): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM human_requests WHERE kind = 'retry' AND status = 'open' LIMIT 1"
  );
  return rows[0]?.id ?? null;
}

/** Waits for the retry request and answers it; an instance dying mid-answer is the point of some trials. */
async function answerRetry(api: Api, db: pg.Pool, choice: string, instance: Instance): Promise<number | null> {
  const deadline = Date.now() + LEASE_TTL_MS + 2 * CYCLE_MS + 30_000;
  while (Date.now() < deadline && !instance.hasExited()) {
    const requestId = await openRetryRequest(db);
    if (requestId) {
      await api.call('POST', `/api/human-requests/${requestId}/answer`, { choice }).catch(async (err) => {
        if (!(await exitWithin(instance, 2_000))) throw err;
      });
      return Date.now();
    }
    await sleep(POLL_MS);
  }
  if (instance.hasExited()) return null;
  throw new Error('no retry request opened to answer');
}

function witnessStarted(dir: string): boolean {
  return fs.readdirSync(dir).some((file) => fs.readFileSync(path.join(dir, file), 'utf8').includes('"start"'));
}

function countFenceRejections(instances: Instance[]): number {
  return instances.reduce((n, instance) => {
    const text = fs.existsSync(instance.stderrFile) ? fs.readFileSync(instance.stderrFile, 'utf8') : '';
    return n + (text.match(/"event":"fence_rejected"/g)?.length ?? 0);
  }, 0);
}

/** Agent and launcher processes the trial started, by the pids its witness logs and runs recorded. */
async function trialProcesses(db: pg.Pool, witnessDir: string): Promise<number[]> {
  const agents = fs.readdirSync(witnessDir).map((file) => Number(path.basename(file, '.jsonl')));
  const { rows } = await db.query<{ pid: number }>('SELECT DISTINCT launcher_pid AS pid FROM runs WHERE launcher_pid IS NOT NULL');
  return [...new Set([...agents, ...rows.map((r) => r.pid)])].filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function keepEvidence(db: pg.Pool, paths: TrialPaths, target: string): Promise<void> {
  fs.mkdirSync(target, { recursive: true });
  for (const dir of [paths.logs, paths.witness]) {
    fs.cpSync(dir, path.join(target, path.basename(dir)), { recursive: true });
  }
  if (fs.existsSync(paths.crashLog)) fs.copyFileSync(paths.crashLog, path.join(target, 'crashes.jsonl'));
  const tables: Record<string, unknown[]> = {};
  for (const table of ['runs', 'human_requests', 'workspaces', 'control_plane_requests', 'turns', 'run_events', 'change_snapshots']) {
    tables[table] = (
      await db.query(`SELECT *, pg_xact_commit_timestamp(xmin) AS committed_at FROM ${table}`).catch(() => ({ rows: [] }))
    ).rows;
  }
  fs.writeFileSync(path.join(target, 'tables.json'), JSON.stringify(tables, null, 2));
}

export interface TrialOptions {
  /** Where a trial with violations or an error leaves its logs and table dump. */
  failuresDir?: string;
}

export async function runTrial(spec: TrialSpec, options: TrialOptions = {}): Promise<TrialResult> {
  const started = Date.now();
  const id = `${started.toString(36)}${crypto.randomBytes(2).toString('hex')}`;
  const kind = RUN_KIND_SPECS[spec.kind];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `loxo-chaos-${id}-`));
  const paths: TrialPaths = {
    dir,
    storage: path.join(dir, 'storage'),
    witness: path.join(dir, 'witness'),
    logs: path.join(dir, 'logs'),
    repo: path.join(dir, 'repo'),
    agent: path.join(dir, 'agent.mjs'),
    crashLog: path.join(dir, 'crashes.jsonl'),
  };
  for (const sub of [paths.storage, paths.witness, paths.logs]) fs.mkdirSync(sub, { recursive: true });
  writeAgentScript(paths.agent, kind.scenario(id), paths.witness);

  const result: TrialResult = {
    id,
    kind: spec.kind,
    fault: faultLabel(spec),
    launcher: spec.launcher !== false,
    seed: spec.seed,
    runs: [],
    reached: false,
    crashes: 0,
    killDelayMs: null,
    restartMs: null,
    afterlifeMs: null,
    recoveredMs: null,
    settledMs: null,
    violations: [],
    fenceRejections: 0,
    leftovers: [],
    error: null,
    startedAt: new Date(started).toISOString(),
    durationMs: 0,
  };
  const database = await createTrialDatabase(id);
  const db = new pg.Pool({ connectionString: database.url, max: 2 });
  const instances: Instance[] = [];
  const launch = async (label: string, fault?: NamedFault) => {
    const instance = await startInstance({
      label,
      databaseUrl: database.url,
      storageRoot: paths.storage,
      agentCommand: paths.agent,
      logDir: paths.logs,
      crashLog: paths.crashLog,
      crashAt: fault ? faultValue(fault) : undefined,
      launcher: spec.launcher,
    });
    instances.push(instance);
    return instance;
  };
  const exitBudget = kind.durationMs * 2 + LEASE_TTL_MS + 2 * CYCLE_MS + 30_000;

  try {
    const setup: Setup = { taskId: null, wakeAccepted: false };
    const first = await launch('i1', spec.first === 'random' ? undefined : spec.first);
    const api = new Api(first.baseUrl);
    await setUp(api, kind, paths, id, setup).catch(async (err) => {
      // A crash point may fire inside a setup request; anything else is a driver failure.
      if (!(await exitWithin(first, 2_000))) throw err;
    });

    const deaths: { via: string; at: number }[] = [];
    let crashAt: number;
    if (spec.first === 'random') {
      const deadline = Date.now() + 60_000;
      while (!witnessStarted(paths.witness)) {
        if (Date.now() > deadline || first.hasExited()) throw new Error('the agent never started its turn');
        await sleep(50);
      }
      const delay = Math.round(300 + seededRandom(spec.seed)() * (kind.durationMs - 1_000));
      result.killDelayMs = delay;
      await sleep(delay);
      first.kill();
      crashAt = Date.now();
      await first.exit;
    } else {
      if (!(await exitWithin(first, exitBudget))) throw new Unreached(`crash point ${spec.first.point} not reached`);
      crashAt = crashRecord(paths.crashLog, 1, spec.first.point);
    }
    deaths.push({ via: new URL(first.baseUrl).host, at: crashAt });
    result.crashes = 1;
    let owned = await runningRuns(db);

    let last = await launch('i2', spec.second);
    api.baseUrl = last.baseUrl;
    let answeredAt: number | null = null;
    if (spec.answer) answeredAt = await answerRetry(api, db, spec.answer, last);
    if (spec.second) {
      if (!(await exitWithin(last, exitBudget))) throw new Unreached(`crash point ${spec.second.point} not reached`);
      crashAt = crashRecord(paths.crashLog, 2, spec.second.point);
      deaths.push({ via: new URL(last.baseUrl).host, at: crashAt });
      result.crashes = 2;
      owned = await runningRuns(db);
      last = await launch('i3');
      api.baseUrl = last.baseUrl;
      if (spec.answer && (await openRetryRequest(db))) answeredAt = await answerRetry(api, db, spec.answer, last);
    }
    result.reached = true;
    result.restartMs = last.readyAt - crashAt;

    // The check runs at a fixed time, not "once things look settled"; until then convergence is only timed.
    const checkAt =
      Math.max(crashAt + LEASE_TTL_MS, last.readyAt, answeredAt ?? 0) +
      2 * CYCLE_MS +
      MAX_BACKOFF_MS +
      kind.durationMs +
      CHECK_SLACK_MS;
    while (Date.now() < checkAt) {
      if (last.hasExited()) throw new Error(`instance ${last.label} exited before the check`);
      const now = Date.now();
      if (result.recoveredMs === null && owned.length > 0 && (await stillRunning(db, owned)) === 0) {
        result.recoveredMs = now - crashAt;
      }
      if (result.settledMs === null && (await hasSettled(db))) result.settledMs = now - crashAt;
      await sleep(POLL_MS);
    }

    result.runs = (
      await db.query<{ status: string; recovery_class: string | null }>(
        'SELECT status, recovery_class FROM runs ORDER BY created_at, attempt'
      )
    ).rows.map((r) => (r.recovery_class ? `${r.status}/${r.recovery_class}` : r.status));
    const roots = (await db.query<{ id: string; task_id: string }>('SELECT id, task_id FROM runs WHERE parent_run_id IS NULL'))
      .rows;
    result.violations = await checkInvariants({
      db,
      wakeRuns: roots.map((r) => r.id),
      witnessDir: paths.witness,
      // Generous on purpose: a run promoted a moment before the check is not stuck.
      cycleMs: LEASE_TTL_MS,
      deaths,
      maxAttempts: MAX_ATTEMPTS,
    });
    const afterlives = readExecutions(paths.witness).flatMap((e) =>
      deaths.filter((d) => d.via === e.via && e.start <= d.at).map((d) => Math.max(0, e.end - d.at))
    );
    result.afterlifeMs = afterlives.length > 0 ? Math.max(...afterlives) : null;
    if (setup.wakeAccepted && setup.taskId && !roots.some((r) => r.task_id === setup.taskId)) {
      result.violations.push({ invariant: 'INV-8', subject: setup.taskId, detail: 'accepted wake left no run' });
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    for (const instance of instances) instance.kill();
    await Promise.all(instances.map((instance) => instance.exit));
    const pids = await trialProcesses(db, paths.witness).catch(() => []);
    const deadline = Date.now() + 5_000;
    while (pids.some(isAlive) && Date.now() < deadline) await sleep(100);
    result.leftovers = pids.filter(isAlive);
    for (const pid of result.leftovers) killTree(pid);
    result.fenceRejections = countFenceRejections(instances);
    if ((result.error || result.violations.length > 0) && options.failuresDir) {
      await keepEvidence(db, paths, path.join(options.failuresDir, id)).catch(() => {});
    }
    await db.end();
    await dropTrialDatabase(database.name);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    result.durationMs = Date.now() - started;
  }
  return result;
}
