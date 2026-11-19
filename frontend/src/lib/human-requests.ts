import { apiFetch } from './api';

export type HumanRequestKind = 'input' | 'permission' | 'retry' | 'budget' | 'base_drift';
export type HumanRequestStatus = 'open' | 'answered' | 'expired' | 'cancelled';

export interface HumanRequest {
  id: string;
  taskId: string;
  runId: string | null;
  kind: HumanRequestKind;
  payload: Record<string, unknown>;
  /** Allowed answers; empty means free text. */
  choices: string[];
  status: HumanRequestStatus;
  expiresAt: string | null;
  createdAt: string;
}

export function fetchOpenRequests(taskId: string) {
  return apiFetch<{ requests: HumanRequest[] }>(`/api/human-requests?taskId=${taskId}&status=open`);
}

export function answerRequest(requestId: string, choice: string) {
  return apiFetch<{ request: HumanRequest }>(`/api/human-requests/${requestId}/answer`, {
    method: 'POST',
    body: JSON.stringify({ choice }),
  });
}
