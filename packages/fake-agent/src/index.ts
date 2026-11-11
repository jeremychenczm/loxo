import path from 'node:path';
import { fileURLToPath } from 'node:url';

export { parseScenario, type Scenario, type Step, type ToolKind, type TurnScript } from './scenario';

/** Absolute path of the agent entry; spawn it with a TypeScript loader such as tsx. */
export const FAKE_AGENT_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'agent.ts');
