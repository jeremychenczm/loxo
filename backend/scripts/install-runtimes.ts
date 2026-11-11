import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { ACP_ADAPTERS, runtimesDir } from '../src/modules/hosts/runtime-catalog';

/**
 * Installs the pinned ACP adapters into Loxo storage. Optional dependencies
 * are skipped: they are each adapter's bundled copy of its CLI, hundreds of
 * megabytes, and the adapters are pointed at the CLIs already installed.
 */
const dir = runtimesDir();
fs.mkdirSync(dir, { recursive: true });
if (!fs.existsSync(`${dir}/package.json`)) {
  fs.writeFileSync(`${dir}/package.json`, JSON.stringify({ name: 'loxo-runtimes', private: true }, null, 2));
}

const packages = Object.values(ACP_ADAPTERS).map((a) => `${a!.package}@${a!.version}`);
console.log(`Installing ${packages.join(', ')} into ${dir}`);
const result = spawnSync(
  'npm',
  ['install', '--prefix', dir, '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund', ...packages],
  // npm is a .cmd shim on Windows; every argument here is fixed, not user input.
  { stdio: 'inherit', shell: process.platform === 'win32' }
);
process.exit(result.status ?? 1);
