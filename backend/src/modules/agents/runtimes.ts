export const CLI_RUNTIMES = ['claude-code', 'codex', 'opencode', 'hermes', 'openclaw'] as const;
export type CliRuntime = (typeof CLI_RUNTIMES)[number];
export type AgentRuntime = CliRuntime | 'api';

export function isAgentRuntime(value: unknown): value is AgentRuntime {
  return value === 'api' || (CLI_RUNTIMES as readonly string[]).includes(value as string);
}
