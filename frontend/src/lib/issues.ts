import { apiFetch } from './api';

export type IssueStatus =
  | 'backlog'
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'blocked'
  | 'done'
  | 'cancelled';

export interface Issue {
  id: string;
  projectId: string;
  issueNumber: number;
  title: string;
  description: string;
  status: IssueStatus;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  reviewerAgentId: string | null;
  reviewerUserId: string | null;
  boardOrder: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface IssueComment {
  id: string;
  issueId: string;
  authorType: 'human' | 'agent';
  authorUserId: string | null;
  authorAgentId: string | null;
  body: string;
  createdAt: string;
}

export type ReviewDecision = 'approved' | 'changes_requested';

export interface IssueReview {
  id: string;
  issueId: string;
  reviewerType: 'human' | 'agent';
  reviewerUserId: string | null;
  reviewerAgentId: string | null;
  runId: string | null;
  decision: ReviewDecision;
  body: string;
  createdAt: string;
}

export type Board = Record<IssueStatus, Issue[]>;

export interface AssignmentPatch {
  agentId?: string | null;
  userId?: string | null;
}

export function fetchBoard(projectId?: string) {
  const query = projectId ? `?projectId=${projectId}` : '';
  return apiFetch<{ board: Board }>(`/api/issues/board${query}`);
}

export function fetchIssues(filter: { projectId?: string; status?: IssueStatus } = {}) {
  const params = new URLSearchParams();
  if (filter.projectId) params.set('projectId', filter.projectId);
  if (filter.status) params.set('status', filter.status);
  const query = params.toString();
  return apiFetch<{ issues: Issue[] }>(`/api/issues${query ? `?${query}` : ''}`);
}

export function fetchIssue(id: string) {
  return apiFetch<{ issue: Issue }>(`/api/issues/${id}`);
}

export function createIssue(input: {
  title: string;
  description?: string;
  projectId?: string;
}) {
  return apiFetch<{ issue: Issue }>('/api/issues', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateIssue(
  id: string,
  input: {
    title?: string;
    description?: string;
    assignee?: AssignmentPatch | null;
    reviewer?: AssignmentPatch | null;
  }
) {
  return apiFetch<{ issue: Issue }>(`/api/issues/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function moveIssue(id: string, input: { status: IssueStatus; boardOrder?: number }) {
  return apiFetch<{ issue: Issue }>(`/api/issues/${id}/move`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function deleteIssue(id: string) {
  return apiFetch<{ ok: boolean }>(`/api/issues/${id}`, { method: 'DELETE' });
}

export function fetchComments(issueId: string) {
  return apiFetch<{ comments: IssueComment[] }>(`/api/issues/${issueId}/comments`);
}

export function addComment(issueId: string, body: string) {
  return apiFetch<{ comment: IssueComment }>(`/api/issues/${issueId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}

export function fetchReviews(issueId: string) {
  return apiFetch<{ reviews: IssueReview[] }>(`/api/issues/${issueId}/reviews`);
}

export function submitReview(issueId: string, input: { decision: ReviewDecision; body: string }) {
  return apiFetch<{ review: IssueReview }>(`/api/issues/${issueId}/reviews`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/**
 * Client-side mirror of the server transition table, used only to preview
 * legal drop targets while dragging. The server remains the authority.
 */
export const CLIENT_TRANSITIONS: Record<IssueStatus, readonly IssueStatus[]> = {
  backlog: ['todo', 'cancelled'],
  todo: ['in_progress', 'backlog', 'cancelled'],
  in_progress: ['in_review', 'blocked', 'cancelled'],
  blocked: ['in_progress', 'cancelled'],
  in_review: ['done', 'in_progress', 'cancelled'],
  done: [],
  cancelled: [],
};

export const STATUS_META: Record<
  IssueStatus,
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
