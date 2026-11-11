import fs from 'node:fs';
import path from 'node:path';
import type { CliRuntime, TurnCredentials, TurnPermission } from '@swarmdev/shared';
import { storage } from '../../storage/layout';
import type { AcpLaunchSpec } from './acp-host';
import type { HostTransport } from './host.types';

/**
 * Which transport each runtime uses and how its permissions are enforced.
 * Claude Code and Codex reach ACP through official adapters that reuse the
 * locally installed CLI and its login; every other CLI runs a process per
 * turn. Adapters are installed on purpose (`npm run runtimes:install`), never
 * fetched at run time.
 */

export interface AcpAdapter {
  package: string;
  version: string;
  /** Entry script inside the package. */
  entry: string;
  /** The CLI the adapter drives, and the env var that points it there. */
  cli: { command: string; env: string };
  /** Env var that overrides the adapter location entirely. */
  overrideEnv: string;
}

export const ACP_ADAPTERS: Partial<Record<CliRuntime, AcpAdapter>> = {
  'claude-code': {
    package: '@agentclientprotocol/claude-agent-acp',
    version: '0.106.0',
    entry: 'dist/index.js',
    cli: { command: 'claude', env: 'CLAUDE_CODE_EXECUTABLE' },
    overrideEnv: 'LOXO_CLAUDE_ACP_COMMAND',
  },
  codex: {
    package: '@agentclientprotocol/codex-acp',
    version: '2.6.0',
    entry: 'dist/index.js',
    cli: { command: 'codex', env: 'CODEX_PATH' },
    overrideEnv: 'LOXO_CODEX_ACP_COMMAND',
  },
};

/** Where `runtimes:install` puts pinned adapters; inside Loxo storage, not the global prefix. */
export function runtimesDir(): string {
  return path.join(storage.root, 'runtimes');
}

/** PATH lookup that honors PATHEXT, so it finds claude.exe and codex.cmd alike. */
export function findExecutable(command: string): string | null {
  const exts =
    process.platform === 'win32'
      ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase())]
      : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

function scriptSpec(file: string): Pick<AcpLaunchSpec, 'command' | 'args'> {
  return /\.(c|m)?js$/i.test(file) ? { command: process.execPath, args: [file] } : { command: file, args: [] };
}

export type AdapterResolution =
  | { available: true; source: 'override' | 'local'; launch: Pick<AcpLaunchSpec, 'command' | 'args'>; cliPath: string | null }
  | { available: false; reason: string };

const testOverrides = new Map<CliRuntime, AcpLaunchSpec | null>();

/** Test seam: force a runtime onto a given ACP launch spec, or off ACP with null. */
export function setAcpLaunchForTests(runtime: CliRuntime, spec: AcpLaunchSpec | null | undefined): void {
  if (spec === undefined) testOverrides.delete(runtime);
  else testOverrides.set(runtime, spec);
}

export function resolveAcpAdapter(runtime: CliRuntime): AdapterResolution {
  const adapter = ACP_ADAPTERS[runtime];
  if (!adapter) return { available: false, reason: `${runtime} has no ACP adapter; it runs one process per turn` };
  const cliPath = findExecutable(adapter.cli.command);
  const override = process.env[adapter.overrideEnv]?.trim();
  if (override) return { available: true, source: 'override', launch: scriptSpec(override), cliPath };
  const local = path.join(runtimesDir(), 'node_modules', ...adapter.package.split('/'), adapter.entry);
  if (fs.existsSync(local)) return { available: true, source: 'local', launch: scriptSpec(local), cliPath };
  return {
    available: false,
    reason: `${adapter.package} is not installed; run \`npm run runtimes:install\` to enable live sessions`,
  };
}

export interface LaunchOptions {
  credentials?: TurnCredentials | null;
  model?: string | null;
  permission: TurnPermission;
}

/** Codex's own sandbox mirrors the turn level; the platform still arbitrates each request. */
const CODEX_MODES: Record<TurnPermission, string> = {
  read_only: 'read-only',
  edit: 'workspace-write',
  full: 'agent-full-access',
};

/** The ACP launch spec for a runtime and turn, or null when it must fall back to a process per turn. */
export function acpLaunchSpec(runtime: CliRuntime, options: LaunchOptions): AcpLaunchSpec | null {
  if (testOverrides.has(runtime)) return testOverrides.get(runtime) ?? null;
  const resolved = resolveAcpAdapter(runtime);
  if (!resolved.available) return null;
  const adapter = ACP_ADAPTERS[runtime]!;
  const env: Record<string, string> = {};
  if (resolved.cliPath) env[adapter.cli.env] = resolved.cliPath;
  const key = options.credentials?.apiKey;
  const baseUrl = options.credentials?.baseUrl ?? undefined;
  if (runtime === 'claude-code') {
    if (key) env.ANTHROPIC_API_KEY = key;
    if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
    if (options.model) env.ANTHROPIC_MODEL = options.model;
  } else if (runtime === 'codex') {
    if (key) env.CODEX_API_KEY = key;
    if (options.model) env.CODEX_CONFIG = JSON.stringify({ model: options.model });
    env.INITIAL_AGENT_MODE = CODEX_MODES[options.permission];
    env.NO_BROWSER = '1';
  }
  return { ...resolved.launch, env };
}

export interface RuntimeProfile {
  runtime: string;
  transport: HostTransport;
  /** platform: Loxo decides each request; cli_flags: fixed per turn by command-line flags. */
  permissions: 'platform' | 'cli_flags' | 'read_only_tools';
  liveEvents: boolean;
  resume: boolean;
  note: string | null;
}

/** The capability row the product shows for a runtime, given what is installed right now. */
export function runtimeProfile(runtime: string): RuntimeProfile {
  if (runtime === 'api') {
    return { runtime, transport: 'api', permissions: 'read_only_tools', liveEvents: true, resume: false, note: 'Reads the worktree through platform tools only' };
  }
  const cli = runtime as CliRuntime;
  const resolved = resolveAcpAdapter(cli);
  if (resolved.available) {
    return { runtime, transport: 'acp', permissions: 'platform', liveEvents: true, resume: true, note: null };
  }
  return {
    runtime,
    transport: 'process',
    permissions: 'cli_flags',
    liveEvents: cli === 'claude-code',
    resume: cli === 'claude-code',
    note: resolved.reason,
  };
}
