import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'crash-point-child.ts');
const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

let dir: string;
let logFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loxo-crash-points-'));
  logFile = path.join(dir, 'faults.jsonl');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function runChild(env: Record<string, string>) {
  const base = { ...process.env };
  delete base.LOXO_CRASH_AT;
  delete base.LOXO_STALL_AT;
  const result = spawnSync(process.execPath, ['--import', TSX, CHILD], {
    env: { ...base, LOXO_CRASH_LOG: logFile, ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });
  const lines = result.stdout.split('\n').filter(Boolean);
  const faults = fs.existsSync(logFile)
    ? fs
        .readFileSync(logFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];
  return { result, lines, faults };
}

function passes(lines: string[]): string[] {
  return lines.filter((line) => line.startsWith('passed')).map((line) => line.split(' ').slice(0, 2).join(' '));
}

describe('crash points armed through the environment', () => {
  it('pass through untouched when nothing is armed', () => {
    const { result, lines, faults } = runChild({});
    expect(result.status).toBe(0);
    expect(passes(lines)).toEqual(['passed 1', 'passed 2', 'passed 3']);
    expect(lines.slice(-2)).toEqual(['finally', 'exit-hook']);
    expect(faults).toEqual([]);
  });

  it('kill the process on the n-th hit, before any finally block or exit hook runs', () => {
    const { result, lines, faults } = runChild({ LOXO_CRASH_AT: 'wake.before_start@2' });

    expect(passes(lines)).toEqual(['passed 1']);
    expect(lines).not.toContain('finally');
    expect(lines).not.toContain('exit-hook');
    if (process.platform === 'win32') {
      // TerminateProcess, as libuv issues it for SIGKILL.
      expect(result.status).toBe(1);
    } else {
      expect(result.signal).toBe('SIGKILL');
    }
    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatchObject({ point: 'wake.before_start', hit: 2, pid: result.pid });
  });

  it('stall the event loop for the given time on the n-th hit, then carry on', () => {
    const { result, lines, faults } = runChild({ LOXO_STALL_AT: 'wake.before_start@2=400' });

    expect(result.status).toBe(0);
    const elapsed = lines.filter((line) => line.startsWith('passed')).map((line) => Number(line.split(' ')[2]));
    expect(elapsed).toHaveLength(3);
    expect(elapsed[1]).toBeGreaterThanOrEqual(390);
    expect(elapsed[0]).toBeLessThan(100);
    expect(elapsed[2]).toBeLessThan(100);
    expect(lines.slice(-2)).toEqual(['finally', 'exit-hook']);
    expect(faults).toEqual([expect.objectContaining({ point: 'wake.before_start', hit: 2, stallMs: 400 })]);
  });

  it.each([
    ['LOXO_CRASH_AT', 'wake.before_strat', 'unknown crash point "wake.before_strat"'],
    ['LOXO_CRASH_AT', 'wake.before_start@0', 'must look like <point>[@<n>]'],
    ['LOXO_STALL_AT', 'wake.before_start@2', 'must end with =<milliseconds>'],
    ['LOXO_STALL_AT', 'run.nowhere=100', 'unknown crash point "run.nowhere"'],
  ])('refuse to start when %s=%s', (variable, value, message) => {
    const { result, lines } = runChild({ [variable]: value });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(passes(lines)).toEqual([]);
  });
});
