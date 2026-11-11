import { apiFetch } from './api';
import type { Task } from './tasks';

export interface Conversation {
  id: string;
  agentId: string;
  title: string;
  lastMessagePreview: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  meta?: { error?: boolean; durationMs?: number; source?: string; taskId?: string };
  createdAt: string;
}

export interface TaskDraft {
  title: string;
  brief: string;
  source: 'anthropic' | 'openai' | 'fallback';
  warnings: string[];
  window: { fromMessageId: string; toMessageId: string; count: number };
}

export const fetchConversations = (agentId: string) =>
  apiFetch<{ conversations: Conversation[] }>(`/api/conversations?agentId=${agentId}`).then(
    (r) => r.conversations
  );

export const createConversation = (agentId: string) =>
  apiFetch<{ conversation: Conversation }>('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ agentId }),
  }).then((r) => r.conversation);

export const renameConversation = (id: string, title: string) =>
  apiFetch<{ conversation: Conversation }>(`/api/conversations/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  }).then((r) => r.conversation);

export const deleteConversation = (id: string) =>
  apiFetch<{ ok: boolean }>(`/api/conversations/${id}`, { method: 'DELETE' });

export const fetchMessages = (id: string) =>
  apiFetch<{ messages: ChatMessage[] }>(`/api/conversations/${id}/messages`).then(
    (r) => r.messages
  );

export const exportUrl = (id: string) => `/api/conversations/${id}/export`;

export const draftTask = (id: string, range?: { fromMessageId?: string; toMessageId?: string }) =>
  apiFetch<{ draft: TaskDraft }>(`/api/conversations/${id}/draft-task`, {
    method: 'POST',
    body: JSON.stringify(range ?? {}),
  }).then((r) => r.draft);

export const fileTask = (
  id: string,
  input: { title: string; brief?: string; projectId?: string }
) =>
  apiFetch<{ task: Task }>(`/api/conversations/${id}/file-task`, {
    method: 'POST',
    body: JSON.stringify(input),
  }).then((r) => r.task);
