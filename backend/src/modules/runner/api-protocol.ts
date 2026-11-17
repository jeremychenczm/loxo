import { RunnerError } from './runner';

export type ApiProtocol = 'openai' | 'anthropic';

export interface ApiChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

const VENDOR_DEFAULT_MODELS: Record<ApiProtocol, string> = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-4o-mini',
};

/** Vendor a model id unambiguously belongs to; null when unrecognized. */
export function impliedVendor(model: string): ApiProtocol | null {
  const id = model.toLowerCase();
  if (id.startsWith('claude')) return 'anthropic';
  if (id.startsWith('gpt') || id.startsWith('chatgpt') || /^o\d/.test(id)) return 'openai';
  return null;
}

/**
 * Model for an API turn: the agent's explicit pick, or the vendor default.
 * A pick that clearly belongs to the other vendor fails loudly; unrecognized
 * ids pass through because relays accept anything.
 */
export function resolveApiModel(agent: { name: string; model: string | null }, vendor: ApiProtocol): string {
  const explicit = agent.model?.trim();
  if (!explicit) return VENDOR_DEFAULT_MODELS[vendor];
  const implied = impliedVendor(explicit);
  if (implied && implied !== vendor) {
    throw new RunnerError(
      `Model "${explicit}" is ${implied === 'anthropic' ? 'an Anthropic' : 'an OpenAI'} model, but agent "${agent.name}" uses ${vendor === 'anthropic' ? 'an Anthropic' : 'an OpenAI'} provider. Pick a matching model or switch the provider.`,
      'api_failed'
    );
  }
  return explicit;
}

/**
 * Drops empty messages and merges consecutive same-role ones; the Anthropic
 * Messages API requires strictly alternating roles starting with `user`.
 */
export function normalizeApiMessages(messages: ApiChatMessage[]): ApiChatMessage[] {
  const merged: ApiChatMessage[] = [];
  for (const message of messages) {
    const content = message.content.trim();
    if (!content) continue;
    const last = merged[merged.length - 1];
    if (last && last.role === message.role) {
      last.content = `${last.content}\n\n${content}`;
    } else {
      merged.push({ role: message.role, content });
    }
  }
  while (merged.length > 0 && merged[0]!.role === 'assistant') merged.shift();
  return merged;
}
