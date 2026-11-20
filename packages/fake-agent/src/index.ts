import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Scenario } from './scenario';

export { parseScenario, type Scenario, type Step, type ToolKind, type TurnScript } from './scenario';

/** Absolute path of the agent entry. */
export const FAKE_AGENT_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'agent.ts');

export interface FakeAgentOptions {
  /** Directory the agent witnesses its prompts in (see agent.ts). */
  witnessDir?: string;
}

/**
 * Command that starts the fake agent playing `scenario`. The TypeScript
 * loader is referenced by absolute URL so the process can run in any cwd.
 */
export function fakeAgentCommand(
  scenario: Scenario,
  options: FakeAgentOptions = {}
): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  return {
    command: process.execPath,
    args: ['--import', loader, FAKE_AGENT_ENTRY],
    env: {
      LOXO_FAKE_AGENT_SCENARIO: JSON.stringify(scenario),
      ...(options.witnessDir ? { LOXO_FAKE_AGENT_WITNESS_DIR: options.witnessDir } : {}),
    },
  };
}
