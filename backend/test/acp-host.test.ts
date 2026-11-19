import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fakeAgentCommand, type Scenario } from '@swarmdev/fake-agent';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AcpHost, HostStartupError } from '../src/modules/hosts/acp-host';
import { setLauncherForTests } from '../src/modules/hosts/launcher/launcher';
import type {
  AgentSession,
  HostEvent,
  PermissionArbiter,
  PermissionRequest,
} from '../src/modules/hosts/host.types';
import { makeSandbox, removeSandbox } from './fixtures/git-repo';

const T = 30_000;
let sandbox = '';
const open: AgentSession[] = [];

beforeAll(() => {
  sandbox = makeSandbox('acp-host');
});

afterEach(async () => {
  for (const session of open.splice(0)) await session.close();
});

afterAll(() => removeSandbox(sandbox));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pidFrom(file: string): Promise<number> {
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8')) return Number(fs.readFileSync(file, 'utf8'));
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${file} was never written`);
}

async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe.skipIf(process.platform !== 'win32')('ACP host under the launcher', () => {
  const backgroundTurn = (pidFile: string): Scenario => ({
    turns: [{ steps: [{ background: { pidFile } }, { say: 'started a build' }, { hang: {} }] }],
  });

  afterEach(() => setLauncherForTests(undefined));

  it('runs the agent under the launcher and ends its whole tree on close', { timeout: T }, async () => {
    const session = await start(backgroundTurn('bg-launched.pid'));
    expect(session.processIdentity).toMatchObject({ launcher: 'job-object', tag: expect.stringMatching(/^[0-9a-f]{24}$/) });
    void session.prompt({ prompt: 'build' });
    const descendant = await pidFrom(path.join(sandbox, 'bg-launched.pid'));
    expect(alive(descendant)).toBe(true);
    await session.close();
    expect(await goneWithin(descendant, 5_000)).toBe(true);
  });

  it('leaves that descendant behind when the agent starts directly', { timeout: T }, async () => {
    setLauncherForTests(null);
    const session = await start(backgroundTurn('bg-direct.pid'));
    expect(session.processIdentity).toEqual({ pid: expect.any(Number), tag: null, launcher: null });
    void session.prompt({ prompt: 'build' });
    const descendant = await pidFrom(path.join(sandbox, 'bg-direct.pid'));
    await session.close();
    await new Promise((r) => setTimeout(r, 1500));
    expect(alive(descendant)).toBe(true);
    execFileSync('taskkill', ['/PID', String(descendant), '/F'], { stdio: 'ignore' });
  });
});

const allowAll: PermissionArbiter = async () => ({ outcome: 'allow', reason: 'test' });

async function start(
  scenario: Scenario,
  options: { arbiter?: PermissionArbiter; resumeSessionId?: string; startupTimeoutMs?: number; restoreTimeoutMs?: number } = {}
): Promise<AgentSession> {
  const host = new AcpHost(fakeAgentCommand(scenario), {
    startupTimeoutMs: options.startupTimeoutMs,
    restoreTimeoutMs: options.restoreTimeoutMs,
  });
  const session = await host.openSession({
    cwd: sandbox,
    mcpServers: [],
    arbiter: options.arbiter ?? allowAll,
    resumeSessionId: options.resumeSessionId,
  });
  open.push(session);
  return session;
}

function collector() {
  const events: HostEvent[] = [];
  return { events, onEvent: (e: HostEvent) => events.push(e) };
}

describe('ACP host', () => {
  it('streams a turn and reports tokens and per-turn cost', { timeout: T }, async () => {
    const session = await start({
      turns: [
        {
          steps: [
            { tool: { id: 'r1', title: 'Read README.md', kind: 'read', paths: ['README.md'] } },
            { toolDone: { id: 'r1', output: '# fixture' } },
            { say: 'Read ' },
            { say: 'it.' },
            { contextUsage: { used: 1000, size: 200_000, costUsd: 0.01 } },
          ],
          usage: { inputTokens: 800, outputTokens: 200 },
        },
        {
          steps: [{ say: 'Second.' }, { contextUsage: { used: 2000, size: 200_000, costUsd: 0.03 } }],
          usage: { inputTokens: 1500, outputTokens: 100 },
        },
      ],
    });
    expect(session.sessionId).toMatch(/^fake-/);
    expect(session.resumed).toBe(false);

    const first = collector();
    const one = await session.prompt({ prompt: 'read the readme', onEvent: first.onEvent });
    expect(one).toMatchObject({
      stopReason: 'end_turn',
      text: 'Read it.',
      usage: { inputTokens: 800, outputTokens: 200 },
      error: null,
    });
    expect(one.usage.costUsd).toBeCloseTo(0.01);
    expect(first.events.map((e) => e.kind)).toEqual([
      'tool_call',
      'tool_update',
      'message_delta',
      'message_delta',
      'usage',
    ]);
    expect(first.events[0]).toMatchObject({ kind: 'tool_call', toolKind: 'read', paths: [expect.stringContaining('README.md')] });
    expect(first.events[1]).toMatchObject({ kind: 'tool_update', status: 'completed', output: '# fixture' });

    const two = await session.prompt({ prompt: 'again' });
    expect(two.text).toBe('Second.');
    // Cost is cumulative on the wire; each turn reports its own share.
    expect(two.usage.costUsd).toBeCloseTo(0.02);
  });

  it('routes permission requests through the arbiter', { timeout: T }, async () => {
    const seen: PermissionRequest[] = [];
    const scenario: Scenario = {
      turns: [
        {
          steps: [
            {
              permission: {
                toolCallId: 'x1',
                title: 'rm -rf build',
                kind: 'execute',
                onAllow: [{ say: 'ran it' }],
                onReject: [{ say: 'skipped it' }],
              },
            },
          ],
        },
      ],
    };
    const denying = await start(scenario, {
      arbiter: async (request) => {
        seen.push(request);
        return { outcome: 'deny', reason: 'destructive command' };
      },
    });
    const events = collector();
    const denied = await denying.prompt({ prompt: 'clean up', onEvent: events.onEvent });
    expect(denied.text).toBe('skipped it');
    expect(seen).toEqual([
      expect.objectContaining({ toolCallId: 'x1', title: 'rm -rf build', toolKind: 'execute' }),
    ]);
    expect(events.events[0]).toMatchObject({
      kind: 'permission',
      decision: { outcome: 'deny', reason: 'destructive command' },
    });

    const allowing = await start(scenario);
    expect((await allowing.prompt({ prompt: 'clean up' })).text).toBe('ran it');
  });

  it('denies when the arbiter itself fails', { timeout: T }, async () => {
    const session = await start(
      {
        turns: [
          {
            steps: [
              {
                permission: {
                  toolCallId: 'x2',
                  title: 'npm publish',
                  onAllow: [{ say: 'published' }],
                  onReject: [{ say: 'held back' }],
                },
              },
            ],
          },
        ],
      },
      {
        arbiter: async () => {
          throw new Error('policy store offline');
        },
      }
    );
    const events = collector();
    const outcome = await session.prompt({ prompt: 'ship', onEvent: events.onEvent });
    expect(outcome.text).toBe('held back');
    expect(events.events[0]).toMatchObject({
      kind: 'permission',
      decision: { outcome: 'deny', reason: expect.stringContaining('policy store offline') },
    });
  });

  it('cancels a running turn', { timeout: T }, async () => {
    const session = await start({ turns: [{ steps: [{ say: 'working' }, { sleep: 20_000 }] }] });
    const pending = session.prompt({ prompt: 'long job' });
    await new Promise((r) => setTimeout(r, 300));
    await session.cancel();
    const outcome = await pending;
    expect(outcome.stopReason).toBe('cancelled');
    expect(outcome.text).toBe('working');
  });

  it('refuses a second concurrent turn', { timeout: T }, async () => {
    const session = await start({ turns: [{ steps: [{ sleep: 2000 }] }] });
    const first = session.prompt({ prompt: 'one' });
    await expect(session.prompt({ prompt: 'two' })).rejects.toThrow(/already running/);
    await session.cancel();
    await first;
  });

  it('reports a crash with the stderr tail and stays dead', { timeout: T }, async () => {
    const session = await start({
      turns: [{ steps: [{ say: 'partial' }, { stderr: 'segfault in parser' }, { crash: 9 }] }],
    });
    const outcome = await session.prompt({ prompt: 'go' });
    expect(outcome.stopReason).toBe('crashed');
    expect(outcome.text).toBe('partial');
    expect(outcome.error).toContain('segfault in parser');

    const after = await session.prompt({ prompt: 'again' });
    expect(after.stopReason).toBe('crashed');
  });

  it('fails startup when the agent crashes or never answers', { timeout: T }, async () => {
    await expect(start({ startup: 'crash', turns: [{ steps: [] }] })).rejects.toMatchObject({
      reason: 'crashed',
    });
    const started = Date.now();
    const err = await start({ startup: 'hang', turns: [{ steps: [] }] }, { startupTimeoutMs: 1500 }).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(HostStartupError);
    expect((err as HostStartupError).reason).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('resumes a session the runtime still knows, and says when it cannot', { timeout: T }, async () => {
    const resumable = await start(
      { loadSession: true, turns: [{ steps: [{ say: 'welcome back' }] }] },
      { resumeSessionId: 'fake-previous-1' }
    );
    expect(resumable.resumed).toBe(true);
    expect(resumable.sessionId).toBe('fake-previous-1');
    expect((await resumable.prompt({ prompt: 'continue' })).text).toBe('welcome back');

    const fresh = await start({ turns: [{ steps: [] }] }, { resumeSessionId: 'fake-previous-1' });
    expect(fresh.resumed).toBe(false);
    expect(fresh.sessionId).not.toBe('fake-previous-1');
  });

  it('restores by resume, then load, then gives up on a fresh session without failing', { timeout: T }, async () => {
    const previous = { resumeSessionId: 'fake-previous-2', restoreTimeoutMs: 500 };
    const ladder: Array<[Parameters<typeof start>[0], 'resume' | 'load' | null]> = [
      [{ resumeSession: 'ok', loadSession: true, turns: [{ steps: [] }] }, 'resume'],
      [{ resumeSession: 'fail', loadSession: true, turns: [{ steps: [] }] }, 'load'],
      [{ resumeSession: 'hang', loadSession: true, turns: [{ steps: [] }] }, 'load'],
      [{ resumeSession: 'fail', loadSession: true, forgetSessions: true, turns: [{ steps: [] }] }, null],
      [{ resumeSession: 'hang', turns: [{ steps: [] }] }, null],
    ];
    for (const [scenario, expected] of ladder) {
      const started = Date.now();
      const session = await start(scenario, previous);
      const label = JSON.stringify(scenario);
      expect(session.resumedBy ?? null, label).toBe(expected);
      expect(session.resumed, label).toBe(expected !== null);
      expect(session.sessionId === 'fake-previous-2', label).toBe(expected !== null);
      // A stalled rung costs its deadline, not the startup.
      expect(Date.now() - started, label).toBeLessThan(10_000);
      expect((await session.prompt({ prompt: 'go' })).stopReason, label).toBe('end_turn');
    }
  });

  it('survives a non-protocol line on stdout', { timeout: T }, async () => {
    const session = await start({
      turns: [{ steps: [{ say: 'before ' }, { garbage: 'Debugger listening on ws://…' }, { say: 'after' }] }],
    });
    const outcome = await session.prompt({ prompt: 'go' });
    expect(outcome).toMatchObject({ stopReason: 'end_turn', text: 'before after' });
  });

  it('kills a hung agent on close', { timeout: T }, async () => {
    const session = await start({ turns: [{ steps: [{ hang: { ignoreCancel: true } }] }] });
    const pending = session.prompt({ prompt: 'stuck' });
    await new Promise((r) => setTimeout(r, 300));
    await session.close();
    const outcome = await pending;
    expect(['crashed', 'error']).toContain(outcome.stopReason);
  });
});
