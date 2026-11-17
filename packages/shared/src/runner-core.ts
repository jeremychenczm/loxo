import { execFileSync } from 'node:child_process';

/** Coding CLIs Loxo drives over the Agent Client Protocol. */
export const CLI_RUNTIMES = ['claude-code', 'codex'] as const;

export type CliRuntime = (typeof CLI_RUNTIMES)[number];

function killTree(pid: number | undefined, fallback: () => void): void {
  if (process.platform === 'win32' && pid) {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      return;
    } catch {
      // fall through
    }
  }
  fallback();
}

/**
 * Kills a child and everything it spawned. On POSIX the child must have been
 * started with `detached: true` so that it leads its own process group.
 */
export function killProcessTree(child: { pid?: number; kill(signal?: NodeJS.Signals): boolean }): void {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // Not a group leader or already gone; fall back to the child alone.
    }
  }
  killTree(child.pid, () => child.kill('SIGKILL'));
}

export interface TurnCredentials {
  apiKey?: string;
  baseUrl?: string | null;
}

/**
 * Permission posture for a turn. Mirrors the agent permission level; callers
 * resolve the effective value (review turns are forced down to read_only).
 */
export type TurnPermission = 'read_only' | 'edit' | 'full';

const PERMISSION_RANK: Record<TurnPermission, number> = { read_only: 0, edit: 1, full: 2 };

/** The more restrictive of two levels; a turn may lower permission, never raise it. */
export function lowerPermission(a: TurnPermission, b: TurnPermission): TurnPermission {
  return PERMISSION_RANK[a] <= PERMISSION_RANK[b] ? a : b;
}

/** Result of one provider API turn. */
export interface TurnResult {
  text: string;
  durationMs: number;
  /** Summed over every request the turn made, when the provider reports it. */
  usage?: { inputTokens: number; outputTokens: number };
}

export type RunnerErrorKind = 'timeout' | 'aborted' | 'cli_failed' | 'api_failed' | 'bad_output';

export class RunnerError extends Error {
  constructor(
    message: string,
    public readonly kind: RunnerErrorKind
  ) {
    super(message);
    this.name = 'RunnerError';
  }
}

/** Strips ANSI codes and anything resembling a credential from CLI output. */
export function redactDiagnostic(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
}
