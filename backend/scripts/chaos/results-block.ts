import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The crash-recovery results that README.md and docs/durable-runs.md carry,
 * rendered from one summary.json under results/chaos/ so every number in the
 * prose can be traced to a recorded run.
 *
 *   npm run chaos:results -w backend -- --write results/chaos/2026-11-20
 *   npm run chaos:results -w backend -- --check
 *
 * --check re-renders each block from the summary its begin marker names and
 * fails when the text differs; it needs no database, so CI runs it.
 */

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DOCUMENTS = ['README.md', path.join('docs', 'durable-runs.md')];
const BLOCK = /<!-- chaos-results:begin source=(\S+) -->\r?\n([\s\S]*?)<!-- chaos-results:end -->/;

interface Spread {
  samples: number;
  p50: number | null;
  p99: number | null;
  max: number | null;
}

interface TwoInstanceGroup {
  runs: number;
  violations: number;
  errors: number;
  wokenRuns: number;
  takeovers: number;
  fenceRejections: number;
  peakRunning: number | null;
}

interface Summary {
  commits: string[];
  dirty: boolean;
  finishedAt: string;
  host: { platform: string; node: string };
  settings: { leaseTtlMs: number };
  trialsPerCell: number;
  crashPoints: number;
  runKinds: number;
  totals: { trials: number; passed: number; violations: number; errors: number; unreached: number };
  timingsMs: { recovered: Spread; afterlife: Spread };
  controls: { trials: number; trialsWithViolations: number; afterlifeMs: Spread };
  twoInstances: { kill: TwoInstanceGroup; stall: TwoInstanceGroup };
}

const seconds = (ms: number | null) => (ms === null ? 'n/a' : `${(ms / 1000).toFixed(1)} s`);

export function renderBlock(summary: Summary): string {
  const t = summary.totals;
  const races = [summary.twoInstances.kill, summary.twoInstances.stall];
  const sum = (pick: (g: TwoInstanceGroup) => number) => races.reduce((n, g) => n + pick(g), 0);
  const raceCount = sum((g) => g.runs);
  const wakesPerRace = raceCount ? Math.round(sum((g) => g.wokenRuns) / raceCount) : 0;
  const platform = summary.host.platform.startsWith('win32') ? 'Windows' : summary.host.platform.split(' ')[0];
  const rows = [
    '| | Result |',
    '|---|---|',
    `| **Crash matrix** | ${t.trials} trials: ${summary.crashPoints} crash points across ${summary.runKinds} run kinds, ${summary.trialsPerCell} per cell, the backend process killed outright each time. **${t.violations} invariant violations**, ${t.errors} errors, ${t.unreached} unreached |`,
    `| **Recovery** | From the crash until every run the dead instance owned was resolved: p50 **${seconds(summary.timingsMs.recovered.p50)}**, p99 **${seconds(summary.timingsMs.recovered.p99)}** (${seconds(summary.settings.leaseTtlMs)} lease) |`,
    `| **Orphaned agents** | Longest an agent kept working after its backend died: **${summary.timingsMs.afterlife.max === null ? 'n/a' : `${summary.timingsMs.afterlife.max} ms`}** with the launcher; up to **${seconds(summary.controls.afterlifeMs.max)}** without it, caught in ${summary.controls.trialsWithViolations} of ${summary.controls.trials} control trials |`,
    `| **Two instances, one database** | ${raceCount} races of ${wakesPerRace} concurrent wakes, one instance killed or frozen past its lease mid-run: **${sum((g) => g.violations)} invariant violations** (no run executed twice), ${sum((g) => g.takeovers)} takeovers, ${sum((g) => g.fenceRejections)} stale writes refused by the fence, up to ${Math.max(...races.map((g) => g.peakRunning ?? 0))} runs at once |`,
  ];
  const commits = summary.commits.map((c) => `\`${c.slice(0, 7)}\``).join(' and ');
  const source = `${summary.commits.length > 1 ? 'Commits' : 'Commit'} ${commits}${summary.dirty ? ' with uncommitted changes' : ''}, ${platform}, Node ${summary.host.node}, ${summary.finishedAt.slice(0, 10)}.`;
  return `${rows.join('\n')}\n\n${source}\n`;
}

function readSummary(source: string): Summary {
  return JSON.parse(fs.readFileSync(path.join(REPO_DIR, source), 'utf8')) as Summary;
}

function write(resultsDir: string): void {
  // Relative paths are from the repository root, where results/ lives.
  const source = path.posix.join(path.relative(REPO_DIR, path.resolve(REPO_DIR, resultsDir)).split(path.sep).join('/'), 'summary.json');
  const block = renderBlock(readSummary(source));
  for (const document of DOCUMENTS) {
    const file = path.join(REPO_DIR, document);
    const text = fs.readFileSync(file, 'utf8');
    if (!BLOCK.test(text)) throw new Error(`${document} has no chaos-results block`);
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const replaced = text.replace(
      BLOCK,
      `<!-- chaos-results:begin source=${source} -->${eol}${block.replace(/\n/g, eol)}<!-- chaos-results:end -->`
    );
    fs.writeFileSync(file, replaced);
    console.log(`${document}: block written from ${source}`);
  }
}

function check(): boolean {
  let ok = true;
  for (const document of DOCUMENTS) {
    const match = BLOCK.exec(fs.readFileSync(path.join(REPO_DIR, document), 'utf8'));
    if (!match) {
      console.error(`${document}: no chaos-results block`);
      ok = false;
      continue;
    }
    const expected = renderBlock(readSummary(match[1]!));
    if (match[2]!.replace(/\r\n/g, '\n') !== expected) {
      console.error(`${document}: the block does not match ${match[1]}; run npm run chaos:results -w backend -- --write <dir>`);
      ok = false;
    } else {
      console.log(`${document}: matches ${match[1]}`);
    }
  }
  return ok;
}

const [mode, dir] = process.argv.slice(2);
if (mode === '--write' && dir) {
  write(dir);
} else if (mode === '--check') {
  process.exitCode = check() ? 0 : 1;
} else {
  console.error('Usage: results-block.ts --write <results/chaos/DATE> | --check');
  process.exitCode = 2;
}
