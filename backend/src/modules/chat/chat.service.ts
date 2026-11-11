import { type Message } from '../../db/schema';
import { badRequest } from '../../http/errors';
import { storage } from '../../storage/layout';
import { getAgent } from '../agents/agents.service';
import { claimAgentForTurn, releaseAgentAfterTurn } from '../runs/wake';
import { getProviderCredentials } from '../providers/providers.service';
import { runTurn, RunnerError, type TurnRequest, type TurnResult } from '../runner/runner';
import { executeApiTurn, resolveApiModel, type ApiChatMessage, type ApiProtocol } from '../runner/api-turn';
import { buildDirectChatPrompt } from '../runner/turn-context';
import type { CliRuntime } from '../agents/runtime-detect';
import type { Agent } from '../../db/schema';
import {
  appendMessage,
  autoTitleConversation,
  getConversation,
  listMessages,
  setRunnerSessionRef,
} from './conversations.service';

export interface TurnEvents {
  onChunk?: (text: string) => void;
  /** Message meta source tag; defaults to 'chat'. */
  source?: string;
}

export interface TurnOutcome {
  userMessage: Message;
  reply: Message;
}

/** Runtimes that resume CLI-side sessions; others get history injected. */
const RESUMABLE: ReadonlySet<string> = new Set(['claude-code']);

type TurnExecutor = (request: TurnRequest) => Promise<TurnResult>;
let turnExecutor: TurnExecutor = runTurn;

/** Test seam: swap the CLI executor without spawning real processes. */
export function setTurnExecutorForTests(executor: TurnExecutor | null): void {
  turnExecutor = executor ?? runTurn;
}

const inflight = new Map<string, AbortController>();

const API_HISTORY_LIMIT = 18;

function buildApiMessages(history: Message[], content: string): ApiChatMessage[] {
  const mapped: ApiChatMessage[] = history
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.meta.error)
    .slice(-API_HISTORY_LIMIT)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
  mapped.push({ role: 'user', content });
  return mapped;
}

interface Credentials {
  vendor: string;
  apiKey: string;
  baseUrl: string | null;
}

/**
 * One turn against a hosted model API. Configuration gaps surface as
 * RunnerError so they land in the conversation as system messages, the same
 * way CLI provider problems do.
 */
async function runApiAgentTurn(
  agent: Agent,
  credentials: Credentials | null,
  history: Message[],
  content: string,
  signal: AbortSignal,
  events: TurnEvents
): Promise<TurnResult> {
  if (!credentials) {
    throw new RunnerError(
      'Configure an OpenAI or Anthropic provider for this agent first',
      'api_failed'
    );
  }
  const model = resolveApiModel(agent, credentials.vendor as ApiProtocol);

  const system =
    agent.manifest.api?.systemPrompt ?? `You are ${agent.name}. ${agent.description}`.trim();

  return executeApiTurn({
    protocol: credentials.vendor as ApiProtocol,
    apiKey: credentials.apiKey,
    baseUrl: credentials.baseUrl,
    model,
    system,
    messages: buildApiMessages(history, content),
    signal,
    onChunk: events.onChunk,
  });
}

export function stopTurn(conversationId: string): boolean {
  const controller = inflight.get(conversationId);
  if (!controller) return false;
  controller.abort();
  return true;
}

/**
 * One chat turn: persist the user message, run the agent CLI, persist the
 * reply (or a system error message). Exactly one turn per conversation may
 * be in flight, and the agent claim is shared with task runs — a busy
 * agent rejects the turn instead of running two things at once.
 */
export async function runChatTurn(
  userId: string,
  conversationId: string,
  content: string,
  events: TurnEvents = {}
): Promise<TurnOutcome> {
  const conversation = await getConversation(userId, conversationId);
  const agent = await getAgent(userId, conversation.agentId);

  if (inflight.has(conversationId)) {
    throw badRequest('turn_in_flight', 'A turn is already running for this conversation');
  }
  if (!(await claimAgentForTurn(agent.id))) {
    throw badRequest('agent_busy', 'This agent is busy with another run');
  }

  let settledStatus: 'idle' | 'error' = 'error';
  try {
    const history = await listMessages(userId, conversationId);
    const userMessage = await appendMessage(conversationId, 'user', content, {
      source: events.source ?? 'chat',
    });
    await autoTitleConversation(conversationId, content);

    const credentials = agent.providerId
      ? await getProviderCredentials(userId, agent.providerId)
      : null;
    const paths = storage.agentPaths(userId, agent.id);
    const resumable = RESUMABLE.has(agent.runtime);

    const controller = new AbortController();
    inflight.set(conversationId, controller);

    try {
      let result: TurnResult;
      if (agent.runtime === 'api') {
        result = await runApiAgentTurn(agent, credentials, history, content, controller.signal, events);
      } else {
        const prompt = buildDirectChatPrompt({
          agent,
          workspace: paths.workspace,
          userMessage: content,
          conversationId,
          history: resumable && conversation.runnerSessionRef ? undefined : history,
        });

        result = await turnExecutor({
          runtime: agent.runtime as CliRuntime,
          workspace: paths.workspace,
          stateDir: paths.state,
          prompt,
          model: agent.model,
          credentials: credentials ?? undefined,
          sessionRef: resumable ? conversation.runnerSessionRef : null,
          signal: controller.signal,
          onChunk: events.onChunk,
          permission: agent.permissionLevel,
        });

        if (resumable && result.sessionRef && result.sessionRef !== conversation.runnerSessionRef) {
          await setRunnerSessionRef(conversationId, result.sessionRef);
        }
      }

      const reply = await appendMessage(conversationId, 'assistant', result.text, {
        runtime: agent.runtime,
        durationMs: result.durationMs,
      });
      settledStatus = 'idle';
      return { userMessage, reply };
    } catch (error) {
      const detail =
        error instanceof RunnerError ? error.message : 'Agent turn failed unexpectedly';
      const reply = await appendMessage(conversationId, 'system', detail, {
        runtime: agent.runtime,
        error: true,
      });
      if (error instanceof RunnerError) {
        return { userMessage, reply };
      }
      throw error;
    } finally {
      inflight.delete(conversationId);
    }
  } finally {
    // Releasing also promotes any run that queued up behind this turn.
    await releaseAgentAfterTurn(agent.id, settledStatus);
  }
}
