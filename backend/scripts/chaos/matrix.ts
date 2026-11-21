import type { CrashPoint } from '../../src/modules/ownership/crash-points';
import { RUN_KIND_SPECS, RUN_KINDS, type RunKind } from './scenarios';
import type { TwoInstanceResult } from './two-instances';
import { faultLabel, type TrialResult, type TrialSpec } from './trial';

/**
 * The crash matrix: every crash point a run kind actually passes, a kill at
 * a random moment, a second crash during recovery, and a crash while a
 * person's decision is being carried out. A cell that cannot fire is left
 * out rather than counted as a pass.
 *
 * Graceful cells follow: each run kind shut down mid-run as a deploy does,
 * and the same with a crash partway through the handoff. They are summarized
 * apart from the crash cells.
 */
export type CellSpec = Omit<TrialSpec, 'seed'>;

const EVERY_RUN: CrashPoint[] = [
  'wake.before_start',
  'admission.after_claim',
  'run.after_spawn_before_pid_recorded',
  'run.before_settle',
  'run.after_settle',
];
const WITH_WORKTREE: CrashPoint[] = ['run.after_before_ref', 'run.before_capture'];
const WITH_TOOL_CALLS: CrashPoint[] = ['control_plane.before_record', 'control_plane.after_commit'];
const TOOL_KINDS: RunKind[] = ['comment', 'submit'];

export function chaosMatrix(): CellSpec[] {
  const cells: CellSpec[] = [];
  for (const kind of RUN_KINDS) {
    const points = [
      ...EVERY_RUN,
      ...(RUN_KIND_SPECS[kind].repository ? WITH_WORKTREE : []),
      ...(TOOL_KINDS.includes(kind) ? WITH_TOOL_CALLS : []),
    ];
    for (const point of points) cells.push({ kind, first: { point } });
    cells.push({ kind, first: 'random' });
    for (const second of ['recovery.before_assess', 'recovery.before_resolve'] as const) {
      cells.push({ kind, first: { point: 'run.before_settle' }, second: { point: second } });
    }
  }
  for (const kind of RUN_KINDS) {
    cells.push({ kind, first: 'graceful' });
    for (const point of ['handoff.before_commit', 'handoff.after_commit'] as const) {
      cells.push({ kind, first: { point }, shutdown: true });
    }
  }
  cells.push({ kind: 'comment', first: { point: 'control_plane.after_commit' }, answer: 'continue' });
  cells.push({ kind: 'edit-dirty', first: { point: 'run.before_settle' }, answer: 'discard' });
  cells.push({
    kind: 'edit-dirty',
    first: { point: 'run.before_settle' },
    second: { point: 'decision.before_commit' },
    answer: 'discard',
  });
  return cells;
}

export const cellLabel = (cell: CellSpec) => `${cell.kind} ${faultLabel({ ...cell, seed: 0 })}`;

/** A cell whose first instance is asked to shut down gracefully. */
export const isGraceful = (cell: Pick<CellSpec, 'first' | 'shutdown'>) => cell.first === 'graceful' || cell.shutdown === true;

/** Nearest-rank percentile; null for no samples. */
function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

function spread(values: (number | null | undefined)[]) {
  // Results recorded before a timing existed carry no field for it.
  const samples = values.filter((v): v is number => typeof v === 'number');
  return {
    samples: samples.length,
    p50: percentile(samples, 50),
    p99: percentile(samples, 99),
    max: samples.length ? Math.max(...samples) : null,
  };
}

export interface ChaosSummary {
  totals: {
    trials: number;
    passed: number;
    violations: number;
    trialsWithViolations: number;
    errors: number;
    unreached: number;
    fenceRejections: number;
    leftovers: number;
  };
  violationsByInvariant: Record<string, number>;
  timingsMs: Record<'restart' | 'recovered' | 'settled' | 'afterlife', ReturnType<typeof spread>>;
  cells: {
    cell: string;
    trials: number;
    passed: number;
    violations: number;
    errors: number;
    outcomes: string[];
  }[];
}

