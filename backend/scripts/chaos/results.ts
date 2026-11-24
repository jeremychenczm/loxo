import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CYCLE_MS, KILL_BUDGET_MS, LEASE_TTL_MS, MAX_ATTEMPTS, RETRY_BACKOFF_MS } from './infra';
import {
  cellLabel,
  chaosMatrix,
  isGraceful,
  summarize,
  summarizeControls,
  summarizeGraceful,
  summarizeTwoInstances,
} from './matrix';
import type { TrialResult } from './trial';
import type { TwoInstanceResult } from './two-instances';

/**
 * A results directory under results/chaos/ can be filled by several driver
 * invocations (the matrix in one, two-instance races in another). Each one
 * appends its own record to invocations.jsonl, and summary.json is always
 * rebuilt from every line the directory holds, so it never describes less or
 * more than what was recorded.
 */

export interface Invocation {
  commit: string;
  dirty: boolean;
  startedAt: string;
  finishedAt: string;
  requested: { trials: number; controls: number; two: number };
  host: { platform: string; node: string; cpus: number; memoryGb: number };
  note?: string;
}

export const FILES = {
  invocations: 'invocations.jsonl',
  trials: 'trials.jsonl',
  controls: 'controls.jsonl',
  twoInstances: 'two-instances.jsonl',
  summary: 'summary.json',
} as const;

export function hostInfo(): Invocation['host'] {
  return {
    platform: `${os.platform()} ${os.release()}`,
    node: process.version,
    cpus: os.cpus().length,
    memoryGb: Math.round(os.totalmem() / 2 ** 30),
  };
}

function readLines<T>(dir: string, file: string): T[] {
  const full = path.join(dir, file);
  if (!fs.existsSync(full)) return [];
  return fs
    .readFileSync(full, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
}

export function appendLine(dir: string, file: string, value: unknown): void {
  fs.appendFileSync(path.join(dir, file), `${JSON.stringify(value)}\n`);
}

export function buildSummary(dir: string) {
  const invocations = readLines<Invocation>(dir, FILES.invocations);
  if (invocations.length === 0) throw new Error(`${dir} has no ${FILES.invocations}`);
  const recorded = readLines<TrialResult & { cell: string }>(dir, FILES.trials);
  const gracefulLabels = new Set(chaosMatrix().filter(isGraceful).map(cellLabel));
  const trials = recorded.filter((t) => !gracefulLabels.has(t.cell));
  const gracefulTrials = recorded.filter((t) => gracefulLabels.has(t.cell));
  const controls = readLines<TrialResult>(dir, FILES.controls);
  const races = readLines<TwoInstanceResult>(dir, FILES.twoInstances);

  const labels = new Set(trials.map((t) => t.cell));
  const cells = chaosMatrix().filter((cell) => !isGraceful(cell) && labels.has(cellLabel(cell)));
  const perCell = new Map<string, number>();
  for (const t of trials) perCell.set(t.cell, (perCell.get(t.cell) ?? 0) + 1);
  const points = new Set(
    cells.flatMap((c) => [c.first, c.second]).flatMap((f) => (f && typeof f === 'object' ? [f.point] : []))
  );
  const commits = [...new Set(invocations.map((i) => i.commit))];
  return {
    commits,
    dirty: invocations.some((i) => i.dirty),
    startedAt: invocations.map((i) => i.startedAt).sort()[0]!,
    finishedAt: invocations.map((i) => i.finishedAt).sort().at(-1)!,
    host: invocations[0]!.host,
    settings: {
      leaseTtlMs: LEASE_TTL_MS,
      killBudgetMs: KILL_BUDGET_MS,
      retryBackoffMs: RETRY_BACKOFF_MS,
      maxAttempts: MAX_ATTEMPTS,
      reconcilerCycleMaxMs: CYCLE_MS,
    },
    trialsPerCell: perCell.size ? Math.min(...perCell.values()) : 0,
    crashPoints: points.size,
    runKinds: new Set(cells.map((c) => c.kind)).size,
    ...summarize(trials),
    graceful: gracefulTrials.length > 0 ? summarizeGraceful(gracefulTrials) : null,
    controls: summarizeControls(controls),
    twoInstances: summarizeTwoInstances(races),
    twoInstanceWorkshops: summarizeTwoInstances(races, true),
    invocations,
  };
}

export function writeSummary(dir: string): ReturnType<typeof buildSummary> {
  const summary = buildSummary(dir);
  fs.writeFileSync(path.join(dir, FILES.summary), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}
