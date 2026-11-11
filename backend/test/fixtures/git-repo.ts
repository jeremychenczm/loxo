import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true });
  return stdout.trim();
}

/** Fresh directory outside platform storage; callers remove it in afterAll. */
export function makeSandbox(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `loxo-${label}-`));
}

export function removeSandbox(dir: string): void {
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}

/**
 * Initializes a repository on `main` with one commit and a local identity,
 * so tests never depend on the host's git configuration.
 */
export async function initFixtureRepo(
  dir: string,
  files: Record<string, string> = { 'README.md': '# fixture\n' }
): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'config', 'user.email', 'fixture@loxo.test');
  await git(dir, 'config', 'user.name', 'Loxo Fixture');
  await git(dir, 'config', 'commit.gpgsign', 'false');
  await git(dir, 'config', 'core.autocrlf', 'false');
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'initial');
  return dir;
}
