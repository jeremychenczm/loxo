import { apiFetch } from './api';

export interface RepositoryCheck {
  name: string;
  command: string;
  timeoutSeconds: number;
}

export interface Repository {
  id: string;
  name: string;
  rootPath: string;
  defaultBranch: string;
  setupCommand: string | null;
  checks: RepositoryCheck[];
  createdAt: string;
  updatedAt: string;
}

export interface RepositoryInspection {
  valid: boolean;
  error?: string;
  currentBranch?: string | null;
  dirty?: boolean;
  sameRepository?: boolean;
}

export const fetchRepositories = () =>
  apiFetch<{ repositories: Repository[] }>('/api/repositories').then((r) => r.repositories);

export const createRepository = (input: {
  rootPath: string;
  name?: string;
  defaultBranch?: string;
}) =>
  apiFetch<{ repository: Repository }>('/api/repositories', {
    method: 'POST',
    body: JSON.stringify(input),
  }).then((r) => r.repository);

export const inspectRepository = (id: string) =>
  apiFetch<{ inspection: RepositoryInspection }>(`/api/repositories/${id}/inspect`, {
    method: 'POST',
  }).then((r) => r.inspection);

export const deleteRepository = (id: string) =>
  apiFetch<{ ok: boolean }>(`/api/repositories/${id}`, { method: 'DELETE' });
