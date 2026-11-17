import { apiFetch } from './api';
import { API_BASE } from './runtime';
import { useAuthStore } from '@/store/auth';

export const RUNTIMES = ['claude-code', 'codex', 'opencode', 'hermes', 'openclaw', 'api'] as const;
export type Runtime = (typeof RUNTIMES)[number];

export const RUNTIME_LABELS: Record<Runtime, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  hermes: 'Hermes',
  openclaw: 'OpenClaw',
  api: 'Hosted API',
};

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

export interface Diagnostics {
  agent: { id: string; name: string; runtime: Runtime; model: string | null };
  cli: { available: boolean; version: string; error?: string };
  provider: { vendor: string; vendorMatch: boolean; modelCount: number } | null;
}

export const fetchAgents = () =>
  apiFetch<{ agents: Agent[] }>('/api/agents').then((r) => r.agents);

export const createAgent = (input: { name: string; description?: string; runtime: Runtime }) =>
  apiFetch<{ agent: Agent }>('/api/agents', { method: 'POST', body: JSON.stringify(input) }).then(
    (r) => r.agent
  );

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

export function uploadAvatar(agentId: string, file: File) {
  const form = new FormData();
  form.append('avatar', file);
  return multipart<{ ok: boolean; avatarUrl: string }>(`/api/agents/${agentId}/avatar`, form);
}
