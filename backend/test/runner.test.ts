import { describe, expect, it } from 'vitest';
import { lowerPermission, redactDiagnostic } from '../src/modules/runner/runner';

describe('lowerPermission', () => {
  it('lowerPermission picks the more restrictive level', () => {
    expect(lowerPermission('full', 'read_only')).toBe('read_only');
    expect(lowerPermission('read_only', 'full')).toBe('read_only');
    expect(lowerPermission('edit', 'full')).toBe('edit');
    expect(lowerPermission('edit', 'edit')).toBe('edit');
  });
});

describe('redactDiagnostic', () => {
  it('strips ANSI codes and API keys', () => {
    const dirty = '\x1b[31merror\x1b[0m key sk-abcdefghijklmnop123456 leaked';
    const clean = redactDiagnostic(dirty);
    expect(clean).not.toContain('sk-abcdefghijklmnop');
    expect(clean).not.toContain('\x1b');
    expect(clean).toContain('[redacted]');
  });
});
