import { apiFetch } from './api';

export type WorkspaceStatus =
  | 'preparing'
  | 'ready'
  | 'dirty'
  | 'quarantined'
  | 'conflicted'
  | 'missing'
  | 'error'
  | 'merged'
  | 'retained'
  | 'abandoned';

export interface TaskWorkspace {
  id: string;
  status: WorkspaceStatus;
  branchName: string;
  lastError: string | null;
}

export function fetchTaskWorkspace(taskId: string) {
  return apiFetch<{ workspace: TaskWorkspace | null }>(`/api/tasks/${taskId}/workspace`);
}

export function reconcileTaskWorkspace(taskId: string) {
  return apiFetch<{ workspace: TaskWorkspace }>(`/api/tasks/${taskId}/workspace/reconcile`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}