export function summarize(results: (TrialResult & { cell: string })[]): ChaosSummary {
  const byInvariant: Record<string, number> = {};
  for (const r of results) {
    for (const v of r.violations) byInvariant[v.invariant] = (byInvariant[v.invariant] ?? 0) + 1;
  }
  const passed = (r: TrialResult) => r.reached && !r.error && r.violations.length === 0 && r.leftovers.length === 0;
  const cells = new Map<string, (TrialResult & { cell: string })[]>();
  for (const r of results) cells.set(r.cell, [...(cells.get(r.cell) ?? []), r]);
  return {
    totals: {
      trials: results.length,
      passed: results.filter(passed).length,
      violations: results.reduce((n, r) => n + r.violations.length, 0),
      trialsWithViolations: results.filter((r) => r.violations.length > 0).length,
      errors: results.filter((r) => r.error && r.reached).length,
      unreached: results.filter((r) => !r.reached).length,
      fenceRejections: results.reduce((n, r) => n + r.fenceRejections, 0),
      leftovers: results.reduce((n, r) => n + r.leftovers.length, 0),
    },
    violationsByInvariant: byInvariant,
    timingsMs: {
      restart: spread(results.map((r) => r.restartMs)),
      recovered: spread(results.map((r) => r.recoveredMs)),
      settled: spread(results.map((r) => r.settledMs)),
      afterlife: spread(results.map((r) => r.afterlifeMs)),
    },
    cells: [...cells].map(([cell, list]) => ({
      cell,
      trials: list.length,
      passed: list.filter(passed).length,
      violations: list.reduce((n, r) => n + r.violations.length, 0),
      errors: list.filter((r) => r.error).length,
      outcomes: [...new Set(list.map((r) => r.runs.join(' > ')))],
    })),
  };
}

/**
 * Graceful cells, apart from the crash cells. After a clean shutdown no run
 * should need a person and none should go through crash recovery; with a
 * crash partway through the handoff, recovery takes over as after any crash.
 */
export function summarizeGraceful(results: (TrialResult & { cell: string })[]) {
  const clean = results.filter((r) => r.fault === 'graceful');
  const { totals, violationsByInvariant, cells } = summarize(results);
  return {
    totals,
    violationsByInvariant,
    cleanTrials: clean.length,
    /** Runs a clean shutdown left waiting on a person's decision. */
    sentToPerson: clean.reduce((n, r) => n + r.runs.filter((run) => run.includes('interrupted')).length, 0),
    /** Runs a clean shutdown left to crash recovery: they carry a recovery class. */
    recoveredAfterClean: clean.reduce((n, r) => n + r.runs.filter((run) => run.includes('/')).length, 0),
    timingsMs: {
      shutdown: spread(clean.map((r) => r.shutdownMs)),
      handoff: spread(clean.map((r) => r.handoffMs)),
      afterlife: spread(results.map((r) => r.afterlifeMs)),
    },
    cells,
  };
}

/** Control trials run without the launcher; their violations are the point, so they are counted, not failed. */
export function summarizeControls(results: TrialResult[]) {
  const byInvariant: Record<string, number> = {};
  for (const r of results) {
    for (const v of r.violations) byInvariant[v.invariant] = (byInvariant[v.invariant] ?? 0) + 1;
  }
  return {
    trials: results.length,
    trialsWithViolations: results.filter((r) => r.violations.length > 0).length,
    errors: results.filter((r) => r.error).length,
    violationsByInvariant: byInvariant,
    afterlifeMs: spread(results.map((r) => r.afterlifeMs)),
  };
}

export function summarizeTwoInstances(results: TwoInstanceResult[]) {
  const group = (fault: TwoInstanceResult['fault']) => {
    const list = results.filter((r) => r.fault === fault);
    return {
      runs: list.length,
      passed: list.filter((r) => !r.error && r.violations.length === 0 && r.leftovers.length === 0).length,
      violations: list.reduce((n, r) => n + r.violations.length, 0),
      errors: list.filter((r) => r.error).length,
      wokenRuns: list.reduce((n, r) => n + r.runs, 0),
      takeovers: list.reduce((n, r) => n + r.takeovers, 0),
      fenceRejections: list.reduce((n, r) => n + r.fenceRejections, 0),
      peakRunning: list.length ? Math.max(...list.map((r) => r.peakRunning)) : null,
      settledMs: spread(list.map((r) => r.settledMs)),
      afterlifeMs: spread(list.map((r) => r.afterlifeMs)),
    };
  };
  return { kill: group('kill'), stall: group('stall'), restart: group('restart') };
}
