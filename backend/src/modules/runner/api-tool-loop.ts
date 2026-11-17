import { HttpError } from '../../http/errors';
import { RunnerError, redactDiagnostic, type TurnResult } from './runner';
import { normalizeApiMessages, type ApiProtocol } from './api-protocol';

/**
 * Thin tool loop for api-runtime agents: hosted model + the platform
 * control-plane tools, nothing else. Deliberately no sub-agents, browsing,
 * or vendor-specific runtime features.
 */

export interface ApiToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
  /** Returns the tool result text; HttpError becomes a tool-visible error. */
  execute: (args: Record<string, unknown>) => Promise<string>;
}

export interface ApiToolLoopRequest {
  protocol: ApiProtocol;
  apiKey: string;
  baseUrl?: string | null;
  model: string;
  system?: string;
  prompt: string;
  /** Earlier turns of the same session, oldest first. */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  tools: ApiToolDefinition[];
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Fires around each tool execution, for event streaming. */
  onToolCall?: (call: ToolCallNotice) => void;
}

export type ToolCallNotice =
  | { phase: 'start'; id: string; name: string; args: unknown }
  | { phase: 'end'; id: string; name: string; result: string; isError: boolean };

/** Running token totals across the rounds of one turn. */
class UsageTally {
  input = 0;
  output = 0;
  seen = false;

  add(input: unknown, output: unknown): void {
    if (typeof input === 'number' || typeof output === 'number') this.seen = true;
    if (typeof input === 'number') this.input += input;
    if (typeof output === 'number') this.output += output;
  }

  result(): { inputTokens: number; outputTokens: number } | undefined {
    return this.seen ? { inputTokens: this.input, outputTokens: this.output } : undefined;
  }
}

async function runTool(
  request: ApiToolLoopRequest,
  id: string,
  name: string,
  args: unknown
): Promise<{ text: string; isError: boolean }> {
  request.onToolCall?.({ phase: 'start', id, name, args });
  const result = await executeTool(request.tools, name, args);
  request.onToolCall?.({ phase: 'end', id, name, result: result.text, isError: result.isError });
  return result;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TOOL_ROUNDS = 8;
const OPENAI_DEFAULT_BASE = 'https://api.openai.com/v1';
const ANTHROPIC_DEFAULT_BASE = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_MAX_TOKENS = 4096;

function apiBase(request: ApiToolLoopRequest): string {
  const fallback = request.protocol === 'openai' ? OPENAI_DEFAULT_BASE : ANTHROPIC_DEFAULT_BASE;
  return (request.baseUrl?.trim() || fallback).replace(/\/+$/, '');
}

async function postJson(
  request: ApiToolLoopRequest,
  url: string,
  headers: Record<string, string>,
  body: unknown
): Promise<Record<string, unknown>> {
  const timeout = AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (timeout.aborted) throw new RunnerError('API request timed out', 'timeout');
    if (request.signal?.aborted) throw new RunnerError('API turn aborted', 'aborted');
    throw new RunnerError(
      redactDiagnostic(error instanceof Error ? error.message : 'API request failed'),
      'api_failed'
    );
  }

  const raw = await response.text().catch(() => '');
  if (!response.ok) {
    let detail = raw;
    try {
      const parsed = JSON.parse(raw) as { error?: { message?: string }; message?: string };
      detail = parsed.error?.message ?? parsed.message ?? raw;
    } catch {
      // Keep raw body.
    }
    throw new RunnerError(
      redactDiagnostic(detail) || `API request failed with status ${response.status}`,
      'api_failed'
    );
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new RunnerError('API returned malformed JSON', 'bad_output');
  }
}

async function executeTool(tools: ApiToolDefinition[], name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return { text: `unknown_tool: ${name}`, isError: true };
  try {
    const record =
      args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
    return { text: await tool.execute(record), isError: false };
  } catch (error) {
    if (error instanceof HttpError) {
      return { text: `${error.code}: ${error.message}`, isError: true };
    }
    throw error;
  }
}

interface OpenAiToolCall {
  id: string;
  function: { name: string; arguments: string };
}

