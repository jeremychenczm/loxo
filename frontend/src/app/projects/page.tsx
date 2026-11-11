'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { RequireAuth } from '@/components/auth/RequireAuth';
import { fetchAgents, type Agent } from '@/lib/agents';
import {
  createProject,
  deleteProject,
  fetchProjects,
  type ProjectView,
} from '@/lib/projects';

function formatRecency(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

interface CreateDialogProps {
  agents: Agent[];
  onClose: () => void;
  onCreated: (project: ProjectView) => void;
}

function CreateDialog({ agents, onClose, onCreated }: CreateDialogProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (list: string[], id: string, set: (v: string[]) => void) =>
    set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const save = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const project = await createProject({
        name: name.trim(),
        description: description.trim() || undefined,
        agentIds,
      });
      onCreated(project);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create project');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-pixel-black/70 p-4">
      <div className="w-full max-w-lg border border-pixel-line bg-pixel-white shadow-pixel p-5">
        <h2 className="text-lg font-semibold">New project</h2>
        <div className="mt-4 space-y-3">
          <input
            autoFocus
            className="w-full border border-pixel-line bg-pixel-white font-sans text-pixel-black px-3 py-2 text-sm outline-none focus:border-pixel-blue"
            placeholder="Project name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <textarea
            className="w-full border border-pixel-line bg-pixel-white font-sans text-pixel-black px-3 py-2 text-sm outline-none focus:border-pixel-blue"
            placeholder="What is this project about? (optional)"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <div>
            <p className="mb-1 text-xs font-medium text-pixel-black/60">Agents</p>
            <div className="flex flex-wrap gap-2">
              {agents.map((agent) => (
                <button
                  key={agent.id}
                  onClick={() => toggle(agentIds, agent.id, setAgentIds)}
                  className={`border px-2 py-1 text-xs ${
                    agentIds.includes(agent.id)
                      ? 'border-pixel-line bg-pixel-yellow/30 font-bold text-pixel-black'
                      : 'border-pixel-line text-pixel-black/60 hover:bg-pixel-cream'
                  }`}
                >
                  {agent.name}
                </button>
              ))}
              {agents.length === 0 && <p className="text-xs text-pixel-black/50">No agents yet.</p>}
            </div>
          </div>
          {error && <p className="text-xs text-pixel-red">{error}</p>}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="border border-pixel-line bg-pixel-white font-sans text-pixel-black shadow-pixel-sm px-4 py-2 text-sm text-pixel-black/70 hover:bg-pixel-cream"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={!name.trim() || saving}
            className="bg-pixel-yellow px-4 py-2 text-sm font-medium text-pixel-black disabled:opacity-50"
          >
            {saving ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ProjectsPageInner() {
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [showCreate, setShowCreate] = useState(false);

  const reload = useCallback(() => {
    // The built-in default project is a task fallback, not a managed project.
    fetchProjects()
      .then((all) => setProjects(all.filter((p) => p.kind !== 'default')))
      .catch(() => setProjects([]));
  }, []);

  useEffect(() => {
    reload();
    fetchAgents().then(setAgents).catch(() => setAgents([]));
  }, [reload]);

  const remove = async (project: ProjectView) => {
    if (!confirm(`Delete project "${project.name}"? Its workspace files will be removed.`)) return;
    await deleteProject(project.id);
    reload();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Projects</h1>
          <p className="text-sm text-pixel-black/50">{projects.length} workspaces</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="bg-pixel-yellow px-4 py-2 text-sm font-medium text-pixel-black"
        >
          New project
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        {projects.map((project) => (
          <div key={project.id} className="border border-pixel-line bg-pixel-white shadow-pixel p-4">
            <div className="flex items-start justify-between">
              <Link href={`/projects/${project.id}`} className="font-medium hover:text-pixel-blue">
                {project.name}
              </Link>
              <button
                onClick={() => remove(project)}
                className="text-xs text-pixel-black/50 hover:text-pixel-red"
              >
                delete
              </button>
            </div>
            <p className="mt-1 truncate text-xs text-pixel-black/60">
              {project.agentIds.length} agents ·{' '}
              {project.description || 'No description yet'}
            </p>
            <p className="mt-1 text-xs text-pixel-black/50">Last active {formatRecency(project.updatedAt)}</p>
          </div>
        ))}
      </div>
      {projects.length === 0 && (
        <p className="text-sm text-pixel-black/50">No projects yet. Create one to give your agents a shared workspace.</p>
      )}

      {showCreate && (
        <CreateDialog
          agents={agents}
          onClose={() => setShowCreate(false)}
          onCreated={(project) => {
            window.location.href = `/projects/${project.id}`;
          }}
        />
      )}
    </div>
  );
}

export default function ProjectsPage() {
  return (
    <RequireAuth>
      <ProjectsPageInner />
    </RequireAuth>
  );
}
