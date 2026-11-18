import crypto from 'node:crypto';
import { config } from '../../config';

/**
 * Per-run control-plane token: `srt_<runId>_<sig>`. Stateless HMAC over the
 * run id (same pattern as webhook tokens) — nothing to store or revoke;
 * validity is simply "the run is still running", checked on every call.
 */

const TOKEN_SHAPE = /^srt_([0-9a-f-]{36})_([A-Za-z0-9_-]{32})$/;

function sign(runId: string): string {
  return crypto
    .createHmac('sha256', config.secretsKey())
    .update(`run-token:${runId}`)
    .digest('base64url')
    .slice(0, 32);
}

export function mintRunToken(runId: string): string {
  return `srt_${runId}_${sign(runId)}`;
}

/** Returns the run id for a well-formed, correctly signed token; else null. */
export function verifyRunToken(token: string): string | null {
  const match = TOKEN_SHAPE.exec(token);
  if (!match) return null;
  const expected = Buffer.from(sign(match[1]!));
  const given = Buffer.from(match[2]!);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  return match[1]!;
}
