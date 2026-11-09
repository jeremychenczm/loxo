import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { providers } from '../../db/schema';
import { openSecret } from '../../crypto/secretbox';

/**
 * Platform-side clerical LLM calls (chat-to-issue drafts): pick the user's provider, run one prompt, hand back parsed JSON.
 * Callers own prompts, validation, and fallback behavior.
 */

export type JsonVendor = 'anthropic' | 'openai';

export type JsonGeneration =
  | { status: 'ok'; vendor: JsonVendor; json: unknown }
  | { status: 'no_provider' }
  | { status: 'failed'; vendor: JsonVendor; message: string };

interface ProviderChoice {
  vendor: JsonVendor;
  apiKey: string;
  baseUrl: string | null;
  model: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;

async function pickProvider(userId: string): Promise<ProviderChoice | null> {
  for (const vendor of ['anthropic', 'openai'] as const) {
    const rows = await db
      .select()
      .from(providers)
      .where(and(eq(providers.userId, userId), eq(providers.vendor, vendor)));
    const chosen = rows.find((r) => r.isDefault) ?? rows[0];
    if (chosen) {
      return {
        vendor,
        apiKey: openSecret(chosen.apiKeyEncrypted),
        baseUrl: chosen.baseUrl,
        model:
          chosen.models[0] ?? (vendor === 'anthropic' ? 'claude-sonnet-5' : 'gpt-4o-mini'),
      };
    }
  }
  return null;
}

/** Pulls the first JSON object out of a model reply that may have prose around it. */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('No JSON object in model output');
  return JSON.parse(text.slice(start, end + 1));
}

async function callAnthropic(
  cfg: ProviderChoice,
  system: string,
  user: string,
  signal: AbortSignal
): Promise<string> {
  const res = await fetch(`${cfg.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 4096,
      system,
      messages: [{ role: 'user', content: user }],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
  const body = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  return (body.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
}

async function callOpenAi(
  cfg: ProviderChoice,
  system: string,
  user: string,
  signal: AbortSignal
): Promise<string> {
  const res = await fetch(`${cfg.baseUrl ?? 'https://api.openai.com'}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`OpenAI API ${res.status}`);
  const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return body.choices?.[0]?.message?.content ?? '';
}

export async function generateJson(
  userId: string,
  prompt: { system: string; user: string },
  options: { timeoutMs?: number } = {}
): Promise<JsonGeneration> {
  const provider = await pickProvider(userId);
  if (!provider) return { status: 'no_provider' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const reply =
      provider.vendor === 'anthropic'
        ? await callAnthropic(provider, prompt.system, prompt.user, controller.signal)
        : await callOpenAi(provider, prompt.system, prompt.user, controller.signal);
    return { status: 'ok', vendor: provider.vendor, json: extractJsonObject(reply) };
  } catch (error) {
    return { status: 'failed', vendor: provider.vendor, message: (error as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
