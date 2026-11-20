import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveLauncher, underLauncher, type Launcher } from '../src/modules/hosts/launcher/launcher';
import { storage } from '../src/storage/layout';

const T = 30_000;
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/launcher/${name}`, import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let dir = '';
let launcher: Launcher;
const strays = new Set<number>();

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function forceKill(pid: number): void {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' });
    else process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

async function pidFrom(file: string): Promise<number> {
  for (let i = 0; i < 100; i++) {
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (text) {
      strays.add(Number(text));
      return Number(text);
    }
    await sleep(100);
  }
  throw new Error(`${file} was never written`);
}

/** Polls until every pid is gone; returns how long it took, or null after `ms`. */
async function goneWithin(pids: number[], ms: number): Promise<number | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pids.every((pid) => !alive(pid))) return Date.now() - t0;
    await sleep(50);
  }
  return null;
}

/** parent (stand-in backend) -> [launcher ->] tree agent -> shell -> grandchild, with the shell already gone. */
async function tree(mode: 'launcher' | 'launcher-outside-job' | 'direct', agentArgs: string[] = []) {
  const files = { grandchild: path.join(dir, `g-${Math.random()}.pid`), agent: path.join(dir, `a-${Math.random()}.pid`) };
  const parent = spawn(
    process.execPath,
    [fixture('parent.mjs'), mode, launcher.command, process.execPath, fixture('tree-agent.mjs'), files.grandchild, files.agent, ...agentArgs],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  );
  const line = await new Promise<string>((resolve) => readline.createInterface({ input: parent.stdout! }).once('line', resolve));
  const { parent: parentPid, top } = JSON.parse(line) as { parent: number; top: number };
  strays.add(parentPid);
  strays.add(top);
  const agent = await pidFrom(files.agent);
  const grandchild = await pidFrom(files.grandchild);
  await sleep(500);
  return { parentPid, top, agent, grandchild };
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loxo-launcher-'));
  // Start without a cached binary so the build runs too, not only its reuse; one in use stays.
  const builds = path.join(storage.root, 'runtimes', 'launcher');
  for (const file of fs.existsSync(builds) ? fs.readdirSync(builds) : []) {
    try {
      fs.rmSync(path.join(builds, file), { force: true });
    } catch {
      // A running agent holds it open.
    }
  }
  const built = await resolveLauncher();
  if (!built) throw new Error('launcher unavailable on this machine');
  launcher = built;
});

afterEach(() => {
  for (const pid of strays) forceKill(pid);
  strays.clear();
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));

describe.skipIf(process.platform === 'win32')('the POSIX launcher', () => {
  it('passes the platform check script', { timeout: 120_000 }, async () => {
    expect(launcher.kind).toBe('process-group');
    const { stdout } = await promisify(execFile)(process.execPath, [fixture('posix-check.mjs')]);
    expect(stdout).toContain('ALL PASSED');
  });
});

describe.skipIf(process.platform !== 'win32')('the Windows launcher', () => {
  it('builds once, passes its self-test, and is reused', { timeout: T }, async () => {
    expect(launcher.kind).toBe('job-object');
    expect(fs.existsSync(launcher.command)).toBe(true);
    expect(path.basename(launcher.command)).toMatch(/^loxo-launcher-[0-9a-f]{12}\.exe$/);
    expect(await resolveLauncher()).toBe(launcher);
    await promisify(execFile)(launcher.command, ['--self-test']);
  });

  it('takes down a descendant whose own parent already exited once the backend dies', { timeout: T }, async () => {
    // Control: started directly, the descendant behind the shell survives the backend.
    const direct = await tree('direct');
    expect(alive(direct.grandchild)).toBe(true);
    forceKill(direct.parentPid);
    await sleep(1500);
    expect(alive(direct.agent)).toBe(false);
    expect(alive(direct.grandchild)).toBe(true);

    const managed = await tree('launcher');
    expect(alive(managed.grandchild)).toBe(true);
    forceKill(managed.parentPid);
    expect(await goneWithin([managed.top, managed.agent, managed.grandchild], 5_000)).not.toBeNull();
  });

  it('notices its parent dying even outside the parent process job', { timeout: T }, async () => {
    // Node puts its direct children in a kill-on-close job of its own, which
    // already covers a launcher started normally; a detached one relies on
    // watching the parent.
    const managed = await tree('launcher-outside-job');
    forceKill(managed.parentPid);
    expect(await goneWithin([managed.top, managed.agent, managed.grandchild], 5_000)).not.toBeNull();
  });

  it("cleans up after an agent that exits on its own and returns the agent's exit code", { timeout: T }, async () => {
    const files = { grandchild: path.join(dir, 'exit-g.pid'), agent: path.join(dir, 'exit-a.pid') };
    const run = underLauncher(launcher, { command: process.execPath, args: [fixture('tree-agent.mjs'), files.grandchild, files.agent, '1500', '7'] }, 'exit-tag');
    const child = spawn(run.command, run.args, { stdio: 'ignore' });
    const exit = new Promise<number | null>((resolve) => child.once('exit', resolve));
    const grandchild = await pidFrom(files.grandchild);
    expect(alive(grandchild)).toBe(true);
    expect(await exit).toBe(7);
    expect(await goneWithin([grandchild], 3_000)).not.toBeNull();
  });

  it('takes the whole tree down when the launcher itself is killed', { timeout: T }, async () => {
    const managed = await tree('launcher');
    forceKill(managed.top);
    expect(await goneWithin([managed.agent, managed.grandchild], 5_000)).not.toBeNull();
    expect(alive(managed.parentPid)).toBe(true);
  });

  it('passes stdio and every argument through untouched', { timeout: T }, async () => {
    const args = ['plain', 'two words', 'say "hi"', 'trailing\\', 'C:\\Program Files\\x', '', 'tab\there'];
    const run = underLauncher(launcher, { command: process.execPath, args: [fixture('echo-agent.mjs'), ...args] }, 'echo-tag');
    const child: ChildProcess = spawn(run.command, run.args, { stdio: ['pipe', 'pipe', 'inherit'] });
    const lines = readline.createInterface({ input: child.stdout! });
    const received: string[] = [];
    lines.on('line', (l) => received.push(l));
    const exit = new Promise<number | null>((resolve) => child.once('exit', resolve));
    child.stdin!.write('ping\n');
    child.stdin!.write('bye\n');
    expect(await exit).toBe(3);
    expect(JSON.parse(received[0]!)).toEqual(args);
    expect(received.slice(1)).toEqual(['echo:ping']);
  });

  it('starts nothing when its parent is already gone', { timeout: T }, async () => {
    const marker = path.join(dir, 'never.pid');
    const stale = spawn(process.execPath, ['-e', '0']);
    await new Promise((resolve) => stale.once('exit', resolve));
    const run = underLauncher(launcher, { command: process.execPath, args: [fixture('grandchild.mjs'), marker] }, 'stale-tag');
    const args = [...run.args];
    args[args.indexOf('--parent') + 1] = String(stale.pid);
    const result = await promisify(execFile)(run.command, args).then(
      () => 0,
      (err: { code?: number }) => err.code
    );
    expect(result).toBe(70);
    await sleep(500);
    expect(fs.existsSync(marker)).toBe(false);
  });
});
