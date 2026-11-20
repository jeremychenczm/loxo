import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CRASH_POINTS, type CrashPoint } from '../../src/modules/ownership/crash-points';
import { BACKEND_DIR, prepareTemplate } from './infra';
import { cellLabel, chaosMatrix } from './matrix';
import { appendLine, FILES, hostInfo, writeSummary, type Invocation } from './results';
import { RUN_KINDS, type RunKind } from './scenarios';
import { runTrial, type NamedFault, type TrialResult, type TrialSpec } from './trial';
import { runTwoInstances, type TwoInstanceFault, type TwoInstanceResult } from './two-instances';

/**
 * Chaos driver. Needs the chaos Postgres: `docker compose --profile chaos up -d --wait`.
 *
 * Matrix (N trials per cell), launcher-off controls, and two-instance races,
 * all into one results/chaos/<date>/ directory:
 *   npm run chaos -w backend -- --trials 3 --controls 2 --two 3
 *   npm run chaos -w backend -- --only comment,submit --match after_commit
 * Add to an existing results directory (the summary covers everything it holds), or only rebuild its summary:
 *   npm run chaos -w backend -- --trials 0 --two 1 --seed 2 --out results/chaos/2026-11-20
 *   npm run chaos -w backend -- --summarize results/chaos/2026-11-20
 * One trial, printed:
 *   npm run chaos -w backend -- --kind edit-dirty --first run.before_settle --second decision.before_commit --answer discard
 *   npm run chaos -w backend -- --kind read --first random --no-launcher
 * One two-instance race, printed:
 *   npm run chaos:two -w backend -- --fault stall --seed 2
 */

const REPO_DIR = path.resolve(BACKEND_DIR, '..');
const TWO_INSTANCE_RUNS = 50;
const TWO_INSTANCE_AGENTS = 10;

type Values = Record<string, string | boolean | undefined>;

const str = (values: Values, key: string) => (typeof values[key] === 'string' ? (values[key] as string) : undefined);

function namedFault(value: string): NamedFault {
  const [point, hit] = value.split('@');
  if (!CRASH_POINTS.includes(point as CrashPoint)) {
    throw new Error(`Unknown crash point "${point}"; one of: ${CRASH_POINTS.join(', ')}`);
  }
  return { point: point as CrashPoint, ...(hit ? { hit: Number(hit) } : {}) };
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: REPO_DIR, encoding: 'utf8' }).trim();
}

function resultsDir(requested: string | undefined): string {
  // Relative to the repository root, so a run can add to an existing results directory from anywhere.
  if (requested) return path.resolve(REPO_DIR, requested);
  const base = path.join(REPO_DIR, 'results', 'chaos', new Date().toISOString().slice(0, 10));
  let dir = base;
  for (let n = 2; fs.existsSync(dir); n += 1) dir = `${base}-${n}`;
  return dir;
}

let unstartable = 0;

/** Stops once instances keep failing to start (usually memory pressure) rather than burning through the cells. */
function noteStart(error: string | null): void {
  unstartable = error?.includes('did not become ready') ? unstartable + 1 : 0;
  if (unstartable >= 3) {
    throw new Error('Three trials in a row could not start a backend instance; stopped. Check free memory.');
  }
}

function verdict(result: TrialResult): string {
  if (!result.reached) return 'UNREACHED';
  if (result.error) return `ERROR ${result.error}`;
  if (result.violations.length > 0) return `VIOLATIONS ${result.violations.map((v) => v.invariant).join(',')}`;
  if (result.leftovers.length > 0) return `LEFTOVERS ${result.leftovers.join(',')}`;
  return 'ok';
}

async function runOne(values: Values): Promise<number> {
  const kind = values.kind as RunKind;
  if (!RUN_KINDS.includes(kind)) throw new Error(`--kind is one of: ${RUN_KINDS.join(', ')}`);
  const first = str(values, 'first');
  if (!first) throw new Error('--first is a crash point or "random"');
  const answer = values.answer as TrialSpec['answer'] | undefined;
  if (answer && !['continue', 'discard', 'stop'].includes(answer)) throw new Error('--answer is continue, discard, or stop');
  const second = str(values, 'second');
  const spec: TrialSpec = {
    kind,
    first: first === 'random' ? 'random' : namedFault(first),
    ...(second ? { second: namedFault(second) } : {}),
    ...(answer ? { answer } : {}),
    ...(values['no-launcher'] ? { launcher: false } : {}),
    seed: Number(str(values, 'seed') ?? Date.now() % 1_000_000),
  };
  await prepareTemplate();
  const result = await runTrial(spec, { failuresDir: str(values, 'failures') });
  console.log(JSON.stringify(result, null, 2));
  return result.error || result.violations.length > 0 ? 1 : 0;
}

async function runTwoOnce(values: Values): Promise<number> {
  const fault = (str(values, 'fault') ?? 'kill') as TwoInstanceFault;
  if (fault !== 'kill' && fault !== 'stall') throw new Error('--fault is kill or stall');
  await prepareTemplate();
  const result = await runTwoInstances({
    fault,
    runs: TWO_INSTANCE_RUNS,
    agents: TWO_INSTANCE_AGENTS,
    seed: Number(str(values, 'seed') ?? 1),
    failuresDir: str(values, 'failures'),
  });
  console.log(JSON.stringify(result, null, 2));
  return result.error || result.violations.length > 0 ? 1 : 0;
}

