import { CLI_RUNTIMES, type CliRuntime } from '@swarmdev/shared';

export { CLI_RUNTIMES, type CliRuntime };
export type AgentRuntime = CliRuntime | 'api';

export function isAgentRuntime(value: unknown): value is AgentRuntime {
  return value === 'api' || (CLI_RUNTIMES as readonly string[]).includes(value as string);
}
