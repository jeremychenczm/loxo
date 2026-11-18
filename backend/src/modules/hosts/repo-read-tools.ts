import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { badRequest } from '../../http/errors';
import { cleanRelativePath, resolveInside } from '../../storage/path-safety';
import type { ApiToolDefinition } from '../runner/api-tool-loop';
import { childEnv } from '../../lib/child-env';

/**
 * Read-only views of a worktree for members that have no file system of
 * their own (provider-API agents). Every path resolves inside the root, and
 * every result is bounded so one call cannot flood the context window.
 */

const execFileAsync = promisify(execFile);

export const MAX_RESULT_CHARS = 64_000;
const MAX_FILE_BYTES = 1_000_000;
const MAX_LISTED_FILES = 2000;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.next', 'out', 'build', '.venv', '__pycache__']);

export interface RepoReadContext {
  root: string;
  /** Diff base; without it the diff is against HEAD. */
  baseCommit?: string | null;
}

function cap(text: string): string {
  return text.length > MAX_RESULT_CHARS
    ? `${text.slice(0, MAX_RESULT_CHARS)}\n… [truncated ${text.length - MAX_RESULT_CHARS} chars]`
    : text;
}

async function git(root: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: root,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      env: childEnv('git', { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }),
    });
    return stdout;
  } catch {
    return null;
  }
}

function resolvePath(root: string, input: unknown, allowEmpty: boolean): string {
  const raw = typeof input === 'string' ? input.trim().replace(/^\.\/?/, '') : '';
  if (!raw) {
    if (allowEmpty) return path.resolve(root);
    throw badRequest('invalid_path', 'path is required');
  }
  const clean = cleanRelativePath(raw);
  if (clean === null) throw badRequest('invalid_path', `${raw} must be a relative path inside the worktree`);
  return resolveInside(root, clean);
}

function walk(root: string, dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (out.length >= MAX_LISTED_FILES + 1) return;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(root, path.join(dir, entry.name), out);
    } else {
      out.push(path.relative(root, path.join(dir, entry.name)).replace(/\\/g, '/'));
    }
  }
}

async function readFile(ctx: RepoReadContext, args: Record<string, unknown>): Promise<string> {
  const target = resolvePath(ctx.root, args.path, false);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    throw badRequest('not_found', `${String(args.path)} does not exist`);
  }
  if (stat.isDirectory()) throw badRequest('is_directory', `${String(args.path)} is a directory; use list_files`);
  if (stat.size > MAX_FILE_BYTES) throw badRequest('too_large', `${String(args.path)} is ${stat.size} bytes; read a line range of a smaller file`);
  const buffer = fs.readFileSync(target);
  if (buffer.includes(0)) return `${String(args.path)} is a binary file (${stat.size} bytes)`;
  const lines = buffer.toString('utf8').split('\n');
  const start = Math.max(1, Number(args.startLine) || 1);
  const end = Math.min(lines.length, Number(args.endLine) || lines.length);
  const width = String(end).length;
  const body = lines
    .slice(start - 1, end)
    .map((line, i) => `${String(start + i).padStart(width, ' ')}| ${line}`)
    .join('\n');
  return cap(`${String(args.path)} (lines ${start}-${end} of ${lines.length})\n${body}`);
}

async function listFiles(ctx: RepoReadContext, args: Record<string, unknown>): Promise<string> {
  const dir = resolvePath(ctx.root, args.path, true);
  const prefix = path.relative(path.resolve(ctx.root), dir).replace(/\\/g, '/');
  const tracked = await git(ctx.root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  let files: string[];
  if (tracked !== null) {
    files = tracked.split('\0').filter((f) => f && (!prefix || f === prefix || f.startsWith(`${prefix}/`)));
  } else {
    files = [];
    if (fs.existsSync(dir)) walk(path.resolve(ctx.root), dir, files);
  }
  files.sort();
  const shown = files.slice(0, MAX_LISTED_FILES);
  const more = files.length > MAX_LISTED_FILES ? `\n… ${files.length - MAX_LISTED_FILES} more files` : '';
  return shown.length > 0 ? cap(`${shown.join('\n')}${more}`) : 'No files';
}

async function getDiff(ctx: RepoReadContext): Promise<string> {
  const base = ctx.baseCommit && /^[0-9a-f]{40}$/.test(ctx.baseCommit) ? ctx.baseCommit : 'HEAD';
  const stat = await git(ctx.root, ['diff', '--stat', base, '--']);
  if (stat === null) throw badRequest('not_a_repository', 'The worktree is not a Git repository');
  const patch = (await git(ctx.root, ['diff', '--no-ext-diff', base, '--'])) ?? '';
  const untracked = ((await git(ctx.root, ['ls-files', '--others', '--exclude-standard'])) ?? '').trim();
  const sections = [
    stat.trim() ? `Changes against ${base === 'HEAD' ? 'HEAD' : base.slice(0, 12)}:\n${stat.trim()}` : 'No changes to tracked files',
    untracked ? `Untracked files:\n${untracked}` : '',
    patch.trim(),
  ].filter(Boolean);
  return cap(sections.join('\n\n'));
}

export function repoReadTools(ctx: RepoReadContext): ApiToolDefinition[] {
  return [
    {
      name: 'read_file',
      description: 'Read a text file in the worktree, optionally a line range. Lines are numbered.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the worktree root' },
          startLine: { type: 'integer', minimum: 1 },
          endLine: { type: 'integer', minimum: 1 },
        },
        required: ['path'],
      },
      execute: (args) => readFile(ctx, args),
    },
    {
      name: 'list_files',
      description: 'List files in the worktree, honoring .gitignore. Optionally limit to a directory.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory relative to the root' } },
      },
      execute: (args) => listFiles(ctx, args),
    },
    {
      name: 'get_diff',
      description: 'Show every change in the worktree against the task base, including untracked files.',
      parameters: { type: 'object', properties: {} },
      execute: () => getDiff(ctx),
    },
  ];
}
