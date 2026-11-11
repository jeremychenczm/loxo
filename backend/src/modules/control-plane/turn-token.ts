import crypto from 'node:crypto';
import { config } from '../../config';

/**
 * Turn-scoped control-plane credential: `stt_<turnId>_<sig>`. The signature
 * covers the turn, its task, and its agent, and the token is honored only
 * while that turn is running — nothing is stored, nothing needs revoking.
 */

const TOKEN_SHAPE = /^stt_([0-9a-f-]{36})_([A-Za-z0-9_-]{43})$/;

export interface TurnScope {
  turnId: string;
  taskId: string;
  agentId: string;
}

function sign(scope: TurnScope): string {
  return crypto
    .createHmac('sha256', config.secretsKey())
    .update(`turn-token:${scope.turnId}:${scope.taskId}:${scope.agentId}`)
    .digest('base64url');
}

export function mintTurnToken(scope: TurnScope): string {
  return `stt_${scope.turnId}_${sign(scope)}`;
}

/** Returns the turn id of a well-formed token; the signature is checked against the stored scope. */
export function parseTurnToken(token: string): { turnId: string; signature: string } | null {
  const match = TOKEN_SHAPE.exec(token);
  return match ? { turnId: match[1]!, signature: match[2]! } : null;
}

export function signatureMatches(scope: TurnScope, signature: string): boolean {
  const expected = Buffer.from(sign(scope));
  const given = Buffer.from(signature);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}
