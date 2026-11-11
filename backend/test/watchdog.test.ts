import { fakeAgentCommand, type Scenario } from '@swarmdev/fake-agent';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AcpHost } from '../src/modules/hosts/acp-host';
import type { AgentSession } from '../src/modules/hosts/host.types';
import { withWatchdog, type WatchdogLimits } from '../src/modules/hosts/watchdog';
import { makeSandbox, removeSandbox } from './fixtures/git-repo';

const T = 30_000;
let sandbox = '';
const open: AgentSession[] = [];

/** Short windows so every limit trips within a couple of seconds. */
const FAST: Partial<WatchdogLimits> = {
  idleMs: 600,
  toolIdleMs: 4000,
  progressMs: 1200,
  maxTurnMs: 8000,
  cancelGraceMs: 800,
  repeatedLine: { minLength: 20, maxRepeats: 5 },
};

beforeAll(() => {
  sandbox = makeSandbox('watchdog');
});

afterEach(async () => {
  for (const session of open.splice(0)) await session.close();
});

afterAll(() => removeSandbox(sandbox));

async function start(scenario: Scenario, limits: Partial<WatchdogLimits> = FAST): Promise<AgentSession> {
  const inner = await new AcpHost(fakeAgentCommand(scenario)).openSession({
    cwd: sandbox,
    mcpServers: [],
    arbiter: async () => ({ outcome: 'allow', reason: 'test' }),
  });
  const session = withWatchdog(inner, limits);
  open.push(session);
  return session;
}

describe('turn watchdog', () => {
  it('leaves a healthy turn alone', { timeout: T }, async () => {
    const session = await start({ turns: [{ steps: [{ say: 'All done.' }] }] });
    expect(await session.prompt({ prompt: 'go' })).toMatchObject({ stopReason: 'end_turn', error: null });
  });

  it('times out a silent turn and keeps the session when cancel is honored', { timeout: T }, async () => {
    const session = await start({
      turns: [{ steps: [{ say: 'thinking about it' }, { hang: {} }] }, { steps: [{ say: 'recovered' }] }],
    });
    const stuck = await session.prompt({ prompt: 'go' });
    expect(stuck.stopReason).toBe('timeout');
    expect(stuck.error).toMatch(/No activity from the agent for 600 ms/);
    expect(stuck.text).toBe('thinking about it');

    const next = await session.prompt({ prompt: 'try again' });
    expect(next).toMatchObject({ stopReason: 'end_turn', text: 'recovered' });
  });

  it('kills an agent that ignores cancellation', { timeout: T }, async () => {
    const session = await start({ turns: [{ steps: [{ hang: { ignoreCancel: true } }] }] });
    const started = Date.now();
    const outcome = await session.prompt({ prompt: 'go' });
    expect(outcome.stopReason).toBe('timeout');
    expect(outcome.error).toMatch(/ignored cancellation/);
    expect(Date.now() - started).toBeLessThan(6000);
    expect((await session.prompt({ prompt: 'anyone there?' })).stopReason).toBe('crashed');
  });

  it('gives a running tool a wider quiet window', { timeout: T }, async () => {
    const session = await start({
      turns: [
        {
          steps: [
            { tool: { id: 'build', title: 'npm run build', kind: 'execute' } },
            { sleep: 1800 },
            { toolDone: { id: 'build', output: 'built' } },
            { say: 'Build finished.' },
          ],
        },
      ],
    });
    expect(await session.prompt({ prompt: 'build it' })).toMatchObject({ stopReason: 'end_turn' });
  });

  it('still times out a tool that never finishes', { timeout: T }, async () => {
    const session = await start(
      { turns: [{ steps: [{ tool: { id: 'srv', title: 'npm start', kind: 'execute' } }, { hang: {} }] }] },
      { ...FAST, toolIdleMs: 1500 }
    );
    const outcome = await session.prompt({ prompt: 'start the server' });
    expect(outcome.stopReason).toBe('timeout');
    expect(outcome.error).toMatch(/No activity from the agent for 1500 ms/);
  });

  it('stops an agent that only thinks without making progress', { timeout: T }, async () => {
    const session = await start({
      turns: [{ steps: [{ repeat: { times: 200, steps: [{ think: 'hmm' }, { sleep: 100 }] } }] }],
    });
    const outcome = await session.prompt({ prompt: 'go' });
    expect(outcome.stopReason).toBe('stalled');
    expect(outcome.error).toMatch(/no progress for 1200 ms/);
  });

  it('stops an agent that repeats itself', { timeout: T }, async () => {
    const session = await start({
      turns: [
        {
          steps: [
            { repeat: { times: 50, steps: [{ say: 'I will now run the tests. ' }, { sleep: 20 }] } },
          ],
        },
      ],
    });
    const outcome = await session.prompt({ prompt: 'go' });
    expect(outcome.stopReason).toBe('stalled');
    expect(outcome.error).toMatch(/repeated the same line 5 times/);
  });

  it('caps the length of a busy turn', { timeout: T }, async () => {
    const session = await start(
      {
        turns: [
          {
            steps: [
              {
                repeat: {
                  times: 1000,
                  steps: [
                    { tool: { id: 'loop', title: 'Run step', kind: 'execute' } },
                    { toolDone: { id: 'loop' } },
                    { sleep: 50 },
                  ],
                },
              },
            ],
          },
        ],
      },
      { ...FAST, maxTurnMs: 2000 }
    );
    const outcome = await session.prompt({ prompt: 'go' });
    expect(outcome.stopReason).toBe('timeout');
    expect(outcome.error).toMatch(/exceeded 2000 ms/);
  });
});
