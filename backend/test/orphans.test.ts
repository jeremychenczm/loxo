import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import { runs, type Run } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { newLaunchTag, resolveLauncher, underLauncher, type Launcher } from '../src/modules/hosts/launcher/launcher';
import { LeaseKeeper } from '../src/modules/ownership/lease';
import { endOrphans } from '../src/modules/ownership/orphans';
import { reconcileOnce } from '../src/modules/ownership/reconciler';
import { setRetryPolicyForTests } from '../src/modules/ownership/recovery';
import { initFixtureRepo, makeSandbox, removeSandbox } from './fixtures/git-repo';
import { deadRun as deadRunIn, type DeadRun, type DeadRunOptions } from './support/dead-run';

const app = createApp();
const T = 60_000;
const HOST = os.hostname();
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/launcher/${name}`, import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let token = '';
let userId = '';
let repositoryId = '';
let sandbox = '';
let launcher: Launcher;
let keeper: LeaseKeeper;
const strays = new Set<number>();

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Liveness of each pid once killed ones have had a moment to be reaped (a killed child stays a zombie until then). */
async function aliveAfterKill(pids: number[]): Promise<boolean[]> {
  for (let i = 0; i < 30 && pids.some(alive); i++) await sleep(100);
  return pids.map(alive);
}

function forceKill(pid: number): void {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
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

/** A launcher running an agent that keeps a descendant alive behind an exited shell, as a stalled owner would leave it. */
async function liveTree() {
  const tag = newLaunchTag();
  const files = { grandchild: path.join(sandbox, `g-${tag}.pid`), agent: path.join(sandbox, `a-${tag}.pid`) };
  const command = underLauncher(launcher, { command: process.execPath, args: [fixture('tree-agent.mjs'), files.grandchild, files.agent] }, tag);
  // Started the way the ACP host starts it: on POSIX the launcher leads its own process group.
  const child = spawn(command.command, command.args, { stdio: 'ignore', detached: process.platform !== 'win32' });
  strays.add(child.pid!);
  const agent = await pidFrom(files.agent);
  const grandchild = await pidFrom(files.grandchild);
  await sleep(500);
  return { identity: { pid: child.pid!, tag, host: HOST }, agent, grandchild };
}

/** An unrelated long-lived process: what a reused pid would point at. */
async function bystander(): Promise<number> {
  const file = path.join(sandbox, `bystander-${Date.now()}.pid`);
  const child = spawn(process.execPath, [fixture('grandchild.mjs'), file], { stdio: 'ignore' });
  strays.add(child.pid!);
  return pidFrom(file);
}

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  const reg = await request(app)
    .post('/auth/register')
    .send({ email: 'orphans@example.com', username: 'orphansuser', password: 'a-strong-password' });
  token = reg.body.token;
  userId = reg.body.user.id;
  sandbox = makeSandbox('orphans');
  const repo = await initFixtureRepo(path.join(sandbox, 'repo'), { 'README.md': '# orphans\n' });
  const created = await request(app).post('/api/repositories').set({ Authorization: `Bearer ${token}` }).send({ rootPath: repo });
  repositoryId = created.body.repository.id;
  const built = await resolveLauncher();
  if (!built) throw new Error('launcher unavailable on this machine');
  launcher = built;
  keeper = new LeaseKeeper({ instance: 'orphans-test' });
  setRetryPolicyForTests({ backoffMs: 3_600_000 });
});

afterEach(() => {
  for (const pid of strays) forceKill(pid);
  strays.clear();
});

afterAll(async () => {
  setRetryPolicyForTests(null);
  await keeper.stop();
  removeSandbox(sandbox);
});

const deadRun = (options: DeadRunOptions = {}, act?: (run: DeadRun) => Promise<void>) =>
  deadRunIn({ app, token, userId, repositoryId }, options, act);

async function runRow(id: string): Promise<Run> {
  const [row] = await db.select().from(runs).where(eq(runs.id, id));
  return row!;
}

describe('ending orphaned agent processes', () => {
  it('ends a recognized launcher and everything under it', { timeout: T }, async () => {
    const tree = await liveTree();
    expect(alive(tree.grandchild)).toBe(true);
    expect(await endOrphans(tree.identity)).toBe('cleared');
    expect(await aliveAfterKill([tree.identity.pid, tree.agent, tree.grandchild])).toEqual([false, false, false]);
  });

  it('never kills a process that merely reuses the pid', { timeout: T }, async () => {
    const pid = await bystander();
    expect(await endOrphans({ pid, tag: newLaunchTag(), host: HOST })).toBe('cleared');
    expect(alive(pid)).toBe(true);
  });

  it('counts a launcher that already exited as cleared', { timeout: T }, async () => {
    const exited = spawn(process.execPath, ['-e', '0']);
    await new Promise((resolve) => exited.once('exit', resolve));
    expect(await endOrphans({ pid: exited.pid!, tag: newLaunchTag(), host: HOST })).toBe('cleared');
  });

  it('cannot vouch for another host, or for a run started without a launcher', { timeout: T }, async () => {
    const tree = await liveTree();
    expect(await endOrphans({ ...tree.identity, host: `${HOST}-elsewhere` })).toBe('unverified');
    expect(alive(tree.grandchild)).toBe(true);
    expect(await endOrphans(null)).toBe('unverified');
  });
});

describe('recovery with a recorded launcher', () => {
  it('ends the stalled agent and retries a writer that changed nothing', { timeout: T }, async () => {
    const tree = await liveTree();
    const { ctx } = await deadRun({ repository: true, launcher: tree.identity });
    expect(alive(tree.grandchild)).toBe(true);

    await reconcileOnce(keeper);
    expect(await aliveAfterKill([tree.identity.pid, tree.agent, tree.grandchild])).toEqual([false, false, false]);
    expect(await runRow(ctx.run.id)).toMatchObject({ status: 'failed', recoveryClass: 'retry' });
    const [retry] = await db.select().from(runs).where(eq(runs.parentRunId, ctx.run.id));
    expect(retry).toMatchObject({ status: 'queued', attempt: 2 });
    await db.update(runs).set({ status: 'cancelled' }).where(eq(runs.id, retry!.id));
  });

  it('still leaves the decision to a person when the launcher is on another host', { timeout: T }, async () => {
    const tree = await liveTree();
    const { ctx } = await deadRun({ repository: true, launcher: { ...tree.identity, host: `${HOST}-elsewhere` } });
    await reconcileOnce(keeper);
    expect(alive(tree.grandchild)).toBe(true);
    expect(await runRow(ctx.run.id)).toMatchObject({ status: 'interrupted' });
  });
});
