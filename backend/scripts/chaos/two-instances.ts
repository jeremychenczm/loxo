import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import {
  Api,
  createTrialDatabase,
  CYCLE_MS,
  dropTrialDatabase,
  endLeftovers,
  isAlive,
  LEASE_TTL_MS,
  MAX_ATTEMPTS,
  MAX_BACKOFF_MS,
  prepareTemplate,
  seededRandom,
  sleep,
  startInstance,
  writeAgentScript,
  type Instance,
} from './infra';
import { checkInvariants, readExecutions, type Violation } from './invariants';

/**
 * Two backend instances on one database, racing for the same queue: many
 * tasks are woken through both APIs at once, and partway through one
 * instance is either killed or frozen past its leases. No run may execute on
 * both, and every write a frozen instance attempts after waking must be
 * refused by the fence.
 *
 *   npm run chaos:two -w backend -- --fault kill
 *   npm run chaos:two -w backend -- --fault stall --seed 2
 */

export type TwoInstanceFault = 'kill' | 'stall';

export interface TwoInstanceOptions {
  fault: TwoInstanceFault;
  runs: number;
  agents: number;
  seed: number;
  /** Where a failed run leaves its logs and witness files; the temp directory by default. */
  failuresDir?: string;
}

const SCENARIO = {
  turns: [
    {
      steps: [
        { sleep: 1_000 },
        { mcp: { tool: 'comment_on_task', args: { body: 'Working on it' } } },
        { sleep: 2_000 },
        { say: 'Done.' },
        { sleep: 1_000 },
      ],
    },
  ],
};
const SCENARIO_MS = 4_000;
// Long enough for every lease the frozen instance holds to expire and be taken over.
const STALL_MS = LEASE_TTL_MS * 3;

export interface TwoInstanceResult {
  fault: TwoInstanceFault;
  runs: number;
  agents: number;
  seed: number;
  faultAtMs: number;
  /** Runs that finished, by status (and recovery class when recovered). */
  outcomes: Record<string, number>;
  takeovers: number;
  /** Witnessed executions per instance label, which shows both instances took work from the queue. */
  executionsByInstance: Record<string, number>;
  /** Most runs seen running at once. */
  peakRunning: number;
  fenceRejections: number;
  afterlifeMs: number | null;
  settledMs: number | null;
  violations: Violation[];
  leftovers: number[];
  error: string | null;
  durationMs: number;
}

