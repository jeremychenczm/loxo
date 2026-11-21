import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { endLeftovers, isAlive, stillRunning } from '../scripts/chaos/infra';

/**
 * The chaos driver's end-of-trial sweep counts and kills only processes that
 * still belong to the trial. A pid Windows has already handed to an unrelated
 * process looks alive, and must be neither reported nor killed.
 */
const marker = path.join(os.tmpdir(), `chaos-leftovers-${process.pid}`, 'agent.mjs');
let child: ChildProcess | null = null;

async function startSleeper(...args: string[]): Promise<number> {
  child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)', ...args], { stdio: 'ignore' });
  await new Promise((resolve) => child!.once('spawn', resolve));
  return child.pid!;
}

afterEach(() => {
  child?.kill('SIGKILL');
  child = null;
});

describe('chaos leftover sweep', () => {
  it('counts a live process only while its command line names the trial', async () => {
    const pid = await startSleeper(marker);
    expect(stillRunning([pid], marker)).toEqual([pid]);
    expect(stillRunning([pid], path.join(os.tmpdir(), 'another-trial', 'agent.mjs'))).toEqual([]);
  }, 30_000);

  it('kills a process of the trial and leaves a recycled pid alone', async () => {
    const stranger = await startSleeper();
    expect(await endLeftovers([stranger], marker, 0)).toEqual([]);
    expect(isAlive(stranger)).toBe(true);
    child!.kill('SIGKILL');

    const own = await startSleeper(marker);
    expect(await endLeftovers([own], marker, 0)).toEqual([own]);
    const until = Date.now() + 5_000;
    while (isAlive(own) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    expect(isAlive(own)).toBe(false);
  }, 30_000);
});
