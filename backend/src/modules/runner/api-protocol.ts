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
 * Model for an API turn. Catalog presets pin a model for one vendor; when the
 * bound provider is the other vendor that preset would 404 there. An explicit
 * user pick fails loudly on a mismatch; a preset default adapts to the
 * provider's vendor; unrecognized ids pass through (relays accept anything).
 */
export function resolveApiModel(
  agent: { name: string; model: string | null; manifest: { api?: { model?: string } } },
  vendor: ApiProtocol
): string {
  const explicit = agent.model?.trim();
  const preset = agent.manifest.api?.model?.trim();

  // Catalog deploys copy the preset into the agent's model field; only a
  // value that diverges from the preset is a deliberate user pick.
  if (explicit && explicit !== preset) {
    const implied = impliedVendor(explicit);
    if (implied && implied !== vendor) {
      throw new RunnerError(
        `Model "${explicit}" is ${implied === 'anthropic' ? 'an Anthropic' : 'an OpenAI'} model, but agent "${agent.name}" uses ${vendor === 'anthropic' ? 'an Anthropic' : 'an OpenAI'} provider. Pick a matching model or switch the provider.`,
        'api_failed'
      );
    }
    return explicit;
  }

  const candidate = preset ?? explicit;
  if (candidate) {
    const implied = impliedVendor(candidate);
    if (implied && implied !== vendor) return VENDOR_DEFAULT_MODELS[vendor];
    return candidate;
  }
  return VENDOR_DEFAULT_MODELS[vendor];
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