export async function runTwoInstances(options: TwoInstanceOptions): Promise<TwoInstanceResult> {
  const started = Date.now();
  const id = `${started.toString(36)}${crypto.randomBytes(2).toString('hex')}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `loxo-chaos2-${id}-`));
  const storage = path.join(dir, 'storage');
  const witness = path.join(dir, 'witness');
  const logs = path.join(dir, 'logs');
  for (const sub of [storage, witness, logs]) fs.mkdirSync(sub, { recursive: true });
  const agentScript = path.join(dir, 'agent.mjs');
  writeAgentScript(agentScript, SCENARIO, witness, { shim: false });
  const crashLog = path.join(dir, 'faults.jsonl');

  const result: TwoInstanceResult = {
    fault: options.fault,
    runs: options.runs,
    agents: options.agents,
    seed: options.seed,
    faultAtMs: 0,
    outcomes: {},
    takeovers: 0,
    executionsByInstance: {},
    peakRunning: 0,
    fenceRejections: 0,
    afterlifeMs: null,
    settledMs: null,
    violations: [],
    leftovers: [],
    error: null,
    durationMs: 0,
  };
  const database = await createTrialDatabase(id);
  const db = new pg.Pool({ connectionString: database.url, max: 2 });
  const instances: Instance[] = [];
  const launch = async (label: string, stallAt?: string) => {
    const instance = await startInstance({
      label,
      databaseUrl: database.url,
      storageRoot: storage,
      agentCommand: agentScript,
      logDir: logs,
      crashLog,
      stallAt,
      poolMax: 20,
    });
    instances.push(instance);
    return instance;
  };

  let sampler: NodeJS.Timeout | undefined;
  try {
    // Frozen at its third settlement, by which point it holds other runs too.
    const [a, b] = await Promise.all([
      launch('a', options.fault === 'stall' ? `run.before_settle@3=${STALL_MS}` : undefined),
      launch('b'),
    ]);
    const apiA = new Api(a.baseUrl);
    const apiB = new Api(b.baseUrl);
    const reg = await apiA.call<{ token: string }>('POST', '/auth/register', {
      email: `chaos-${id}@example.com`,
      username: `chaos${id}`,
      password: 'chaos-trial-password',
    });
    apiA.token = apiB.token = reg.token;
    const agentIds: string[] = [];
    for (let i = 0; i < options.agents; i += 1) {
      const { agent } = await apiA.call<{ agent: { id: string } }>('POST', '/api/agents', {
        name: `Chaos agent ${i + 1}`,
        runtime: 'claude-code',
      });
      agentIds.push(agent.id);
    }
    const taskIds: string[] = [];
    for (let i = 0; i < options.runs; i += 1) {
      const api = i % 2 === 0 ? apiA : apiB;
      const { task } = await api.call<{ task: { id: string } }>('POST', '/api/tasks', {
        title: `Chaos task ${i + 1}`,
        leadAgentId: agentIds[i % options.agents],
      });
      taskIds.push(task.id);
    }

    // Every wake at once, half through each instance: entering todo wakes the lead.
    const wokenAt = Date.now();
    sampler = setInterval(() => {
      db.query<{ n: number }>("SELECT count(*)::int AS n FROM runs WHERE status = 'running'")
        .then(({ rows }) => (result.peakRunning = Math.max(result.peakRunning, rows[0]!.n)))
        .catch(() => {});
    }, 250);
    await Promise.all(
      taskIds.map((taskId, i) => (i % 2 === 0 ? apiA : apiB).call('POST', `/api/tasks/${taskId}/move`, { status: 'todo' }))
    );

    const deaths: { via: string; at: number }[] = [];
    let faultAt: number;
    if (options.fault === 'kill') {
      const delay = Math.round(SCENARIO_MS + seededRandom(options.seed)() * SCENARIO_MS * 2);
      await sleep(delay);
      a.kill();
      faultAt = Date.now();
      deaths.push({ via: new URL(a.baseUrl).host, at: faultAt });
      await a.exit;
      await launch('a2');
    } else {
      const deadline = Date.now() + 120_000;
      while (!fs.existsSync(crashLog)) {
        if (Date.now() > deadline || a.hasExited()) throw new Error('instance a never reached its stall point');
        await sleep(100);
      }
      faultAt = Date.parse((JSON.parse(fs.readFileSync(crashLog, 'utf8').split('\n')[0]!) as { at: string }).at);
    }
    result.faultAtMs = faultAt - wokenAt;

    // The check runs at a fixed bound after the fault; until then settling is only timed.
    const rounds = Math.ceil(options.runs / options.agents);
    const deadline =
      faultAt + STALL_MS + LEASE_TTL_MS + 2 * CYCLE_MS + MAX_BACKOFF_MS + (rounds + MAX_ATTEMPTS) * (SCENARIO_MS + 4_000);
    while (Date.now() < deadline) {
      for (const instance of instances) {
        if (instance.hasExited() && instance !== a) throw new Error(`instance ${instance.label} exited`);
      }
      const { rows } = await db.query<{ settled: boolean }>(
        `SELECT NOT EXISTS (SELECT 1 FROM runs WHERE status IN ('queued', 'running'))
           AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.status = 'interrupted' AND NOT EXISTS (
             SELECT 1 FROM human_requests h WHERE h.run_id = r.id AND h.kind = 'retry' AND h.status = 'open'))
           AS settled`
      );
      if (!rows[0]!.settled) result.settledMs = null;
      else result.settledMs ??= Date.now() - faultAt;
      await sleep(250);
    }

    const roots = await db.query<{ id: string }>('SELECT id FROM runs WHERE parent_run_id IS NULL');
    result.violations = await checkInvariants({
      db,
      wakeRuns: roots.rows.map((r) => r.id),
      witnessDir: witness,
      deaths,
      cycleMs: LEASE_TTL_MS,
      maxAttempts: MAX_ATTEMPTS,
    });
    const outcomes = await db.query<{ outcome: string; n: number }>(
      `SELECT status || COALESCE('/' || recovery_class, '') AS outcome, count(*)::int AS n FROM runs GROUP BY 1 ORDER BY 1`
    );
    result.outcomes = Object.fromEntries(outcomes.rows.map((r) => [r.outcome, r.n]));
    const takeovers = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM run_events WHERE kind = 'status' AND payload->>'message' LIKE 'Taken over%'`
    );
    result.takeovers = takeovers.rows[0]!.n;
    const labels = new Map(instances.map((instance) => [new URL(instance.baseUrl).host, instance.label]));
    for (const e of readExecutions(witness)) {
      const label = labels.get(e.via ?? '') ?? 'unknown';
      result.executionsByInstance[label] = (result.executionsByInstance[label] ?? 0) + 1;
    }
    const afterlives = readExecutions(witness).flatMap((e) =>
      deaths.filter((d) => d.via === e.via && e.start <= d.at).map((d) => Math.max(0, e.end - d.at))
    );
    result.afterlifeMs = afterlives.length > 0 ? Math.max(...afterlives) : null;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    clearInterval(sampler);
    for (const instance of instances) instance.kill();
    await Promise.all(instances.map((instance) => instance.exit));
    const agentPids = fs.readdirSync(witness).map((file) => Number(path.basename(file, '.jsonl')));
    result.leftovers = await endLeftovers(agentPids, agentScript).catch((err: Error) => {
      result.error ??= `leftover check failed: ${err.message}`;
      return agentPids.filter(isAlive);
    });
    result.fenceRejections = instances.reduce((n, instance) => {
      const text = fs.existsSync(instance.stderrFile) ? fs.readFileSync(instance.stderrFile, 'utf8') : '';
      return n + (text.match(/"event":"fence_rejected"/g)?.length ?? 0);
    }, 0);
    if (result.error || result.violations.length > 0) {
      const keep = path.join(options.failuresDir ?? os.tmpdir(), `two-instances-${id}`);
      fs.cpSync(logs, path.join(keep, 'logs'), { recursive: true });
      fs.cpSync(witness, path.join(keep, 'witness'), { recursive: true });
      console.error(`Evidence kept in ${keep}`);
    }
    await db.end();
    await dropTrialDatabase(database.name);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    result.durationMs = Date.now() - started;
  }
  return result;
}
