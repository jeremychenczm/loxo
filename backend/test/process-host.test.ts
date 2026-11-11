import { RunnerError, type TurnRequest, type TurnResult } from '@swarmdev/shared';
import { describe, expect, it } from 'vitest';
import type { HostEvent, OpenSessionInput } from '../src/modules/hosts/host.types';
import { ProcessHost, type ProcessHostConfig } from '../src/modules/hosts/process-host';

const input = (extra: Partial<OpenSessionInput> = {}): OpenSessionInput => ({
  cwd: '/work/task/member',
  mcpServers: [],
  arbiter: async () => ({ outcome: 'deny', reason: 'unused' }),
  ...extra,
});

function host(execute: (r: TurnRequest) => Promise<TurnResult>, extra: Partial<ProcessHostConfig> = {}) {
  return new ProcessHost({ runtime: 'claude-code', stateDir: '/state', permission: 'edit', execute, ...extra });
}

function events() {
  const list: HostEvent[] = [];
  return { list, onEvent: (e: HostEvent) => list.push(e) };
}

describe('process host', () => {
  it('runs one process per turn with the turn settings', async () => {
    const seen: TurnRequest[] = [];
    const session = await host(async (r) => {
      seen.push(r);
      return { text: 'patched it', sessionRef: 'claude-sess-1', durationMs: 5 };
    }).openSession(
      input({
        model: 'claude-sonnet-5',
        mcpServers: [{ type: 'http', name: 'loxo', url: 'http://127.0.0.1:4000/mcp', headers: { Authorization: 'Bearer srt_x' } }],
      })
    );
    const e = events();
    const outcome = await session.prompt({ prompt: 'fix the bug', onEvent: e.onEvent });
    expect(outcome).toEqual({
      stopReason: 'end_turn',
      text: 'patched it',
      usage: { inputTokens: null, outputTokens: null, costUsd: null },
      error: null,
    });
    expect(seen[0]).toMatchObject({
      runtime: 'claude-code',
      workspace: '/work/task/member',
      stateDir: '/state',
      prompt: 'fix the bug',
      model: 'claude-sonnet-5',
      permission: 'edit',
      sessionRef: null,
      mcp: { url: 'http://127.0.0.1:4000/mcp', token: 'srt_x' },
    });
    // Unstreamed output still reaches listeners once.
    expect(e.list).toEqual([{ kind: 'message_delta', text: 'patched it' }]);
    expect(session.sessionId).toBe('claude-sess-1');

    await session.prompt({ prompt: 'and the test' });
    expect(seen[1]!.sessionRef).toBe('claude-sess-1');
  });

  it('forwards streamed chunks instead of the final text', async () => {
    const session = await host(async (r) => {
      r.onChunk?.('Hel');
      r.onChunk?.('lo');
      return { text: 'Hello', durationMs: 1 };
    }).openSession(input());
    const e = events();
    await session.prompt({ prompt: 'hi', onEvent: e.onEvent });
    expect(e.list).toEqual([
      { kind: 'message_delta', text: 'Hel' },
      { kind: 'message_delta', text: 'lo' },
    ]);
  });

  it('resumes only runtimes that support it', async () => {
    const claude = await host(async () => ({ text: '', durationMs: 1 })).openSession(input({ resumeSessionId: 'old' }));
    expect(claude).toMatchObject({ resumed: true, sessionId: 'old' });
    const codex = await host(async () => ({ text: '', durationMs: 1 }), { runtime: 'codex' }).openSession(
      input({ resumeSessionId: 'old' })
    );
    expect(codex.resumed).toBe(false);
    expect(codex.sessionId).toMatch(/^process-/);
  });

  it.each([
    [new RunnerError('Turn timed out after 300s', 'timeout'), 'timeout'],
    [new RunnerError('Turn was cancelled', 'aborted'), 'cancelled'],
    [new RunnerError('codex exited with code 2', 'cli_failed'), 'error'],
    [new Error('spawn EACCES'), 'error'],
  ] as const)('maps %s to %s', async (error, stopReason) => {
    const session = await host(async () => {
      throw error;
    }).openSession(input());
    const outcome = await session.prompt({ prompt: 'go' });
    expect(outcome).toMatchObject({ stopReason, error: error.message });
  });

  it('cancels the running process through its abort signal', async () => {
    const session = await host(
      (r) =>
        new Promise((_, reject) => {
          r.signal?.addEventListener('abort', () => reject(new RunnerError('Turn was cancelled', 'aborted')));
        })
    ).openSession(input());
    const pending = session.prompt({ prompt: 'long' });
    await expect(session.prompt({ prompt: 'second' })).rejects.toThrow(/already running/);
    await session.cancel();
    expect((await pending).stopReason).toBe('cancelled');
  });

  it('reports a missing CLI as an error turn', async () => {
    const session = await new ProcessHost({ runtime: 'hermes', stateDir: '/state', permission: 'read_only' }).openSession(
      input({ cwd: process.cwd() })
    );
    const outcome = await session.prompt({ prompt: 'hello' });
    // The wording comes from the OS shell and its locale; only its presence is stable.
    expect(outcome.stopReason).toBe('error');
    expect(outcome.error?.trim().length).toBeGreaterThan(0);
  });
});
