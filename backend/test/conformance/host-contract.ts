import { describe, expect, it } from 'vitest';
import type {
  AgentHost,
  AgentSession,
  HostEvent,
  OpenSessionInput,
  PermissionArbiter,
} from '../../src/modules/hosts/host.types';

/**
 * The behavior every AgentHost must show, whatever its transport. A new
 * runtime adapter is ready when it passes this contract through a driver
 * that can make it reply, run long, and fail on demand.
 */
export interface HostDriver {
  /** Working directory for sessions. */
  cwd: string;
  /** A host whose next turn answers with exactly `text`. */
  replying(text: string): AgentHost;
  /** A host whose turn keeps running until it is cancelled. */
  slow(): AgentHost;
  /** A host whose turn fails; real runtimes cannot fail on demand and omit it. */
  failing?(): AgentHost;
  /** Per-test timeout; real runtimes need longer. */
  timeoutMs?: number;
  /** Prompts that make a real model reply or keep busy; scripted drivers ignore them. */
  prompts?: { reply?: string; slow?: string };
  /** Defaults to denying everything; a real slow turn needs its shell tool allowed. */
  arbiter?: PermissionArbiter;
}

const SUCCESS = new Set(['end_turn', 'max_tokens', 'max_turn_requests']);
const FAILURE = new Set(['crashed', 'error', 'timeout', 'refusal']);

export function describeHostContract(name: string, driver: HostDriver): void {
  const T = driver.timeoutMs ?? 30_000;

  async function open(host: AgentHost, extra: Partial<OpenSessionInput> = {}): Promise<AgentSession> {
    return host.openSession({
      cwd: driver.cwd,
      mcpServers: [],
      arbiter: driver.arbiter ?? (async () => ({ outcome: 'deny', reason: 'conformance' })),
      ...extra,
    });
  }

  describe(`host contract: ${name}`, () => {
    it('completes a turn and streams the same text it returns', { timeout: T }, async () => {
      const session = await open(driver.replying('conformance reply'));
      try {
        const events: HostEvent[] = [];
        const outcome = await session.prompt({
          prompt: driver.prompts?.reply ?? 'Reply with exactly: conformance reply',
          onEvent: (e) => events.push(e),
        });
        expect(SUCCESS.has(outcome.stopReason), outcome.stopReason).toBe(true);
        expect(outcome.error).toBeNull();
        expect(outcome.text).toContain('conformance reply');
        const streamed = events
          .filter((e): e is Extract<HostEvent, { kind: 'message_delta' }> => e.kind === 'message_delta')
          .map((e) => e.text)
          .join('');
        expect(streamed).toBe(outcome.text);
        for (const value of [outcome.usage.inputTokens, outcome.usage.outputTokens, outcome.usage.costUsd]) {
          expect(value === null || (typeof value === 'number' && value >= 0)).toBe(true);
        }
        expect(typeof session.sessionId).toBe('string');
        expect(typeof session.resumed).toBe('boolean');
        expect(session.runtimeSessionId === null || typeof session.runtimeSessionId === 'string').toBe(true);
      } finally {
        await session.close();
      }
    });

    it('allows one turn at a time', { timeout: T }, async () => {
      const session = await open(driver.slow());
      try {
        const first = session.prompt({ prompt: driver.prompts?.slow ?? 'long task' });
        await expect(session.prompt({ prompt: 'second' })).rejects.toThrow();
        await session.cancel();
        await first;
      } finally {
        await session.close();
      }
    });

    it('cancels a running turn promptly', { timeout: T }, async () => {
      const session = await open(driver.slow());
      try {
        const pending = session.prompt({ prompt: driver.prompts?.slow ?? 'long task' });
        await new Promise((r) => setTimeout(r, driver.prompts?.slow ? 8000 : 300));
        const started = Date.now();
        await session.cancel();
        const outcome = await pending;
        expect(outcome.stopReason).toBe('cancelled');
        expect(Date.now() - started).toBeLessThan(10_000);
      } finally {
        await session.close();
      }
    });

    it.skipIf(!driver.failing)('reports a failed turn as an outcome, not an exception', { timeout: T }, async () => {
      const session = await open(driver.failing!());
      try {
        const outcome = await session.prompt({ prompt: 'this will fail' });
        expect(FAILURE.has(outcome.stopReason), outcome.stopReason).toBe(true);
        expect(outcome.error?.trim().length).toBeGreaterThan(0);
      } finally {
        await session.close();
      }
    });

    it('closes idempotently and takes no turns afterwards', { timeout: T }, async () => {
      const session = await open(driver.replying('unused'));
      await session.close();
      await session.close();
      const after = await session.prompt({ prompt: 'anyone?' }).then(
        (outcome) => outcome.stopReason,
        () => 'rejected'
      );
      expect(SUCCESS.has(after)).toBe(false);
    });
  });
}
