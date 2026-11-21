import path from 'node:path';
import type { AgentPermissionLevel } from '../../db/schema';
import { CONTROL_PLANE_SERVER, CONTROL_PLANE_TOOLS } from '../control-plane/names';
import type { PermissionRequest } from './host.types';

/**
 * Platform-side permission policy. Runtimes ask before acting; this decides
 * from the turn's effective permission and its assigned worktree. It never
 * trusts the runtime's own sandbox settings. Pure, so every branch is
 * covered by table tests.
 */

export interface PolicyContext {
  /** The agent's ceiling, lowered to read_only for review runs. */
  permission: AgentPermissionLevel;
  /** Absolute root the turn may touch; null means no code access at all. */
  workspaceRoot: string | null;
}

export type PolicyOutcome = 'allow' | 'deny' | 'ask';

export interface PolicyVerdict {
  outcome: PolicyOutcome;
  reason: string;
  /** Stable rule id for audit and tests. */
  rule: string;
}

const RANK: Record<AgentPermissionLevel, number> = { read_only: 0, edit: 1, full: 2 };

export function lowestPermission(...levels: AgentPermissionLevel[]): AgentPermissionLevel {
  return levels.reduce((low, level) => (RANK[level] < RANK[low] ? level : low), 'full');
}

/** Comparable host path: resolved, forward slashes, case-folded on Windows. */
function comparable(p: string): string {
  const resolved = path.resolve(p).replace(/\\/g, '/');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInside(target: string, root: string): boolean {
  const t = comparable(target);
  const r = comparable(root).replace(/\/$/, '');
  return t === r || t.startsWith(`${r}/`);
}

/**
 * Commands that always need a person, at every permission level: they reach
 * outside the worktree's history, the machine, or the outside world.
 */
const DANGEROUS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bgit\s+push\b/i, label: 'git push' },
  { pattern: /\bgit\s+reset\s+--hard\b/i, label: 'git reset --hard' },
  { pattern: /\bgit\s+clean\b[^|;&]*\s-[a-z]*f/i, label: 'git clean -f' },
  { pattern: /\bgit\s+branch\s+-D\b/, label: 'git branch -D' },
  { pattern: /\bgit\s+(remote|config)\b/i, label: 'git remote/config change' },
  { pattern: /\bsudo\b|\bsu\s+-|\brunas\b/i, label: 'privilege escalation' },
  { pattern: /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf][a-z]*\s+(\/|~|\*|\.\.|[a-z]:[\\/])/i, label: 'recursive delete outside the worktree' },
  { pattern: /\b(curl|wget|iwr|invoke-webrequest)\b[^|]*\|\s*(sh|bash|zsh|python\d?|node|iex|powershell)\b/i, label: 'piping a download into a shell' },
  { pattern: /\bchmod\s+(-[a-z]*r|.*777)|\bchown\b|\bicacls\b/i, label: 'permission change' },
  { pattern: /\bmkfs\b|\bdd\s+if=|\bformat\s+[a-z]:|\bdiskpart\b/i, label: 'disk operation' },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/i, label: 'machine power' },
  { pattern: /\b(npm|yarn|pnpm)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b/i, label: 'package publish' },
  { pattern: /\bgh\s+(pr\s+(merge|close)|release|repo\s+(delete|edit))\b/i, label: 'GitHub write' },
  { pattern: /\b(terraform\s+(apply|destroy)|kubectl\s+(delete|apply)|helm\s+(install|upgrade|uninstall))\b/i, label: 'infrastructure change' },
  { pattern: /\bdocker\b[^|;&]*--privileged/i, label: 'privileged container' },
  { pattern: /:\(\)\s*\{\s*:\s*\|/, label: 'fork bomb' },
  { pattern: /\bremove-item\b[^|;&]*-recurse/i, label: 'recursive delete' },
  { pattern: /\bdel\s+\/[sq]\b|\brd\s+\/s\b/i, label: 'recursive delete' },
];

/** Programs that only read, for read-only turns. Anything else is refused there. */
const READ_ONLY_PROGRAMS = new Set([
  'ls', 'dir', 'cat', 'type', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'pwd', 'echo',
  'which', 'where', 'tree', 'stat', 'file', 'sort', 'uniq', 'cut', 'diff', 'less', 'more',
]);

/** git subcommands that do not move refs or touch the working tree. */
const READ_ONLY_GIT = new Set([
  'status', 'diff', 'log', 'show', 'blame', 'rev-parse', 'ls-files', 'grep', 'shortlog', 'describe', 'cat-file',
]);

