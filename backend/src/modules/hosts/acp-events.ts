import type { SessionUpdate, ToolCallContent } from '@agentclientprotocol/sdk/unstable';
import type { HostEvent } from './host.types';

/** Tool output kept on an event; longer output is trimmed, never dropped silently. */
export const MAX_TOOL_OUTPUT_CHARS = 4000;

function trim(text: string): string {
  return text.length > MAX_TOOL_OUTPUT_CHARS
    ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}… [${text.length - MAX_TOOL_OUTPUT_CHARS} more chars]`
    : text;
}

function describeToolContent(content: ToolCallContent[] | null | undefined): string | null {
  if (!content || content.length === 0) return null;
  const parts = content.map((block) => {
    if (block.type === 'content') {
      return block.content.type === 'text' ? block.content.text : `[${block.content.type}]`;
    }
    if (block.type === 'diff') return `[diff ${block.path}]`;
    if (block.type === 'terminal') return `[terminal ${block.terminalId}]`;
    return `[${block.type}]`;
  });
  return trim(parts.join('\n'));
}

/**
 * Maps one ACP session update onto the host event vocabulary. Updates with
 * no counterpart (mode changes, command lists, plans) return null; plans
 * arrive through the platform's own tools instead.
 */
export function mapSessionUpdate(update: SessionUpdate): HostEvent | null {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      return update.content.type === 'text' ? { kind: 'message_delta', text: update.content.text } : null;
    case 'agent_thought_chunk':
      return update.content.type === 'text' ? { kind: 'thought_delta', text: update.content.text } : null;
    case 'tool_call':
      return {
        kind: 'tool_call',
        toolCallId: update.toolCallId,
        title: update.title,
        toolKind: update.kind ?? 'other',
        status: update.status ?? 'pending',
        paths: (update.locations ?? []).map((l) => l.path),
        ...(update.rawInput !== undefined ? { input: update.rawInput } : {}),
      };
    case 'tool_call_update':
      return {
        kind: 'tool_update',
        toolCallId: update.toolCallId,
        status: update.status ?? null,
        output: describeToolContent(update.content),
      };
    case 'usage_update':
      return {
        kind: 'usage',
        contextUsed: update.used,
        contextSize: update.size,
        costUsd: update.cost && update.cost.currency === 'USD' ? update.cost.amount : null,
      };
    default:
      return null;
  }
}
