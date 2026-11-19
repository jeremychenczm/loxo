// Dependency-free check of the POSIX launcher, runnable with plain node on
// Linux or macOS (including WSL, where the Windows node_modules cannot run).
// The vitest suite calls it on POSIX hosts. Exits nonzero on any failure.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(here, name);
const LAUNCHER = path.resolve(here, '../../../src/modules/hosts/launcher/posix-launcher.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loxo-posix-launcher-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strays = new Set();
let failures = 0;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function kill(pid) {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Gone.
  }
}

async function pidFrom(file) {
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

async function goneWithin(pids, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pids.every((pid) => !alive(pid))) return Date.now() - t0;
    await sleep(50);
  }
  return null;
}

function exitOf(child) {
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)));
}

/** The exit code, or 'timeout' (after killing the child's tree) when it is still running after `ms`. */
async function exitWithin(child, ms) {
  const timer = sleep(ms).then(() => 'timeout');
  const result = await Promise.race([exitOf(child), timer]);
  if (result === 'timeout') {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      kill(child.pid);
    }
  }
  return result;
}

const launch = (agentCommand, agentArgs, tag = 'check-tag') => [
  LAUNCHER,
  '--parent',
  String(process.pid),
  '--tag',
  tag,
  '--',
  agentCommand,
  ...agentArgs,
];

async function tree(mode) {
  const g = path.join(dir, `g-${Math.random()}.pid`);
  const a = path.join(dir, `a-${Math.random()}.pid`);
  const parent = spawn(process.execPath, [fixture('parent.mjs'), mode, LAUNCHER, process.execPath, fixture('tree-agent.mjs'), g, a], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const line = await new Promise((resolve) => readline.createInterface({ input: parent.stdout }).once('line', resolve));
  const ids = JSON.parse(line);
  strays.add(ids.parent);
  strays.add(ids.top);
  const agent = await pidFrom(a);
  const grandchild = await pidFrom(g);
  await sleep(500);
  return { ...ids, agent, grandchild };
}

async function check(name, body) {
  try {
    await body();
    console.log(`PASS ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL ${name}: ${err instanceof Error ? err.message : err}`);
  } finally {
    for (const pid of strays) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        kill(pid);
      }
    }
    strays.clear();
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

await check('self-test passes when started as a group leader', async () => {
  const child = spawn(process.execPath, [LAUNCHER, '--self-test'], { stdio: 'ignore', detached: true });
  expect((await exitOf(child)) === 0, 'self-test did not exit 0');
});

await check('a descendant behind an exited shell outlives the backend without the launcher', async () => {
  const direct = await tree('direct');
  expect(alive(direct.grandchild), 'grandchild not running');
  kill(direct.parent);
  await sleep(1500);
  expect(alive(direct.grandchild), 'grandchild died without a launcher; the control proves nothing');
});

await check('with the launcher, that descendant dies with the backend', async () => {
  const managed = await tree('launcher');
  expect(alive(managed.grandchild), 'grandchild not running');
  kill(managed.parent);
  const ms = await goneWithin([managed.top, managed.agent, managed.grandchild], 5000);
  expect(ms !== null, 'tree still alive 5 s after the backend died');
  console.log(`     (tree gone ${ms} ms after the backend died)`);
});

await check("an agent that exits on its own leaves nothing behind and its code comes back", async () => {
  const g = path.join(dir, 'exit-g.pid');
  const a = path.join(dir, 'exit-a.pid');
  const child = spawn(process.execPath, launch(process.execPath, [fixture('tree-agent.mjs'), g, a, '1500', '7']), {
    stdio: 'ignore',
    detached: true,
  });
  strays.add(child.pid);
  const exit = exitOf(child);
  const grandchild = await pidFrom(g);
  expect(alive(grandchild), 'grandchild not running');
  const code = await exit;
  expect(code === 7, `exit code ${code}, expected 7`);
  expect((await goneWithin([grandchild], 3000)) !== null, 'grandchild left behind');
});

await check('killing the launcher group, as the backend does, ends the tree', async () => {
  const managed = await tree('launcher');
  process.kill(-managed.top, 'SIGKILL');
  expect((await goneWithin([managed.agent, managed.grandchild], 5000)) !== null, 'tree still alive');
  expect(alive(managed.parent), 'parent should be untouched');
});

await check('stdio and arguments pass through untouched', async () => {
  const args = ['plain', 'two words', 'say "hi"', 'trailing\\', "it's", '', 'tab\there', '$HOME'];
  const child = spawn(process.execPath, launch(process.execPath, [fixture('echo-agent.mjs'), ...args]), {
    stdio: ['pipe', 'pipe', 'inherit'],
    detached: true,
  });
  strays.add(child.pid);
  const lines = [];
  readline.createInterface({ input: child.stdout }).on('line', (l) => lines.push(l));
  const exit = exitOf(child);
  child.stdin.write('ping\nbye\n');
  const code = await exit;
  expect(code === 3, `exit code ${code}, expected 3`);
  expect(JSON.stringify(JSON.parse(lines[0])) === JSON.stringify(args), `arguments came back as ${lines[0]}`);
  expect(lines[1] === 'echo:ping', `stdin echo was ${lines[1]}`);
});

await check('refuses to start without its parent or outside its own process group', async () => {
  const staleMarker = path.join(dir, 'stale.pid');
  const stale = spawn(process.execPath, ['-e', '0']);
  await exitOf(stale);
  const staleArgs = launch(process.execPath, [fixture('grandchild.mjs'), staleMarker]);
  staleArgs[staleArgs.indexOf('--parent') + 1] = String(stale.pid);
  const orphaned = spawn(process.execPath, staleArgs, { stdio: 'ignore', detached: true });
  expect((await exitWithin(orphaned, 5000)) === 70, 'started under a parent that is gone');
  await sleep(500);
  expect(!fs.existsSync(staleMarker), 'the agent was started under a parent that is gone');
  if (process.platform === 'linux') {
    const leaderMarker = path.join(dir, 'not-leader.pid');
    const notLeader = spawn(process.execPath, launch(process.execPath, [fixture('grandchild.mjs'), leaderMarker]), { stdio: 'ignore' });
    strays.add(notLeader.pid);
    const code = await exitWithin(notLeader, 5000);
    expect(code === 70, `started without leading a group (exit ${code})`);
    await sleep(500);
    expect(!fs.existsSync(leaderMarker), 'the agent was started without a group to kill');
  }
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? 'ALL PASSED' : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
