// Stands in for the backend: starts an agent command, reports both pids on
// stdout, then idles until killed. Modes: direct (no launcher), launcher, and
// launcher-outside-job (detached, so on Windows the launcher is not in this
// process's own job and only its watch on the parent can end it).
// Usage: parent.mjs <mode> <launcher-command> <command> [args...]
import { spawn } from 'node:child_process';

const [mode, launcher, command, ...args] = process.argv.slice(2);
const child =
  mode === 'direct'
    ? spawn(command, args, { stdio: 'ignore', windowsHide: true })
    : spawn(launcher, ['--parent', String(process.pid), '--tag', 'test-tag', '--', command, ...args], {
        stdio: 'ignore',
        windowsHide: true,
        detached: mode === 'launcher-outside-job' || process.platform !== 'win32',
      });
process.stdout.write(`${JSON.stringify({ parent: process.pid, top: child.pid })}\n`);
setInterval(() => {}, 1000);
