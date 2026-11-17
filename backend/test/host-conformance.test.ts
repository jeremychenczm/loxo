import { RunnerError, type TurnResult } from '@swarmdev/shared';
import { fakeAgentCommand } from '@swarmdev/fake-agent';
import { afterAll, beforeAll } from 'vitest';
import { AcpHost } from '../src/modules/hosts/acp-host';
import { ApiHost } from '../src/modules/hosts/api-host';
import type { ApiToolLoopRequest } from '../src/modules/runner/api-tool-loop';
import { describeHostContract } from './conformance/host-contract';
import { makeSandbox, removeSandbox } from './fixtures/git-repo';

let sandbox = '';
beforeAll(() => {
  sandbox = makeSandbox('conformance');
});
afterAll(() => removeSandbox(sandbox));

/** Resolves when aborted, the way a cancelled runtime call ends. */
function untilAborted(signal: AbortSignal | undefined, error: Error): Promise<never> {
  return new Promise((_, reject) => {
    signal?.addEventListener('abort', () => reject(error), { once: true });
  });
}

describeHostContract('ACP', {
  get cwd() {
    return sandbox;
  },
  replying: (text) => new AcpHost(fakeAgentCommand({ turns: [{ steps: [{ say: text }] }] })),
  slow: () => new AcpHost(fakeAgentCommand({ turns: [{ steps: [{ sleep: 60_000 }] }] })),
  failing: () => new AcpHost(fakeAgentCommand({ turns: [{ steps: [{ stderr: 'boom' }, { crash: 2 }] }] })),
});

function apiHost(execute: (r: ApiToolLoopRequest) => Promise<TurnResult>) {
  return new ApiHost({ protocol: 'openai', apiKey: 'sk-test', model: 'gpt-test', system: 'test', execute });
}

describeHostContract('provider API', {
  get cwd() {
    return sandbox;
  },
  replying: (text) => apiHost(async () => ({ text, durationMs: 1, usage: { inputTokens: 10, outputTokens: 2 } })),
  slow: () => apiHost((r) => untilAborted(r.signal, new RunnerError('API turn aborted', 'aborted'))),
  failing: () =>
    apiHost(async () => {
      throw new RunnerError('API request failed with status 500', 'api_failed');
    }),
});
