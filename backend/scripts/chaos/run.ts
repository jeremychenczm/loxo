import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CRASH_POINTS, type CrashPoint } from '../../src/modules/ownership/crash-points';
import {
  BACKEND_DIR,
  CYCLE_MS,
  KILL_BUDGET_MS,
  LEASE_TTL_MS,
  MAX_ATTEMPTS,
  prepareTemplate,
  RETRY_BACKOFF_MS,
} from './harness';
import { cellLabel, chaosMatrix, summarize } from './matrix';
import { RUN_KINDS, type RunKind } from './scenarios';
import { runTrial, type NamedFault, type TrialResult, type TrialSpec } from './trial';

/**
 * Chaos driver. Needs the chaos Postgres: `docker compose --profile chaos up -d --wait`.
 *
 * The whole matrix, N trials per cell, into results/chaos/<date>/:
 *   npm run chaos -w backend -- --trials 3
 *   npm run chaos -w backend -- --only comment,submit --match after_commit
 * One trial, printed:
 *   npm run chaos -w backend -- --kind edit-dirty --first run.before_settle --second decision.before_commit --answer discard
 *   npm run chaos -w backend -- --kind read --first random --no-launcher
 */

const REPO_DIR = path.resolve(BACKEND_DIR, '..');

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
  if (requested) return path.resolve(requested);
  const base = path.join(REPO_DIR, 'results', 'chaos', new Date().toISOString().slice(0, 10));
  let dir = base;
  for (let n = 2; fs.existsSync(dir); n += 1) dir = `${base}-${n}`;
  return dir;
}

async function runOne(values: Record<string, string | boolean | undefined>): Promise<number> {
  const kind = values.kind as RunKind;
  if (!RUN_KINDS.includes(kind)) throw new Error(`--kind is one of: ${RUN_KINDS.join(', ')}`);
  if (typeof values.first !== 'string') throw new Error('--first is a crash point or "random"');
  const answer = values.answer as TrialSpec['answer'] | undefined;
  if (answer && !['continue', 'discard', 'stop'].includes(answer)) throw new Error('--answer is continue, discard, or stop');
  const spec: TrialSpec = {
    kind,
    first: values.first === 'random' ? 'random' : namedFault(values.first),
    ...(typeof values.second === 'string' ? { second: namedFault(values.second) } : {}),
    ...(answer ? { answer } : {}),
    ...(values['no-launcher'] ? { launcher: false } : {}),
    seed: typeof values.seed === 'string' ? Number(values.seed) : Date.now() % 1_000_000,
  };
  await prepareTemplate();
  const result = await runTrial(spec, { failuresDir: typeof values.failures === 'string' ? values.failures : undefined });
  console.log(JSON.stringify(result, null, 2));
  return result.error || result.violations.length > 0 ? 1 : 0;
}

async function runMatrix(values: Record<string, string | boolean | undefined>): Promise<number> {
  const perCell = typeof values.trials === 'string' ? Number(values.trials) : 1;
  const only = typeof values.only === 'string' ? values.only.split(',') : null;
  const match = typeof values.match === 'string' ? values.match : null;
  const baseSeed = typeof values.seed === 'string' ? Number(values.seed) : 1;
  const cells = chaosMatrix().filter(
    (cell) => (!only || only.includes(cell.kind)) && (!match || cellLabel(cell).includes(match))
  );
  if (cells.length === 0) throw new Error('No cell matches the filters');

  // Recorded before anything is written, so the results describe the code that ran.
  const commit = git('rev-parse', 'HEAD');
  const dirty = git('status', '--porcelain', '--', '.', ':!results').length > 0;
  const out = resultsDir(typeof values.out === 'string' ? values.out : undefined);
  const failuresDir = path.join(out, 'failures');
  fs.mkdirSync(out, { recursive: true });
  const trialsFile = path.join(out, 'trials.jsonl');
  const startedAt = new Date().toISOString();

  await prepareTemplate();
  const total = cells.length * perCell;
  const results: (TrialResult & { cell: string })[] = [];
  let index = 0;
  for (let round = 0; round < perCell; round += 1) {
    for (const cell of cells) {
      index += 1;
      const label = cellLabel(cell);
      const result = { cell: label, ...(await runTrial({ ...cell, seed: baseSeed + index }, { failuresDir })) };
      results.push(result);
      fs.appendFileSync(trialsFile, `${JSON.stringify(result)}\n`);
      const verdict = !result.reached
        ? 'UNREACHED'
        : result.error
          ? `ERROR ${result.error}`
          : result.violations.length > 0
            ? `VIOLATIONS ${result.violations.map((v) => v.invariant).join(',')}`
            : result.leftovers.length > 0
              ? `LEFTOVERS ${result.leftovers.join(',')}`
              : 'ok';
      const timing = [
        result.recoveredMs !== null ? `recovered ${(result.recoveredMs / 1000).toFixed(1)}s` : null,
        result.settledMs !== null ? `settled ${(result.settledMs / 1000).toFixed(1)}s` : null,
      ]
        .filter(Boolean)
        .join(' ');
      console.log(`[${index}/${total}] ${label}: ${verdict} | ${result.runs.join(' > ')} | ${timing}`);
    }
  }

  const summary = {
    commit,
    dirty,
    startedAt,
    finishedAt: new Date().toISOString(),
    host: {
      platform: `${os.platform()} ${os.release()}`,
      node: process.version,
      cpus: os.cpus().length,
      memoryGb: Math.round(os.totalmem() / 2 ** 30),
    },
    settings: {
      leaseTtlMs: LEASE_TTL_MS,
      killBudgetMs: KILL_BUDGET_MS,
      retryBackoffMs: RETRY_BACKOFF_MS,
      maxAttempts: MAX_ATTEMPTS,
      reconcilerCycleMaxMs: CYCLE_MS,
    },
    trialsPerCell: perCell,
    ...summarize(results),
  };
  fs.writeFileSync(path.join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  const t = summary.totals;
  console.log(
    `\n${t.trials} trials, ${t.passed} passed, ${t.violations} violations, ${t.errors} errors, ${t.unreached} unreached -> ${path.relative(REPO_DIR, out)}`
  );
  return t.passed === t.trials ? 0 : 1;
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
      only: { type: 'string' },
      match: { type: 'string' },
      out: { type: 'string' },
    },
  });
  process.exitCode = values.kind ? await runOne(values) : await runMatrix(values);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 2;
});
