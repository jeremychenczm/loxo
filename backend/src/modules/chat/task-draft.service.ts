import { eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { agents, type Message } from '../../db/schema';
import { badRequest } from '../../http/errors';
import { generateJson } from '../llm/json-generation';
import { getConversation, listMessages } from './conversations.service';

/** Silence gap that marks a topic boundary in a perpetual thread. */
export const TOPIC_GAP_MS = 3 * 60 * 60 * 1000;
/** Segments thinner than this keep walking across a gap for context. */
export const TOPIC_MIN_MESSAGES = 5;
export const TOPIC_CHAR_BUDGET = 16_000;
export const TOPIC_MAX_MESSAGES = 100;

const DRAFT_TIMEOUT_MS = 30_000;
const TITLE_MAX = 300;
const BRIEF_MAX = 10_000;

export interface TaskDraft {
  title: string;
  brief: string;
  source: 'anthropic' | 'openai' | 'fallback';
  warnings: string[];
  /** Messages the draft was based on, so the client can show and adjust the slice. */
  window: { fromMessageId: string; toMessageId: string; count: number };
}

export interface DraftRange {
  fromMessageId?: string;
  toMessageId?: string;
}

type WindowMessage = Pick<Message, 'role' | 'content' | 'createdAt'>;

/**
 * Current topic segment. Threads are perpetual, so "the task being discussed"
 * is bounded by silence gaps, not message counts: walk back from the newest
 * message and stop at a gap. A segment thinner than TOPIC_MIN_MESSAGES keeps
 * walking across the gap so a terse follow-up ("file that as a task")
 * still carries its context. Char and count caps bound the prompt.
 */
export function sliceTopicWindow<T extends WindowMessage>(history: T[]): T[] {
  const window: T[] = [];
  let chars = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]!;
    if (window.length > 0) {
      const gapMs = +history[i + 1]!.createdAt - +message.createdAt;
      if (gapMs > TOPIC_GAP_MS && window.length >= TOPIC_MIN_MESSAGES) break;
      if (chars + message.content.length > TOPIC_CHAR_BUDGET) break;
      if (window.length >= TOPIC_MAX_MESSAGES) break;
    }
    window.push(message);
    chars += message.content.length;
  }
  return window.reverse();
}

/**
 * Explicit selection: the span between the range endpoints, newest-biased
 * caps applied. No gap logic — the user drew the boundary themselves.
 */
export function sliceExplicitRange<T extends WindowMessage & { id: string }>(
  history: T[],
  range: DraftRange
): T[] {
  const from = range.fromMessageId ? history.findIndex((m) => m.id === range.fromMessageId) : 0;
  const to = range.toMessageId
    ? history.findIndex((m) => m.id === range.toMessageId)
    : history.length - 1;
  if (from < 0 || to < 0) throw badRequest('invalid_range', 'Range message not found');
  if (from > to) throw badRequest('invalid_range', 'Range endpoints are reversed');

  const span = history.slice(from, to + 1).slice(-TOPIC_MAX_MESSAGES);
  let chars = 0;
  let start = span.length;
  while (start > 0) {
    const next = chars + span[start - 1]!.content.length;
    if (start < span.length && next > TOPIC_CHAR_BUDGET) break;
    chars = next;
    start--;
  }
  return span.slice(start);
}

const DRAFT_SYSTEM_PROMPT = [
  'You turn a chat transcript between a user and their AI teammate into a work-order draft.',
  'The transcript may span several topics; extract only the task most recently under discussion and ignore earlier unrelated topics.',
  'Output only a JSON object, no markdown fences: {"title": string, "brief": string}.',
  'Title: one imperative line, at most 120 characters.',
  'Brief: the task as actionable instructions — goal, concrete requirements, constraints, and acceptance hints mentioned in the chat. Do not invent details the chat does not support.',
  'Write in the language the chat itself uses.',
].join('\n');

function renderTranscript(agentName: string, window: WindowMessage[]): string {
  return window
    .map((m) => {
      const stamp = m.createdAt.toISOString().slice(5, 16).replace('T', ' ');
      const speaker = m.role === 'assistant' ? agentName.toUpperCase() : 'USER';
      return `[${stamp}] ${speaker}: ${m.content}`;
    })
    .join('\n');
}

/** Deterministic draft when no provider is configured or the model call fails. */
export function fallbackTaskDraft(
  agentName: string,
  window: WindowMessage[]
): { title: string; brief: string } {
  const lastUser = [...window].reverse().find((m) => m.role === 'user');
  const firstLine = (lastUser?.content ?? '').split('\n')[0]!.trim() || 'Task from chat';
  const title = firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
  const transcript = renderTranscript(agentName, window);
  const excerpt = transcript.length > 4000 ? transcript.slice(-4000) : transcript;
  return {
    title,
    brief: `Drafted from a chat conversation.\n\nTranscript excerpt:\n${excerpt}`,
  };
}

function normalizeDraft(json: unknown): { title: string; brief: string } {
  const obj = (json ?? {}) as Record<string, unknown>;
  const title = typeof obj.title === 'string' ? obj.title.trim() : '';
  const brief = typeof obj.brief === 'string' ? obj.brief.trim() : '';
  if (!title) throw new Error('Draft has no title');
  return { title: title.slice(0, TITLE_MAX), brief: brief.slice(0, BRIEF_MAX) };
}

export async function draftTaskFromConversation(
  userId: string,
  conversationId: string,
  range?: DraftRange
): Promise<TaskDraft> {
  const conversation = await getConversation(userId, conversationId);
  const [agent] = await db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, conversation.agentId))
    .limit(1);
  const agentName = agent?.name ?? 'agent';

  const history = (await listMessages(userId, conversationId)).filter(
    (m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim() && !m.meta.error
  );
  if (history.length === 0) {
    throw badRequest('empty_conversation', 'Nothing to convert into a task yet');
  }

  const explicit = Boolean(range?.fromMessageId || range?.toMessageId);
  const window = explicit ? sliceExplicitRange(history, range!) : sliceTopicWindow(history);
  const windowInfo = {
    fromMessageId: window[0]!.id,
    toMessageId: window[window.length - 1]!.id,
    count: window.length,
  };
  const warnings: string[] = [];

  const generation = await generateJson(
    userId,
    {
      system: DRAFT_SYSTEM_PROMPT,
      user: `Teammate name: ${agentName}\n\nTranscript:\n${renderTranscript(agentName, window)}`,
    },
    { timeoutMs: DRAFT_TIMEOUT_MS }
  );

  if (generation.status === 'ok') {
    try {
      return {
        ...normalizeDraft(generation.json),
        source: generation.vendor,
        warnings,
        window: windowInfo,
      };
    } catch (error) {
      warnings.push(
        `Draft via ${generation.vendor} was malformed (${(error as Error).message}); used the transcript fallback`
      );
    }
  } else if (generation.status === 'failed') {
    warnings.push(
      `Draft via ${generation.vendor} failed (${generation.message}); used the transcript fallback`
    );
  } else {
    warnings.push('No anthropic/openai provider configured; drafted from the transcript directly');
  }

  return { ...fallbackTaskDraft(agentName, window), source: 'fallback', warnings, window: windowInfo };
}
