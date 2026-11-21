import fs from 'node:fs';
import path from 'node:path';
import type { CliRuntime } from '@swarmdev/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AcpHost } from '../src/modules/hosts/acp-host';
import type { PermissionRequest } from '../src/modules/hosts/host.types';
import { ACP_ADAPTERS, acpLaunchSpec, resolveAcpAdapter } from '../src/modules/hosts/runtime-catalog';
import { describeHostContract } from './conformance/host-contract';
import { initFixtureRepo, makeSandbox, removeSandbox } from './fixtures/git-repo';

/**
 * Optional suite against the real CLIs through their ACP adapters. It spends
 * model tokens, so it runs only with LOXO_REAL_CLI=1, after
 * `npm run runtimes:install`, with the CLIs logged in.
 */
const enabled = process.env.LOXO_REAL_CLI === '1';

// `npm run runtimes:install` puts the adapters under the default storage root;
// the suite's own storage root is a scratch directory.
const installRoot = path.resolve('data', 'storage', 'runtimes', 'node_modules');
for (const adapter of Object.values(ACP_ADAPTERS)) {
  const entry = path.join(installRoot, ...adapter!.package.split('/'), adapter!.entry);
  if (enabled && !process.env[adapter!.overrideEnv] && fs.existsSync(entry)) process.env[adapter!.overrideEnv] = entry;
}
const RUNTIMES: CliRuntime[] = ['claude-code', 'codex'];
const T = 240_000;

let sandbox = '';
let repo = '';
beforeAll(async () => {
  if (!enabled) return;
  sandbox = makeSandbox('real-cli');
  repo = await initFixtureRepo(path.join(sandbox, 'repo'), { 'README.md': '# real cli fixture\n' });
});
afterAll(() => {
  if (enabled) removeSandbox(sandbox);
});

for (const runtime of RUNTIMES) {
  const installed = enabled && resolveAcpAdapter(runtime).available;
  describe.skipIf(!installed)(`real ${runtime}`, () => {
    const host = () => {
      const spec = acpLaunchSpec(runtime, { permission: 'edit' });
      if (!spec) throw new Error(`${runtime} adapter not available`);
      return new AcpHost(spec, { startupTimeoutMs: 120_000 });
    };

    describeHostContract(`${runtime} over ACP`, {
      get cwd() {
        return repo;
      },
      replying: () => host(),
      slow: () => host(),
      timeoutMs: T,
      prompts: {
        reply: 'Reply with exactly the words: conformance reply. Do not use any tools.',
        slow:
          'Use your shell tool to run a command that waits 90 seconds (`sleep 90` in a POSIX shell, `Start-Sleep -Seconds 90` in PowerShell), then reply done.',
      },
      arbiter: async () => ({ outcome: 'allow', reason: 'real conformance' }),
    });

    it('routes a push through the platform arbiter', { timeout: T }, async () => {
      const asked: PermissionRequest[] = [];
      const session = await host().openSession({
        cwd: repo,
        mcpServers: [],
        arbiter: async (request) => {
          asked.push(request);
          return { outcome: 'deny', reason: 'pushing is not allowed in this test' };
        },
      });
      try {
        const outcome = await session.prompt({
          prompt: 'Run `git push origin HEAD` in this repository with your shell tool, then tell me what happened.',
        });
        expect(['end_turn', 'max_turn_requests', 'refusal']).toContain(outcome.stopReason);
        expect(asked.length).toBeGreaterThan(0);
      } finally {
        await session.close();
      }
    });
  });
}
