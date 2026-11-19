import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { promisify } from 'node:util';
import { childEnv } from '../../lib/child-env';

const execFileAsync = promisify(execFile);
const KILL_WAIT_MS = 5_000;
const QUERY_TIMEOUT_MS = 15_000;

export interface LauncherIdentity {
  pid: number;
  tag: string;
  host: string;
}

/** cleared: nothing of the run's agent can still be running. unverified: that cannot be shown. */
export type OrphanCheck = 'cleared' | 'unverified';

/**
 * Ends whatever is left of a run's agent processes and says whether that is
 * certain. The launcher is recognized by its pid on this host and the tag on
 * its command line; ending it ends its job or process group, so the whole
 * agent tree goes with it. A pid that is gone, or now belongs to a process
 * without the tag, means the launcher already exited, and nothing is killed.
 * Without a launcher, on another host, or when the command line cannot be
 * read, nothing can be shown.
 */
export async function endOrphans(identity: LauncherIdentity | null): Promise<OrphanCheck> {
  if (!identity || identity.host !== os.hostname()) return 'unverified';
  let state = await launcherState(identity);
  if (state === 'gone') return 'cleared';
  if (state === 'unknown') return 'unverified';
  await killTree(identity.pid);
  const t0 = Date.now();
  while (Date.now() - t0 < KILL_WAIT_MS) {
    state = await launcherState(identity);
    if (state === 'gone') return 'cleared';
    await new Promise((r) => setTimeout(r, 200));
  }
  return 'unverified';
}

async function launcherState(identity: LauncherIdentity): Promise<'running' | 'gone' | 'unknown'> {
  if (!pidAlive(identity.pid)) return 'gone';
  const commandLine = await commandLineOf(identity.pid);
  if (commandLine === null) return pidAlive(identity.pid) ? 'unknown' : 'gone';
  return commandLine.includes(identity.tag) ? 'running' : 'gone';
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: alive but someone else's.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The process's command line, '' when it has exited meanwhile, null when it cannot be read. */
async function commandLineOf(pid: number): Promise<string | null> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
        { env: childEnv('tool'), timeout: QUERY_TIMEOUT_MS, windowsHide: true }
      );
      return stdout.trim();
    }
    if (process.platform === 'linux') {
      return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ');
    }
    const { stdout } = await execFileAsync('ps', ['-o', 'command=', '-p', String(pid)], {
      env: childEnv('tool'),
      timeout: QUERY_TIMEOUT_MS,
    });
    return stdout.trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' && process.platform === 'linux') return '';
    return null;
  }
}

async function killTree(pid: number): Promise<void> {
  try {
    if (process.platform === 'win32') {
      await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { env: childEnv('tool'), windowsHide: true });
    } else {
      // The POSIX launcher leads its own process group.
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // Gone already, or not ours to kill; the state check that follows decides.
  }
}
