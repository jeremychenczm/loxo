import { apiFetch } from './api';

export type TaskStatus =
  | 'backlog'
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'blocked'
  | 'done'
  | 'cancelled';

export interface Task {
  id: string;
  repositoryId: string | null;
  number: number;
  title: string;
  brief: string;
  status: TaskStatus;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  reviewerAgentId: string | null;
  reviewerUserId: string | null;
  boardOrder: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface TaskComment {
  id: string;
  taskId: string;
  authorType: 'human' | 'agent';
  authorUserId: string | null;
  authorAgentId: string | null;
  body: string;
  createdAt: string;
}

export type ReviewDecision = 'approved' | 'changes_requested';

export interface TaskReview {
  id: string;
  taskId: string;
  reviewerType: 'human' | 'agent';
  reviewerUserId: string | null;
  reviewerAgentId: string | null;
  runId: string | null;
  decision: ReviewDecision;
  body: string;
  createdAt: string;
}

export type Board = Record<TaskStatus, Task[]>;

export interface AssignmentPatch {
  agentId?: string | null;
  userId?: string | null;
}

export function fetchBoard(repositoryId?: string) {
  const query = repositoryId ? `?repositoryId=${repositoryId}` : '';
  return apiFetch<{ board: Board }>(`/api/tasks/board${query}`);
}

export function fetchTasks(filter: { repositoryId?: string; status?: TaskStatus } = {}) {
  const params = new URLSearchParams();
  if (filter.repositoryId) params.set('repositoryId', filter.repositoryId);
  if (filter.status) params.set('status', filter.status);
  const query = params.toString();
  return apiFetch<{ tasks: Task[] }>(`/api/tasks${query ? `?${query}` : ''}`);
}

export function fetchTask(id: string) {
  return apiFetch<{ task: Task }>(`/api/tasks/${id}`);
}

export function createTask(input: {
  title: string;
  brief?: string;
  repositoryId?: string;
}) {
  return apiFetch<{ task: Task }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateTask(
  id: string,
  input: {
    title?: string;
    brief?: string;
    assignee?: AssignmentPatch | null;
    reviewer?: AssignmentPatch | null;
  }
) {
  return apiFetch<{ task: Task }>(`/api/tasks/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function moveTask(id: string, input: { status: TaskStatus; boardOrder?: number }) {
  return apiFetch<{ task: Task }>(`/api/tasks/${id}/move`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function deleteTask(id: string) {
  return apiFetch<{ ok: boolean }>(`/api/tasks/${id}`, { method: 'DELETE' });
}

export function fetchComments(taskId: string) {
  return apiFetch<{ comments: TaskComment[] }>(`/api/tasks/${taskId}/comments`);
}

export function addComment(taskId: string, body: string) {
  return apiFetch<{ comment: TaskComment }>(`/api/tasks/${taskId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}

export function fetchReviews(taskId: string) {
  return apiFetch<{ reviews: TaskReview[] }>(`/api/tasks/${taskId}/reviews`);
}

export function submitReview(taskId: string, input: { decision: ReviewDecision; body: string }) {
  return apiFetch<{ review: TaskReview }>(`/api/tasks/${taskId}/reviews`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/**
 * Client-side mirror of the server transition table, used only to preview
 * legal drop targets while dragging. The server remains the authority.
 */
export const CLIENT_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  backlog: ['todo', 'cancelled'],
  todo: ['in_progress', 'backlog', 'cancelled'],
  in_progress: ['in_review', 'blocked', 'cancelled'],
  blocked: ['in_progress', 'cancelled'],
  in_review: ['done', 'in_progress', 'cancelled'],
  done: [],
  cancelled: [],
};

export const STATUS_META: Record<
  TaskStatus,
  { label: string; swatch: string; text: string }
> = {
  backlog: { label: 'Backlog', swatch: 'bg-pixel-gray', text: 'text-pixel-gray' },
  todo: { label: 'Todo', swatch: 'bg-pixel-steel', text: 'text-pixel-steel' },
  in_progress: { label: 'In Progress', swatch: 'bg-pixel-yellow', text: 'text-pixel-orange' },
  in_review: { label: 'In Review', swatch: 'bg-pixel-plum', text: 'text-pixel-plum' },
  blocked: { label: 'Blocked', swatch: 'bg-pixel-red', text: 'text-pixel-red' },
  done: { label: 'Done', swatch: 'bg-pixel-green', text: 'text-pixel-green' },
  cancelled: { label: 'Cancelled', swatch: 'bg-pixel-gray', text: 'text-pixel-gray' },
};
