import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type AgentContext,
  type SessionUpdate,
} from '@agentclientprotocol/sdk/unstable';
import { parseScenario, type Scenario, type Step, type TurnScript } from './scenario';

/**
 * Scripted ACP agent over stdio for tests and demos. Usage:
 *   node --import tsx agent.ts --scenario <file.json>
 * or pass the scenario inline through LOXO_FAKE_AGENT_SCENARIO.
 */

class TurnCancelled extends Error {}

interface SessionState {
  cwd: string;
  /** Aborted by `session/cancel` for the turn in flight. */
  turn: AbortController | null;
}

function fail(err: unknown): never {
  process.stderr.write(`fake agent failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

function loadScenario(): Scenario {
  try {
    const flag = process.argv.indexOf('--scenario');
    const raw =
      flag !== -1 && process.argv[flag + 1]
        ? fs.readFileSync(process.argv[flag + 1]!, 'utf8')
        : process.env.LOXO_FAKE_AGENT_SCENARIO;
    if (!raw) throw new Error('No scenario: pass --scenario <file> or LOXO_FAKE_AGENT_SCENARIO');
    return parseScenario(JSON.parse(raw));
  } catch (err) {
    fail(err);
  }
}

function sleep(ms: number, signal: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new TurnCancelled());
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new TurnCancelled());
      },
      { once: true }
    );
  });
}

function insideCwd(cwd: string, rel: string): string {
  const target = path.resolve(cwd, rel);
  const root = path.resolve(cwd);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`Refusing to write outside the session cwd: ${rel}`);
  }
  return target;
}

const scenario = loadScenario();
const sessions = new Map<string, SessionState>();
let turnIndex = 0;
let sessionSeq = 0;

function nextTurn(): TurnScript {
  const turn = scenario.turns[Math.min(turnIndex, scenario.turns.length - 1)]!;
  turnIndex += 1;
  return turn;
}

async function play(
  steps: Step[],
  sessionId: string,
  state: SessionState,
  client: AgentContext,
  signal: AbortSignal
): Promise<void> {
  const update = (u: SessionUpdate) =>
    client.notify(methods.client.session.update, { sessionId, update: u });

  for (const step of steps) {
    if (signal.aborted) throw new TurnCancelled();
    if ('say' in step) {
      await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: step.say } });
    } else if ('think' in step) {
      await update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: step.think } });
    } else if ('tool' in step) {
      await update({
        sessionUpdate: 'tool_call',
        toolCallId: step.tool.id,
        title: step.tool.title,
        kind: step.tool.kind ?? 'other',
        status: step.tool.status ?? 'in_progress',
        locations: (step.tool.paths ?? []).map((p) => ({ path: path.resolve(state.cwd, p) })),
        rawInput: step.tool.input,
      });
    } else if ('toolDone' in step) {
      await update({
        sessionUpdate: 'tool_call_update',
        toolCallId: step.toolDone.id,
        status: step.toolDone.status ?? 'completed',
        content: step.toolDone.output
          ? [{ type: 'content', content: { type: 'text', text: step.toolDone.output } }]
          : undefined,
      });
    } else if ('permission' in step) {
      const ask = step.permission;
      const answer = await client.request(methods.client.session.requestPermission, {
        sessionId,
        toolCall: { toolCallId: ask.toolCallId, title: ask.title, kind: ask.kind ?? 'other' },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      });
      const outcome = answer.outcome;
      const branch =
        outcome.outcome === 'cancelled'
          ? ask.onCancel
          : outcome.optionId === 'allow'
            ? ask.onAllow
            : ask.onReject;
      if (branch) await play(branch, sessionId, state, client, signal);
    } else if ('contextUsage' in step) {
      const { used, size, costUsd } = step.contextUsage;
      await update({
        sessionUpdate: 'usage_update',
        used,
        size,
        ...(costUsd !== undefined ? { cost: { amount: costUsd, currency: 'USD' } } : {}),
      });
    } else if ('sleep' in step) {
      await sleep(step.sleep, signal);
    } else if ('hang' in step) {
      await new Promise<void>((_, reject) => {
        if (!step.hang.ignoreCancel) {
          signal.addEventListener('abort', () => reject(new TurnCancelled()), { once: true });
        }
      });
    } else if ('crash' in step) {
      process.exit(step.crash);
    } else if ('garbage' in step) {
      process.stdout.write(`${step.garbage}\n`);
    } else if ('stderr' in step) {
      process.stderr.write(`${step.stderr}\n`);
    } else if ('writeFile' in step) {
      const target = insideCwd(state.cwd, step.writeFile.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, step.writeFile.content);
    } else if ('background' in step) {
      const pidFile = insideCwd(state.cwd, step.background.pidFile);
      const script = fileURLToPath(new URL('./idle-descendant.mjs', import.meta.url));
      const shell =
        process.platform === 'win32'
          ? spawn('cmd.exe', ['/d', '/s', '/c', `start "" /b "${process.execPath}" "${script}" "${pidFile}"`], {
              stdio: 'ignore',
              windowsVerbatimArguments: true,
            })
          : spawn('/bin/sh', ['-c', `"${process.execPath}" "${script}" "${pidFile}" &`], { stdio: 'ignore' });
      shell.unref();
    } else if ('repeat' in step) {
      for (let i = 0; i < step.repeat.times; i += 1) {
        await play(step.repeat.steps, sessionId, state, client, signal);
      }
    }
  }
}

function requireSession(sessionId: string): SessionState {
  const state = sessions.get(sessionId);
  if (!state) throw new Error(`Unknown session ${sessionId}`);
  return state;
}

async function main(): Promise<void> {
  if (scenario.startup === 'crash') process.exit(3);
  if (scenario.startup === 'garbage') process.stdout.write('this is not json-rpc\n');

  const app = agent({ name: 'loxo-fake-agent' })
    .onRequest(methods.agent.initialize, async () => {
      if (scenario.startup === 'hang') await new Promise<never>(() => {});
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: scenario.loadSession === true,
          mcpCapabilities: { http: true, sse: false },
          ...(scenario.resumeSession ? { sessionCapabilities: { resume: {} } } : {}),
        },
        agentInfo: { name: 'loxo-fake-agent', version: '0.1.0' },
      };
    })
    .onRequest(methods.agent.session.new, async ({ params }) => {
      sessionSeq += 1;
      const sessionId = `fake-${process.pid}-${sessionSeq}`;
      sessions.set(sessionId, { cwd: params.cwd, turn: null });
      return { sessionId };
    })
    .onRequest(methods.agent.session.load, async ({ params }) => {
      if (!scenario.loadSession) throw new Error('session/load is not supported');
      if (scenario.forgetSessions) throw new Error(`Unknown session ${params.sessionId}`);
      sessions.set(params.sessionId, { cwd: params.cwd, turn: null });
      return {};
    })
    .onRequest(methods.agent.session.resume, async ({ params }) => {
      if (!scenario.resumeSession) throw new Error('session/resume is not supported');
      if (scenario.resumeSession === 'hang') await new Promise<never>(() => {});
      if (scenario.resumeSession === 'fail') throw new Error(`Unknown session ${params.sessionId}`);
      sessions.set(params.sessionId, { cwd: params.cwd, turn: null });
      return {};
    })
    .onNotification(methods.agent.session.cancel, async ({ params }) => {
      sessions.get(params.sessionId)?.turn?.abort();
    })
    .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
      const state = requireSession(params.sessionId);
      const turn = nextTurn();
      const controller = new AbortController();
      state.turn = controller;
      try {
        await play(turn.steps, params.sessionId, state, client, controller.signal);
      } catch (err) {
        if (err instanceof TurnCancelled) return { stopReason: 'cancelled' as const };
        throw err;
      } finally {
        state.turn = null;
      }
      return {
        stopReason: turn.stopReason ?? 'end_turn',
        ...(turn.usage
          ? {
              usage: {
                inputTokens: turn.usage.inputTokens,
                outputTokens: turn.usage.outputTokens,
                totalTokens: turn.usage.inputTokens + turn.usage.outputTokens,
              },
            }
          : {}),
      };
    });

  const stream = ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
  );
  const connection = app.connect(stream);
  await connection.closed;
}

main().catch(fail);
