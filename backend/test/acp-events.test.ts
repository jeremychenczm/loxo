import { describe, expect, it } from 'vitest';
import { mapSessionUpdate, MAX_TOOL_OUTPUT_CHARS } from '../src/modules/hosts/acp-events';

describe('ACP session update mapping', () => {
  it('maps text chunks and drops non-text content', () => {
    expect(
      mapSessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } })
    ).toEqual({ kind: 'message_delta', text: 'hi' });
    expect(
      mapSessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      })
    ).toBeNull();
  });

  it('defaults missing tool fields and keeps locations as paths', () => {
    expect(
      mapSessionUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 't',
        title: 'Edit app.ts',
        locations: [{ path: '/w/app.ts' }],
      })
    ).toEqual({
      kind: 'tool_call',
      toolCallId: 't',
      title: 'Edit app.ts',
      toolKind: 'other',
      status: 'pending',
      paths: ['/w/app.ts'],
    });
  });

  it('summarizes diffs and caps long tool output', () => {
    const long = 'x'.repeat(MAX_TOOL_OUTPUT_CHARS + 50);
    const mapped = mapSessionUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't',
      status: 'completed',
      content: [
        { type: 'diff', path: '/w/app.ts', newText: 'a', oldText: 'b' },
        { type: 'content', content: { type: 'text', text: long } },
      ],
    });
    expect(mapped).toMatchObject({ kind: 'tool_update', status: 'completed' });
    const output = (mapped as { output: string }).output;
    expect(output.startsWith('[diff /w/app.ts]\n')).toBe(true);
    expect(output).toContain('more chars]');
    expect(output.length).toBeLessThan(long.length);
  });

  it('reports cost only in US dollars', () => {
    expect(
      mapSessionUpdate({ sessionUpdate: 'usage_update', used: 10, size: 100, cost: { amount: 1.5, currency: 'EUR' } })
    ).toEqual({ kind: 'usage', contextUsed: 10, contextSize: 100, costUsd: null });
    expect(
      mapSessionUpdate({ sessionUpdate: 'usage_update', used: 10, size: 100, cost: { amount: 0.4, currency: 'USD' } })
    ).toMatchObject({ costUsd: 0.4 });
  });

  it('ignores updates the platform does not track', () => {
    expect(mapSessionUpdate({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' })).toBeNull();
    expect(mapSessionUpdate({ sessionUpdate: 'plan', entries: [] })).toBeNull();
  });
});