async function runOpenAiLoop(request: ApiToolLoopRequest, started: number): Promise<TurnResult> {
  const url = `${apiBase(request)}/chat/completions`;
  const headers = { Authorization: `Bearer ${request.apiKey}` };
  const toolSpecs = request.tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  const messages: Array<Record<string, unknown>> = [
    ...(request.system ? [{ role: 'system', content: request.system }] : []),
    ...normalizeApiMessages([...(request.history ?? []), { role: 'user', content: request.prompt }]),
  ];
  const usage = new UsageTally();

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    const payload = await postJson(request, url, headers, {
      model: request.model,
      messages,
      tools: toolSpecs,
    });
    const reported = payload.usage as { prompt_tokens?: unknown; completion_tokens?: unknown } | undefined;
    usage.add(reported?.prompt_tokens, reported?.completion_tokens);
    const message = (payload.choices as Array<{ message?: Record<string, unknown> }>)?.[0]
      ?.message;
    if (!message) throw new RunnerError('API returned no message', 'bad_output');

    const toolCalls = (message.tool_calls as OpenAiToolCall[] | undefined) ?? [];
    if (toolCalls.length === 0) {
      const text = typeof message.content === 'string' ? message.content : '';
      return { text, durationMs: Date.now() - started, usage: usage.result() };
    }

    messages.push(message);
    for (const call of toolCalls) {
      let args: unknown = {};
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        // Malformed arguments surface to the model as a tool error below.
        args = null;
      }
      const result =
        args === null
          ? { text: 'invalid_arguments: expected a JSON object', isError: true }
          : await runTool(request, call.id, call.function.name, args);
      messages.push({ role: 'tool', tool_call_id: call.id, content: result.text });
    }
  }
  throw new RunnerError('Tool loop exceeded the round limit', 'bad_output');
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

async function runAnthropicLoop(request: ApiToolLoopRequest, started: number): Promise<TurnResult> {
  const url = `${apiBase(request)}/v1/messages`;
  const headers = { 'x-api-key': request.apiKey, 'anthropic-version': ANTHROPIC_VERSION };
  const toolSpecs = request.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));

  const messages: Array<Record<string, unknown>> = normalizeApiMessages([
    ...(request.history ?? []),
    { role: 'user', content: request.prompt },
  ]).map((m) => ({ ...m }));
  const usage = new UsageTally();

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    const payload = await postJson(request, url, headers, {
      model: request.model,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      ...(request.system ? { system: request.system } : {}),
      messages,
      tools: toolSpecs,
    });
    const reported = payload.usage as { input_tokens?: unknown; output_tokens?: unknown } | undefined;
    usage.add(reported?.input_tokens, reported?.output_tokens);

    const content = (payload.content as AnthropicContentBlock[] | undefined) ?? [];
    const toolUses = content.filter((block) => block.type === 'tool_use');
    if (payload.stop_reason !== 'tool_use' || toolUses.length === 0) {
      const text = content
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('');
      return { text, durationMs: Date.now() - started, usage: usage.result() };
    }

    messages.push({ role: 'assistant', content });
    const results = [];
    for (const use of toolUses) {
      const result = await runTool(request, use.id ?? '', use.name ?? '', use.input ?? {});
      results.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: result.text,
        ...(result.isError ? { is_error: true } : {}),
      });
    }
    messages.push({ role: 'user', content: results });
  }
  throw new RunnerError('Tool loop exceeded the round limit', 'bad_output');
}

export async function runApiToolLoop(request: ApiToolLoopRequest): Promise<TurnResult> {
  const started = Date.now();
  return request.protocol === 'openai'
    ? runOpenAiLoop(request, started)
    : runAnthropicLoop(request, started);
}

type ApiToolLoopExecutor = (request: ApiToolLoopRequest) => Promise<TurnResult>;
let toolLoopExecutor: ApiToolLoopExecutor = runApiToolLoop;

/** Test seam: swap the tool-loop executor without real network calls. */
export function setApiToolLoopExecutorForTests(executor: ApiToolLoopExecutor | null): void {
  toolLoopExecutor = executor ?? runApiToolLoop;
}

export function executeApiToolLoop(request: ApiToolLoopRequest): Promise<TurnResult> {
  return toolLoopExecutor(request);
}
