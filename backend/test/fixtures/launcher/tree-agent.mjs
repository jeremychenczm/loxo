// An agent that starts a descendant through a short-lived shell, the way an
// npx .cmd shim or a tool call would, so the descendant outlives its parent.
// Usage: tree-agent.mjs <grandchild-pid-file> <agent-pid-file> [exit-after-ms] [exit-code]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const [grandchildFile, agentFile, exitAfter, exitCode] = process.argv.slice(2);
fs.writeFileSync(agentFile, String(process.pid));
const grandchild = fileURLToPath(new URL('./grandchild.mjs', import.meta.url));
const shim =
  process.platform === 'win32'
    ? spawn('cmd.exe', ['/d', '/s', '/c', `start "" /b "${process.execPath}" "${grandchild}" "${grandchildFile}"`], {
        stdio: 'ignore',
        windowsVerbatimArguments: true,
      })
    : spawn('/bin/sh', ['-c', `"${process.execPath}" "${grandchild}" "${grandchildFile}" &`], { stdio: 'ignore' });
shim.unref();
if (exitAfter) setTimeout(() => process.exit(Number(exitCode ?? 0)), Number(exitAfter));
else setInterval(() => {}, 1000);
