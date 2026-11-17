import { describe, expect, it } from 'vitest';
import {
  normalizeApiMessages,
  resolveApiModel,
} from '../src/modules/runner/api-protocol';
import { RunnerError } from '../src/modules/runner/runner';

describe('normalizeApiMessages', () => {
  it('merges consecutive same-role messages and drops empties', () => {
    const result = normalizeApiMessages([
      { role: 'user', content: 'one' },
      { role: 'user', content: 'two' },
      { role: 'assistant', content: '  ' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'three' },
    ]);
    expect(result).toEqual([
      { role: 'user', content: 'one\n\ntwo' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'three' },
    ]);
  });

  it('drops leading assistant messages so the sequence starts with user', () => {
    const result = normalizeApiMessages([
      { role: 'assistant', content: 'old greeting' },
      { role: 'user', content: 'question' },
    ]);
    expect(result[0]).toEqual({ role: 'user', content: 'question' });
  });
});

describe('resolveApiModel', () => {
  const agent = (model: string | null) => ({ name: 'Helper', model });

  it('keeps a matching or unrecognized explicit model', () => {
    expect(resolveApiModel(agent('o3-mini'), 'openai')).toBe('o3-mini');
    expect(resolveApiModel(agent('claude-sonnet-5'), 'anthropic')).toBe('claude-sonnet-5');
    expect(resolveApiModel(agent('my-relay-model'), 'openai')).toBe('my-relay-model');
  });

  it('rejects an explicit model that contradicts the vendor', () => {
    expect(() => resolveApiModel(agent('claude-sonnet-5'), 'openai')).toThrow(RunnerError);
    expect(() => resolveApiModel(agent('gpt-4o-mini'), 'anthropic')).toThrow(RunnerError);
  });

  it('falls back to the vendor default when no model is set', () => {
    expect(resolveApiModel(agent(null), 'openai')).toBe('gpt-4o-mini');
    expect(resolveApiModel(agent('  '), 'anthropic')).toBe('claude-sonnet-5');
  });
});
