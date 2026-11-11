/**
 * Scrubs credentials from text the platform stores or streams. Runtimes echo
 * environments, configs, and command output, so anything persisted from them
 * passes through here first.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bsrt_[0-9a-f-]{36}_[A-Za-z0-9_-]{32}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** `Authorization: Bearer x`, `password=x`, `"apiKey": "x"` and friends keep their key, lose their value. */
const KEYED_SECRET = /((?:authorization|bearer|api[_-]?key|secret|token|password|passwd)["']?\s*[:=]\s*["']?(?:bearer\s+)?)([^\s"',;]{6,})/gi;

export function redactText(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]');
  return out.replace(KEYED_SECRET, (_m, key: string) => `${key}[redacted]`);
}

export interface CapLimits {
  maxStringChars: number;
  maxArrayItems: number;
  maxDepth: number;
}

export const DEFAULT_CAP_LIMITS: CapLimits = { maxStringChars: 4000, maxArrayItems: 200, maxDepth: 6 };

/** Redacts every string in a JSON-like value and bounds its size; returns a fresh value. */
export function redactValue(value: unknown, limits: CapLimits = DEFAULT_CAP_LIMITS, depth = 0): unknown {
  if (typeof value === 'string') {
    const clean = redactText(value);
    return clean.length > limits.maxStringChars
      ? `${clean.slice(0, limits.maxStringChars)}… [${clean.length - limits.maxStringChars} more chars]`
      : clean;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= limits.maxDepth) return '[truncated]';
  if (Array.isArray(value)) {
    const items = value.slice(0, limits.maxArrayItems).map((v) => redactValue(v, limits, depth + 1));
    if (value.length > limits.maxArrayItems) items.push(`[${value.length - limits.maxArrayItems} more items]`);
    return items;
  }
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = /^(authorization|api[_-]?key|secret|token|password)$/i.test(key) ? '[redacted]' : redactValue(v, limits, depth + 1);
  }
  return out;
}
