import crypto from 'node:crypto';
import { config } from '../../config';

/**
 * Per-run control-plane token: `srt_<runId>_<epoch>_<sig>`. Stateless HMAC
 * over the run id and the owner epoch it was minted under, so nothing is
 * stored or revoked: a takeover bumps the epoch and every older token stops
 * matching. Validity against the run row is checked on every call.
 */

const TOKEN_SHAPE = /^srt_([0-9a-f-]{36})_(0|[1-9]\d{0,8})_([A-Za-z0-9_-]{32})$/;

function sign(runId: string, epoch: number): string {
  return crypto
    .createHmac('sha256', config.secretsKey())
    .update(`run-token:${runId}:${epoch}`)
    .digest('base64url')
    .slice(0, 32);
}

export interface RunTokenClaims {
  runId: string;
  epoch: number;
}

export function mintRunToken(runId: string, epoch: number): string {
  return `srt_${runId}_${epoch}_${sign(runId, epoch)}`;
}

/** Returns the claims of a well-formed, correctly signed token; else null. */
export function verifyRunToken(token: string): RunTokenClaims | null {
  const match = TOKEN_SHAPE.exec(token);
  if (!match) return null;
  const runId = match[1]!;
  const epoch = Number(match[2]);
  const expected = Buffer.from(sign(runId, epoch));
  const given = Buffer.from(match[3]!);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  return { runId, epoch };
}
