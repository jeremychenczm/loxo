/**
 * Environment for processes Loxo spawns. Agents and repository hooks run code
 * Loxo does not control, so they get an allowlist rather than the backend's
 * own environment, which holds the database URL and signing keys.
 */

const SYSTEM_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TZ',
  'TMPDIR',
  'TERM',
  'COLORTERM',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR',
  // Windows
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'USERNAME',
  'USERDOMAIN',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'TEMP',
  'TMP',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
];

const NETWORK_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
];

/** agent: coding agents; git: platform Git calls; tool: platform helpers that need only the system. */
export type ChildKind = 'agent' | 'git' | 'tool';

const PREFIXES: Record<ChildKind, readonly string[]> = {
  agent: ['ANTHROPIC_', 'CLAUDE_', 'CODEX_', 'OPENAI_'],
  git: ['GIT_'],
  tool: [],
};

// Git commands address repositories by cwd; an inherited repository override
// would silently point them at a different repository.
const EXCLUDED = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']);

const ALLOWED = new Set([...SYSTEM_KEYS, ...NETWORK_KEYS]);

/**
 * Allowlisted copy of `source` for a child of the given kind, with `extra`
 * applied last. Keys compare case-insensitively because Windows environment
 * names are case-insensitive; the original spelling is kept.
 */
export function childEnv(
  kind: ChildKind,
  extra: Record<string, string> = {},
  source: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (EXCLUDED.has(upper)) continue;
    if (ALLOWED.has(upper) || PREFIXES[kind].some((prefix) => upper.startsWith(prefix))) {
      env[key] = value;
    }
  }
  return { ...env, ...extra };
}
