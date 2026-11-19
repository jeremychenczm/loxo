// POSIX agent launcher. Usage:
//
//   node posix-launcher.mjs --parent <pid> --tag <tag> -- <command> [args...]
//   node posix-launcher.mjs --self-test
//
// The backend starts this script detached, so it leads its own process
// group; the agent and everything it starts stay in that group. When the
// parent (the backend) is gone, the whole group is killed. When the agent
// exits on its own, whatever it left in the group is killed and the agent's
// exit code is returned. Descendants that start a new session (setsid)
// leave the group and are out of reach.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

const SETUP_FAILED = 70;
const WATCH_MS = 250;

function fail(message) {
  process.stderr.write(`loxo-launcher: ${message}\n`);
  process.exit(SETUP_FAILED);
}

/** Pids in a process group, read from /proc on Linux and from ps elsewhere. */
function groupMembers(pgid) {
  if (process.platform === 'linux') {
    const members = [];
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
        // Fields after the parenthesized command name: state, ppid, pgrp.
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (Number(fields[2]) === pgid) members.push(Number(entry));
      } catch {
        // Exited while listing.
      }
    }
    return members;
  }
  return execFileSync('ps', ['-A', '-o', 'pid=,pgid='], { encoding: 'utf8' })
    .split('\n')
    .map((row) => row.trim().split(/\s+/).map(Number))
    .filter(([pid, group]) => pid && group === pgid)
    .map(([pid]) => pid);
}

function killGroupExceptSelf() {
  for (const pid of groupMembers(process.pid)) {
    if (pid === process.pid) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

function killGroupAndExit() {
  try {
    process.kill(-process.pid, 'SIGKILL');
  } finally {
    process.exit(1);
  }
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--self-test') {
  // Only meaningful as a group leader, which is how the backend starts it.
  if (process.platform === 'win32') fail('not a POSIX system');
  process.exit(0);
}

const split = args.indexOf('--');
const parentAt = args.indexOf('--parent');
const parent = parentAt >= 0 && parentAt < split ? Number(args[parentAt + 1]) : NaN;
if (!(parent > 0) || split < 0 || split + 1 >= args.length) {
  fail('usage: --parent <pid> --tag <tag> -- <command> [args...]');
}
// A parent that is already gone left us with a different ppid (init or a subreaper).
if (process.ppid !== parent) fail('parent already exited');
if (process.platform === 'linux') {
  const stat = fs.readFileSync('/proc/self/stat', 'utf8');
  if (Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]) !== process.pid) {
    fail('not a process group leader; start the launcher detached');
  }
}

const agent = spawn(args[split + 1], args.slice(split + 2), { stdio: 'inherit' });
agent.once('error', (err) => fail(`could not start ${args[split + 1]}: ${err.message}`));
agent.once('exit', (code, signal) => {
  killGroupExceptSelf();
  process.exit(code ?? 128 + (os.constants.signals[signal] ?? 0));
});

setInterval(() => {
  if (process.ppid !== parent) killGroupAndExit();
}, WATCH_MS);
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, killGroupAndExit);
