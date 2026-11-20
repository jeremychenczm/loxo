import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientContext,
  type SessionUpdate,
} from '@agentclientprotocol/sdk/unstable';
import { fakeAgentCommand, type Scenario } from '@swarmdev/fake-agent';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { makeSandbox, removeSandbox } from './fixtures/git-repo';

const T = 30_000;
let sandbox = '';
const children: ChildProcess[] = [];

beforeAll(() => {
  sandbox = makeSandbox('fake-agent');
});

afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill();
});

afterAll(() => removeSandbox(sandbox));

interface Launched {
  child: ChildProcess;
  updates: SessionUpdate[];
  exited: Promise<number | null>;
  /** Runs `op` against an initialized connection with one session in the sandbox. */
  run<T>(op: (ctx: ClientContext, sessionId: string) => Promise<T>): Promise<T>;
}

function launch(scenario: Scenario, answer: 'allow' | 'reject' | 'cancelled' = 'allow'): Launched {
  const cmd = fakeAgentCommand(scenario);
  const child = spawn(cmd.command, cmd.args, {
    cwd: sandbox,
    env: { ...process.env, ...cmd.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.push(child);
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  const updates: SessionUpdate[] = [];
  const app = client({ name: 'loxo-test' })
    .onNotification(methods.client.session.update, ({ params }) => {
      updates.push(params.update);
    })
    .onRequest(methods.client.session.requestPermission, async () =>
      answer === 'cancelled'
        ? { outcome: { outcome: 'cancelled' as const } }
        : { outcome: { outcome: 'selected' as const, optionId: answer } }
    );
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>
  );
  return {
    child,
    updates,
    exited,
    run: (op) =>
      app.connectWith(stream, async (ctx) => {
        await ctx.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        const session = await ctx.request(methods.agent.session.new, { cwd: sandbox, mcpServers: [] });
        return op(ctx, session.sessionId);
      }),
  };
}

const prompt = (ctx: ClientContext, sessionId: string, text = 'go') =>
  ctx.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] });

describe('fake ACP agent', () => {
  it('streams a scripted turn and reports usage', { timeout: T }, async () => {
    const h = launch({
      turns: [
        {
          steps: [
            { think: 'reading the brief' },
            { tool: { id: 't1', title: 'Read README.md', kind: 'read', paths: ['README.md'] } },
            { toolDone: { id: 't1', output: '# fixture' } },
            { say: 'Done.' },
            { contextUsage: { used: 1200, size: 200_000, costUsd: 0.01 } },
          ],
          usage: { inputTokens: 900, outputTokens: 300 },
        },
      ],
    });
    const response = await h.run((ctx, id) => prompt(ctx, id));
    expect(response.stopReason).toBe('end_turn');
    expect(response.usage).toMatchObject({ inputTokens: 900, outputTokens: 300, totalTokens: 1200 });
    expect(h.updates.map((u) => u.sessionUpdate)).toEqual([
      'agent_thought_chunk',
      'tool_call',
      'tool_call_update',
      'agent_message_chunk',
      'usage_update',
    ]);
    const call = h.updates[1] as Extract<SessionUpdate, { sessionUpdate: 'tool_call' }>;
    expect(call.locations?.[0]?.path).toBe(path.join(sandbox, 'README.md'));
  });

  it('plays turns in order and repeats the last one', { timeout: T }, async () => {
    const h = launch({ turns: [{ steps: [{ say: 'first' }] }, { steps: [{ say: 'again' }] }] });
    await h.run(async (ctx, id) => {
      for (let i = 0; i < 3; i += 1) await prompt(ctx, id);
    });
    const said = h.updates.map((u) => (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text' ? u.content.text : ''));
    expect(said).toEqual(['first', 'again', 'again']);
  });

  it.each([
    ['allow', 'allowed'],
    ['reject', 'rejected'],
    ['cancelled', 'withdrawn'],
  ] as const)('follows the %s branch of a permission request', { timeout: T }, async (answer, said) => {
    const h = launch(
      {
        turns: [
          {
            steps: [
              {
                permission: {
                  toolCallId: 'p1',
                  title: 'Run npm test',
                  kind: 'execute',
                  onAllow: [{ say: 'allowed' }],
                  onReject: [{ say: 'rejected' }],
                  onCancel: [{ say: 'withdrawn' }],
                },
              },
            ],
          },
        ],
      },
      answer
    );
    await h.run((ctx, id) => prompt(ctx, id));
    const last = h.updates.at(-1);
    expect(last).toMatchObject({ sessionUpdate: 'agent_message_chunk', content: { text: said } });
  });

  it('stops a sleeping turn on session/cancel', { timeout: T }, async () => {
    const h = launch({ turns: [{ steps: [{ say: 'working' }, { sleep: 20_000 }, { say: 'never' }] }] });
    const started = Date.now();
    const response = await h.run(async (ctx, id) => {
      const pending = prompt(ctx, id);
      await new Promise((r) => setTimeout(r, 300));
      await ctx.notify(methods.agent.session.cancel, { sessionId: id });
      return pending;
    });
    expect(response.stopReason).toBe('cancelled');
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(h.updates.some((u) => u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text' && u.content.text === 'never')).toBe(false);
  });

  it('can ignore cancellation and hang until killed', { timeout: T }, async () => {
    const h = launch({ turns: [{ steps: [{ hang: { ignoreCancel: true } }] }] });
    const outcome = await h.run(async (ctx, id) => {
      const pending = prompt(ctx, id).then(() => 'answered', () => 'failed');
      await ctx.notify(methods.agent.session.cancel, { sessionId: id });
      const raced = await Promise.race([pending, new Promise((r) => setTimeout(() => r('still hanging'), 800))]);
      h.child.kill();
      return raced;
    });
    expect(outcome).toBe('still hanging');
  });

  it('crashes mid-turn with the scripted exit code', { timeout: T }, async () => {
    const h = launch({ turns: [{ steps: [{ say: 'about to fall over' }, { crash: 7 }] }] });
    const outcome = await h
      .run((ctx, id) => prompt(ctx, id))
      .then(() => 'answered', () => 'failed');
    expect(outcome).toBe('failed');
    expect(await h.exited).toBe(7);
  });

  it('writes inside the session cwd and refuses paths outside it', { timeout: T }, async () => {
    const ok = launch({ turns: [{ steps: [{ writeFile: { path: 'out/result.txt', content: 'hello' } }] }] });
    await ok.run((ctx, id) => prompt(ctx, id));
    expect(fs.readFileSync(path.join(sandbox, 'out', 'result.txt'), 'utf8')).toBe('hello');

    const escape = launch({ turns: [{ steps: [{ writeFile: { path: '../escaped.txt', content: 'x' } }] }] });
    const outcome = await escape.run((ctx, id) => prompt(ctx, id)).then(() => 'answered', () => 'failed');
    expect(outcome).toBe('failed');
    expect(fs.existsSync(path.join(sandbox, '..', 'escaped.txt'))).toBe(false);
  });

  it('rejects a malformed scenario before speaking', { timeout: T }, async () => {
    const cmd = fakeAgentCommand({ turns: [{ steps: [] }] });
    const child = spawn(cmd.command, cmd.args, {
      env: { ...process.env, LOXO_FAKE_AGENT_SCENARIO: JSON.stringify({ turns: [{ steps: [{ dance: true }] }] }) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    children.push(child);
    let stderr = '';
    child.stderr!.on('data', (chunk) => (stderr += chunk));
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    expect(code).toBe(1);
    expect(stderr).toContain('fake agent failed');
  });
});
