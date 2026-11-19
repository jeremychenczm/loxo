import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { childEnv } from '../../../lib/child-env';
import { storage } from '../../../storage/layout';
import { WINDOWS_LAUNCHER_SOURCE } from './windows-launcher-source';

const execFileAsync = promisify(execFile);
const BUILD_TIMEOUT_MS = 60_000;

/**
 * A process that stands between the backend and an agent and takes the
 * agent's whole process tree down when the backend dies. job-object: the
 * Windows launcher; process-group: the POSIX one.
 */
export interface Launcher {
  kind: 'job-object' | 'process-group';
  command: string;
  /** Arguments before the launcher's own options. */
  prefixArgs: string[];
}

export interface LaunchCommand {
  command: string;
  args: string[];
}

let resolved: Promise<Launcher | null> | undefined;
let override: Launcher | null | undefined;

/** Test seam: force a launcher, or none (null); undefined restores the real one. */
export function setLauncherForTests(launcher: Launcher | null | undefined): void {
  override = launcher;
}

/**
 * The launcher for this platform, built and self-tested once per process.
 * Null when none can run here; agents then start directly, and recovery
 * treats their descendants as possibly still alive.
 */
export function resolveLauncher(): Promise<Launcher | null> {
  if (override !== undefined) return Promise.resolve(override);
  // Operator escape hatch, and the control arm of crash drills.
  if (process.env.LOXO_AGENT_LAUNCHER === 'off') return Promise.resolve(null);
  resolved ??= (process.platform === 'win32' ? buildWindowsLauncher() : checkPosixLauncher()).catch((err) => {
    console.warn(`Agent launcher unavailable; agents start directly: ${err instanceof Error ? err.message : err}`);
    return null;
  });
  return resolved;
}

/** A fresh identity for one launch; recovery recognizes the launcher by it. */
export function newLaunchTag(): string {
  return crypto.randomBytes(12).toString('hex');
}

/** Runs `agent` under the launcher, tied to this backend process. */
export function underLauncher(launcher: Launcher, agent: LaunchCommand, tag: string): LaunchCommand {
  return {
    command: launcher.command,
    args: [...launcher.prefixArgs, '--parent', String(process.pid), '--tag', tag, '--', agent.command, ...agent.args],
  };
}

/** The POSIX launcher is a script run with this node; it only has to pass its self-test. */
async function checkPosixLauncher(): Promise<Launcher> {
  const script = fileURLToPath(new URL('./posix-launcher.mjs', import.meta.url));
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [script, '--self-test'], { stdio: 'ignore', detached: true, env: childEnv('tool') });
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`self-test exited with ${code}`))));
  });
  return { kind: 'process-group', command: process.execPath, prefixArgs: [script] };
}

/**
 * Compiles the C# launcher with the .NET Framework compiler that ships with
 * Windows. The output name carries the source hash, so a changed source is
 * rebuilt and concurrent builds never overwrite a binary in use.
 */
async function buildWindowsLauncher(): Promise<Launcher> {
  const dir = path.join(storage.root, 'runtimes', 'launcher');
  const hash = crypto.createHash('sha256').update(WINDOWS_LAUNCHER_SOURCE).digest('hex').slice(0, 12);
  const exe = path.join(dir, `loxo-launcher-${hash}.exe`);
  if (!fs.existsSync(exe)) {
    const csc = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    if (!fs.existsSync(csc)) throw new Error(`no C# compiler at ${csc}`);
    fs.mkdirSync(dir, { recursive: true });
    const stem = path.join(dir, `build-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    fs.writeFileSync(`${stem}.cs`, WINDOWS_LAUNCHER_SOURCE);
    try {
      await execFileAsync(csc, ['/nologo', '/optimize+', '/target:exe', `/out:${stem}.exe`, `${stem}.cs`], {
        env: childEnv('tool'),
        timeout: BUILD_TIMEOUT_MS,
        windowsHide: true,
      });
      try {
        fs.renameSync(`${stem}.exe`, exe);
      } catch (err) {
        // Another build got there first; its binary is identical.
        if (!fs.existsSync(exe)) throw err;
      }
    } finally {
      fs.rmSync(`${stem}.cs`, { force: true });
      fs.rmSync(`${stem}.exe`, { force: true });
    }
  }
  await execFileAsync(exe, ['--self-test'], { env: childEnv('tool'), timeout: BUILD_TIMEOUT_MS, windowsHide: true });
  return { kind: 'job-object', command: exe, prefixArgs: [] };
}
