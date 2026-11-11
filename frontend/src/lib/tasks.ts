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
  leadAgentId: string | null;
  /** Active members in speaking order; the lead is among them. */
  memberAgentIds: string[];
  boardOrder: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export type TurnKind = 'agent' | 'human' | 'system';

export interface Turn {
  id: string;
  taskId: string;
  seq: number;
  kind: TurnKind;
  agentId: string | null;
  authorUserId: string | null;
  runId: string | null;
  status: string;
  report: Record<string, unknown> | null;
  content: string;
  createdAt: string;
}

export type ApprovalDecision = 'approved' | 'changes_requested';

export interface Approval {
  id: string;
  taskId: string;
  decision: ApprovalDecision;
  body: string;
  fingerprint: string | null;
  createdAt: string;
}

/** Agent review turns carry the verdict in their report. */
export function reviewDecisionOf(turn: Turn): ApprovalDecision | null {
  if (turn.kind !== 'agent' || turn.report?.type !== 'review') return null;
  const decision = turn.report.decision;
  return decision === 'approved' || decision === 'changes_requested' ? decision : null;
}

export type Board = Record<TaskStatus, Task[]>;

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
  crewId?: string;
  leadAgentId?: string;
  memberAgentIds?: string[];
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
    leadAgentId?: string | null;
    memberAgentIds?: string[];
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

export function fetchTurns(taskId: string) {
  return apiFetch<{ turns: Turn[] }>(`/api/tasks/${taskId}/turns`);
}

export function addTurn(taskId: string, content: string) {
  return apiFetch<{ turn: Turn }>(`/api/tasks/${taskId}/turns`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
}

export function fetchApprovals(taskId: string) {
  return apiFetch<{ approvals: Approval[] }>(`/api/tasks/${taskId}/approvals`);
}

export function submitApproval(taskId: string, input: { decision: ApprovalDecision; body: string }) {
  return apiFetch<{ approval: Approval }>(`/api/tasks/${taskId}/approvals`, {
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
