import { openHumanRequest, waitForHumanAnswer } from '../human-requests/human-requests.service';
import type { PermissionArbiter, PermissionDecision, PermissionRequest } from './host.types';
import { commandOf, evaluatePermission, type PolicyContext, type PolicyVerdict } from './permission-policy';

export const DEFAULT_ASK_TIMEOUT_MS = 5 * 60_000;

export interface ArbiterOptions {
  context: PolicyContext;
  /** Task that owns the turn; without one, questions for a person are denied. */
  taskId: string | null;
  agentId?: string | null;
  /** Run the requests belong to. */
  runId?: string | null;
  askTimeoutMs?: number;
  /** Audit hook for every request and its verdict. */
  onVerdict?: (request: PermissionRequest, verdict: PolicyVerdict) => void;
}

/**
 * Turns the policy into an arbiter: allow and deny are immediate; ask becomes
 * a human request with a deadline, and no answer in time means no.
 */
export function createPermissionArbiter(options: ArbiterOptions): PermissionArbiter {
  const ttlMs = options.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
  return async (request): Promise<PermissionDecision> => {
    const verdict = evaluatePermission(request, options.context);
    options.onVerdict?.(request, verdict);
    if (verdict.outcome !== 'ask') return { outcome: verdict.outcome, reason: verdict.reason };
    if (!options.taskId) {
      return { outcome: 'deny', reason: `${verdict.reason}; no one can approve it outside a task` };
    }

    const human = await openHumanRequest({
      taskId: options.taskId,
      runId: options.runId ?? null,
      kind: 'permission',
      payload: {
        toolCallId: request.toolCallId,
        title: request.title,
        toolKind: request.toolKind,
        paths: request.paths,
        command: request.toolKind === 'execute' ? commandOf(request) : null,
        reason: verdict.reason,
        rule: verdict.rule,
        agentId: options.agentId ?? null,
      },
      choices: ['allow', 'deny'],
      ttlMs,
    });
    const result = await waitForHumanAnswer(human.id);
    if (result.status === 'answered' && result.choice === 'allow') {
      return { outcome: 'allow', reason: result.note ? `Approved: ${result.note}` : 'Approved by a person' };
    }
    if (result.status === 'answered') {
      return { outcome: 'deny', reason: result.note ? `Denied: ${result.note}` : 'Denied by a person' };
    }
    return {
      outcome: 'deny',
      reason:
        result.status === 'expired'
          ? `No answer within ${Math.round(ttlMs / 1000)} s; denied`
          : 'The request was withdrawn; denied',
    };
  };
}
