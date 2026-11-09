import { apiFetch } from './api';

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type RunTrigger = 'assignment' | 'manual' | 'comment' | 'chat' | 'review';

export interface Run {
  id: string;
  agentId: string | null;
  agentName: string;
  issueId: string | null;
  trigger: RunTrigger;
  status: RunStatus;
  reason: string;
  output: string;
  error: string | null;
  sessionRef: string | null;
  model: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ['queued', 'running'];

export function fetchRuns(filter: { issueId?: string; agentId?: string } = {}) {
  const params = new URLSearchParams();
  if (filter.issueId) params.set('issueId', filter.issueId);
  if (filter.agentId) params.set('agentId', filter.agentId);
  const query = params.toString();
  return apiFetch<{ runs: Run[] }>(`/api/runs${query ? `?${query}` : ''}`);
}

export function wakeIssue(issueId: string, reason?: string) {
  return apiFetch<{ run: Run; admitted: 'started' | 'queued' | 'merged' }>(
    `/api/issues/${issueId}/wake`,
    { method: 'POST', body: JSON.stringify(reason ? { reason } : {}) }
  );
}