/** Extracts the command line from a runtime's tool input, falling back to the title. */
export function commandOf(request: PermissionRequest): string {
  const input = request.input as Record<string, unknown> | null | undefined;
  const raw = input && typeof input === 'object' ? (input.command ?? input.cmd ?? input.commandLine) : undefined;
  if (Array.isArray(raw)) return raw.map(String).join(' ');
  if (typeof raw === 'string') return raw;
  return request.title;
}

/** Splits on shell sequencing and pipes; good enough to vet each program. */
function segments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\||\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function programOf(segment: string): { program: string; args: string[] } {
  const tokens = segment.split(/\s+/).filter((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
  const program = path.basename((tokens[0] ?? '').replace(/^["']|["']$/g, '')).toLowerCase().replace(/\.exe$/, '');
  return { program, args: tokens.slice(1) };
}

function readOnlyCommand(command: string): { ok: boolean; why: string } {
  if (/(^|[^<>])>{1,2}(?!&)/.test(command.replace(/2>&1|>\s*\/dev\/null|>\s*nul\b/gi, ''))) {
    return { ok: false, why: 'output redirection writes files' };
  }
  for (const segment of segments(command)) {
    const { program, args } = programOf(segment);
    if (program === 'git') {
      const sub = args.find((a) => !a.startsWith('-')) ?? '';
      if (!READ_ONLY_GIT.has(sub)) return { ok: false, why: `git ${sub} can change the repository` };
      continue;
    }
    if (program === 'find' && args.some((a) => /^-(exec|execdir|delete|ok|fprint)/.test(a))) {
      return { ok: false, why: 'find with an action can modify files' };
    }
    if (!READ_ONLY_PROGRAMS.has(program)) return { ok: false, why: `${program || 'the command'} is not a read-only program` };
  }
  return { ok: true, why: '' };
}

const verdict = (outcome: PolicyOutcome, rule: string, reason: string): PolicyVerdict => ({ outcome, rule, reason });

const CONTROL_PLANE_TOOL_NAMES = new Set<string>(CONTROL_PLANE_TOOLS.map((tool) => `mcp__${CONTROL_PLANE_SERVER}__${tool}`));

export function evaluatePermission(request: PermissionRequest, context: PolicyContext): PolicyVerdict {
  const { permission, workspaceRoot } = context;
  // The run token and the control plane decide what these calls may do, under the run's fence.
  if (request.toolName && CONTROL_PLANE_TOOL_NAMES.has(request.toolName)) {
    return verdict('allow', 'kind.control-plane', 'A call to the platform control plane');
  }

  for (const p of request.paths) {
    if (!workspaceRoot || !isInside(p, workspaceRoot)) {
      return verdict('deny', 'path.outside', `${p} is outside the assigned worktree`);
    }
  }

  switch (request.toolKind) {
    case 'think':
      return verdict('allow', 'kind.think', 'Thinking touches nothing');
    case 'read':
    case 'search':
      return workspaceRoot
        ? verdict('allow', 'kind.read', 'Reading inside the worktree')
        : verdict('deny', 'kind.read.no-workspace', 'This turn has no code access');
    case 'edit':
    case 'delete':
    case 'move':
      if (!workspaceRoot) return verdict('deny', 'kind.write.no-workspace', 'This turn has no code access');
      return RANK[permission] >= RANK.edit
        ? verdict('allow', 'kind.write', 'Writing inside the worktree')
        : verdict('deny', 'kind.write.read-only', 'This turn is read-only');
    case 'fetch':
      return RANK[permission] >= RANK.edit
        ? verdict('allow', 'kind.fetch', 'Network reads are allowed for writing turns')
        : verdict('ask', 'kind.fetch.read-only', 'A read-only turn wants network access');
    case 'switch_mode':
      return verdict('deny', 'kind.switch-mode', 'Agents may not change their own operating mode');
    case 'execute': {
      if (!workspaceRoot) return verdict('deny', 'exec.no-workspace', 'This turn has no code access');
      const command = commandOf(request);
      const danger = DANGEROUS.find((d) => d.pattern.test(command));
      if (danger) return verdict('ask', 'exec.dangerous', `${danger.label} needs a person: ${command}`);
      if (RANK[permission] >= RANK.edit) return verdict('allow', 'exec.allowed', 'Command inside the worktree');
      const readOnly = readOnlyCommand(command);
      return readOnly.ok
        ? verdict('allow', 'exec.read-only', 'Read-only command')
        : verdict('deny', 'exec.read-only.refused', `This turn is read-only; ${readOnly.why}`);
    }
    default:
      return verdict('ask', 'kind.unknown', `Unrecognized tool "${request.toolKind}": ${request.title}`);
  }
}
