import { apiFetch } from './api';
import { API_BASE } from './runtime';
import { useAuthStore } from '@/store/auth';

export interface ProjectView {
  id: string;
  name: string;
  description: string;
  /** 'default' is the built-in fallback project for tasks created without one. */
  kind: 'normal' | 'default';
  agentIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string;
  children?: FileNode[];
}

export interface FileTree {
  projectId: string;
  root: FileNode;
  truncated: boolean;
  totalEntries: number;
}

export interface FilePreview {
  name: string;
  path: string;
  size: number;
  modifiedAt: string;
  content: string;
  truncated: boolean;
  binary: boolean;
}

export const fetchProjects = () =>
  apiFetch<{ projects: ProjectView[] }>('/api/projects').then((r) => r.projects);

export const fetchProject = (id: string) =>
  apiFetch<{ project: ProjectView }>(`/api/projects/${id}`).then((r) => r.project);

export const createProject = (input: {
  name: string;
  description?: string;
  agentIds?: string[];
}) =>
  apiFetch<{ project: ProjectView }>('/api/projects', {
    method: 'POST',
    body: JSON.stringify(input),
  }).then((r) => r.project);

export const updateProject = (
  id: string,
  input: { name?: string; description?: string; agentIds?: string[] }
) =>
  apiFetch<{ project: ProjectView }>(`/api/projects/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  }).then((r) => r.project);

export const deleteProject = (id: string) =>
  apiFetch<{ ok: boolean }>(`/api/projects/${id}`, { method: 'DELETE' });

/** Recency bump when the workspace opens. */
export const openProject = (id: string) =>
  apiFetch<{ project: ProjectView }>(`/api/projects/${id}/open`, { method: 'POST' }).then(
    (r) => r.project
  );

export const fetchFileTree = (id: string, path = '') =>
  apiFetch<{ tree: FileTree }>(
    `/api/projects/${id}/files${path ? `?path=${encodeURIComponent(path)}` : ''}`
  ).then((r) => r.tree);

export const fetchFilePreview = (id: string, path: string) =>
  apiFetch<{ file: FilePreview }>(
    `/api/projects/${id}/files/content?path=${encodeURIComponent(path)}`
  ).then((r) => r.file);

export const renameProjectFile = (id: string, path: string, newName: string) =>
  apiFetch<{ file: FileNode }>(`/api/projects/${id}/files`, {
    method: 'PATCH',
    body: JSON.stringify({ path, newName }),
  }).then((r) => r.file);

export const deleteProjectFile = (id: string, path: string) =>
  apiFetch<{ ok: boolean }>(`/api/projects/${id}/files`, {
    method: 'DELETE',
    body: JSON.stringify({ path }),
  });

/** Authenticated binary fetch; saves via a temporary object URL. */
async function saveBlob(path: string, fallbackName: string): Promise<void> {
  const token = useAuthStore.getState().token;
  const res = await fetch(`${API_BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error('Download failed');

  const disposition = res.headers.get('Content-Disposition') ?? '';
  const match = disposition.match(/filename="([^"]+)"/);
  const name = match ? decodeURIComponent(match[1]!) : fallbackName;

  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export const downloadProjectFile = (id: string, path: string) =>
  saveBlob(
    `/api/projects/${id}/files/download?path=${encodeURIComponent(path)}`,
    path.split('/').pop() ?? 'file'
  );

export const downloadProjectArchive = (id: string, projectName: string) =>
  saveBlob(`/api/projects/${id}/files/archive`, `${projectName}.zip`);