async function runMatrix(values: Values): Promise<number> {
  const perCell = Number(str(values, 'trials') ?? 1);
  const controlsPerKind = Number(str(values, 'controls') ?? 0);
  const twoPerFault = Number(str(values, 'two') ?? 0);
  const only = str(values, 'only')?.split(',') ?? null;
  const match = str(values, 'match') ?? null;
  const baseSeed = Number(str(values, 'seed') ?? 1);
  const cells = chaosMatrix().filter(
    (cell) => (!only || only.includes(cell.kind)) && (!match || cellLabel(cell).includes(match))
  );
  if (cells.length === 0 && perCell > 0) throw new Error('No cell matches the filters');

  // Recorded before anything is written, so the results describe the code that ran.
  const commit = git('rev-parse', 'HEAD');
  const dirty = git('status', '--porcelain', '--', '.', ':!results').length > 0;
  const out = resultsDir(str(values, 'out'));
  const failuresDir = path.join(out, 'failures');
  fs.mkdirSync(out, { recursive: true });
  const startedAt = new Date().toISOString();
  await prepareTemplate();

  const total = cells.length * perCell + RUN_KINDS.length * controlsPerKind + 2 * twoPerFault;
  let index = 0;
  const step = () => `[${(index += 1)}/${total}]`;
  const pass = (r: TrialResult) => r.reached && !r.error && r.violations.length === 0 && r.leftovers.length === 0;

  const trials: TrialResult[] = [];
  const races: TwoInstanceResult[] = [];
  let stopped: string | null = null;
  try {
    for (let round = 0; round < perCell; round += 1) {
      for (const cell of cells) {
        const label = cellLabel(cell);
        const result = { cell: label, ...(await runTrial({ ...cell, seed: baseSeed + index }, { failuresDir })) };
        trials.push(result);
        appendLine(out, FILES.trials, result);
        noteStart(result.error);
        const timing = [
          result.recoveredMs !== null ? `recovered ${(result.recoveredMs / 1000).toFixed(1)}s` : null,
          result.settledMs !== null ? `settled ${(result.settledMs / 1000).toFixed(1)}s` : null,
        ]
          .filter(Boolean)
          .join(' ');
        console.log(`${step()} ${label}: ${verdict(result)} | ${result.runs.join(' > ')} | ${timing}`);
      }
    }

    for (let round = 0; round < controlsPerKind; round += 1) {
      for (const kind of RUN_KINDS) {
        const result = await runTrial({ kind, first: 'random', launcher: false, seed: baseSeed + index }, { failuresDir });
        appendLine(out, FILES.controls, result);
        noteStart(result.error);
        const found = result.violations.map((v) => v.invariant).join(',') || 'none';
        console.log(`${step()} control ${kind} random, no launcher: violations ${found} | afterlife ${result.afterlifeMs ?? '-'} ms`);
      }
    }

    for (let round = 0; round < twoPerFault; round += 1) {
      for (const fault of ['kill', 'stall'] as const) {
        const result = await runTwoInstances({
          fault,
          runs: TWO_INSTANCE_RUNS,
          agents: TWO_INSTANCE_AGENTS,
          seed: baseSeed + round,
          failuresDir,
        });
        races.push(result);
        appendLine(out, FILES.twoInstances, result);
        noteStart(result.error);
        const state = result.error ? `ERROR ${result.error}` : `violations ${result.violations.length}`;
        console.log(
          `${step()} two instances, ${fault}: ${state} | takeovers ${result.takeovers}, fence rejections ${result.fenceRejections}, peak running ${result.peakRunning}`
        );
      }
    }
  } catch (err) {
    stopped = err instanceof Error ? err.message : String(err);
    console.error(stopped);
  }

  appendLine(out, FILES.invocations, {
    commit,
    dirty,
    startedAt,
    finishedAt: new Date().toISOString(),
    requested: { trials: perCell, controls: controlsPerKind, two: twoPerFault },
    host: hostInfo(),
    ...(stopped ? { note: `stopped early: ${stopped}` } : {}),
  } satisfies Invocation);
  const summary = writeSummary(out);
  const t = summary.totals;
  const racesFailed = races.filter((r) => r.error || r.violations.length > 0 || r.leftovers.length > 0).length;
  console.log(
    `
this invocation: ${trials.length} matrix trials (${trials.filter(pass).length} passed), ${races.length} races (${racesFailed} failed)` +
      `
directory: matrix ${t.trials} trials, ${t.passed} passed, ${t.violations} violations; controls ${summary.controls.trials}; races ${summary.twoInstances.kill.runs + summary.twoInstances.stall.runs}` +
      `
-> ${path.relative(REPO_DIR, out)}`
  );
  return !stopped && trials.every(pass) && racesFailed === 0 ? 0 : 1;
}

/** Rebuilds summary.json from the lines a results directory holds, without running anything. */
function runSummarize(dir: string): number {
  const out = path.resolve(REPO_DIR, dir);
  const summary = writeSummary(out);
  const t = summary.totals;
  console.log(
    `matrix ${t.trials} trials, ${t.passed} passed, ${t.violations} violations; controls ${summary.controls.trials}; races ${summary.twoInstances.kill.runs + summary.twoInstances.stall.runs} -> ${path.relative(REPO_DIR, out)}`
  );
  return 0;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      kind: { type: 'string' },
      first: { type: 'string' },
      second: { type: 'string' },
      answer: { type: 'string' },
      seed: { type: 'string' },
      'no-launcher': { type: 'boolean' },
      failures: { type: 'string' },
      trials: { type: 'string' },
      controls: { type: 'string' },
      two: { type: 'string' },
      'two-instances': { type: 'boolean' },
      fault: { type: 'string' },
      only: { type: 'string' },
      match: { type: 'string' },
      out: { type: 'string' },
      summarize: { type: 'string' },
    },
  });
  const summarizeDir = str(values, 'summarize');
  process.exitCode = summarizeDir
    ? runSummarize(summarizeDir)
    : values.kind
    ? await runOne(values)
    : values['two-instances']
      ? await runTwoOnce(values)
      : await runMatrix(values);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 2;
});
