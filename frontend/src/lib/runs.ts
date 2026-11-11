import { apiFetch } from './api';

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type RunTrigger = 'assignment' | 'manual' | 'comment' | 'chat' | 'review';

export interface Run {
  id: string;
  agentId: string | null;
  agentName: string;
  taskId: string | null;
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

export function fetchRuns(filter: { taskId?: string; agentId?: string } = {}) {
  const params = new URLSearchParams();
  if (filter.taskId) params.set('taskId', filter.taskId);
  if (filter.agentId) params.set('agentId', filter.agentId);
  const query = params.toString();
  return apiFetch<{ runs: Run[] }>(`/api/runs${query ? `?${query}` : ''}`);
}

export function wakeTask(taskId: string, reason?: string) {
  return apiFetch<{ run: Run; admitted: 'started' | 'queued' | 'merged' }>(
    `/api/tasks/${taskId}/wake`,
    { method: 'POST', body: JSON.stringify(reason ? { reason } : {}) }
  );
}
