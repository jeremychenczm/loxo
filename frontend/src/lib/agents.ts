import { apiFetch } from './api';
import { API_BASE } from './runtime';
import { useAuthStore } from '@/store/auth';

export const RUNTIMES = ['claude-code', 'codex', 'opencode', 'hermes', 'openclaw', 'api'] as const;
export type Runtime = (typeof RUNTIMES)[number];

export type AgentExecution = 'server' | 'api';

export interface Agent {
  id: string;
  name: string;
  description: string;
  runtime: Runtime;
  tags: string[];
  providerId: string | null;
  model: string | null;
  avatarFile: string | null;
  status: string;
  execution: AgentExecution;
  createdAt: string;
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  updatedAt: string;
}

export interface Diagnostics {
  agent: { id: string; name: string; runtime: Runtime; model: string | null };
  cli: { available: boolean; version: string; error?: string };
  provider: { vendor: string; vendorMatch: boolean; modelCount: number } | null;
}

export const fetchAgents = () =>
  apiFetch<{ agents: Agent[] }>('/api/agents').then((r) => r.agents);

export const fetchAgent = (id: string) =>
  apiFetch<{ agent: Agent }>(`/api/agents/${id}`).then((r) => r.agent);

export const updateAgent = (id: string, input: Partial<Pick<Agent, 'name' | 'description' | 'tags'>>) =>
  apiFetch<{ agent: Agent }>(`/api/agents/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  }).then((r) => r.agent);

export const updateAgentConfig = (
  id: string,
  input: {
    providerId?: string | null;
    model?: string | null;
    execution?: AgentExecution;
  }
) =>
  apiFetch<{ agent: Agent }>(`/api/agents/${id}/config`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  }).then((r) => r.agent);

export const deleteAgent = (id: string) =>
  apiFetch<{ ok: boolean }>(`/api/agents/${id}`, { method: 'DELETE' });

export const fetchSkills = (agentId: string) =>
  apiFetch<{ skills: SkillSummary[] }>(`/api/agents/${agentId}/skills`).then((r) => r.skills);

export const fetchDiagnostics = (agentId: string) =>
  apiFetch<Diagnostics>(`/api/agents/${agentId}/diagnostics`);

export const avatarUrl = (agent: Agent) =>
  agent.avatarFile ? `${API_BASE}/api/agents/${agent.id}/avatar` : null;

/** Multipart requests bypass apiFetch (no JSON content type). */
async function multipart<T>(path: string, form: FormData): Promise<T> {
  const token = useAuthStore.getState().token;
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message ?? 'Upload failed');
  return body as T;
}

export function importAgentArchive(input: {
  name: string;
  archive: File;
  runtime?: string;
  description?: string;
}) {
  const form = new FormData();
  form.append('name', input.name);
  if (input.runtime) form.append('runtime', input.runtime);
  if (input.description) form.append('description', input.description);
  form.append('archive', input.archive);
  return multipart<{ agent: Agent; fileCount: number }>('/api/agents/import', form);
}

export function importAgentFolder(input: {
  name: string;
  files: { relativePath: string; file: File }[];
  runtime?: string;
  description?: string;
}) {
  const form = new FormData();
  form.append('name', input.name);
  if (input.runtime) form.append('runtime', input.runtime);
  if (input.description) form.append('description', input.description);
  for (const { relativePath, file } of input.files) {
    form.append('files', file, relativePath);
  }
  return multipart<{ agent: Agent; fileCount: number }>('/api/agents/import', form);
}

export function uploadAvatar(agentId: string, file: File) {
  const form = new FormData();
  form.append('avatar', file);
  return multipart<{ ok: boolean; avatarUrl: string }>(`/api/agents/${agentId}/avatar`, form);
}

export function uploadSkill(agentId: string, file: File, name?: string) {
  const form = new FormData();
  if (name) form.append('name', name);
  form.append('skill', file);
  return multipart<{ skills: SkillSummary[] }>(`/api/agents/${agentId}/skills`, form);
}
