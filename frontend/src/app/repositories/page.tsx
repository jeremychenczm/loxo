'use client';

import { useCallback, useEffect, useState } from 'react';
import { RequireAuth } from '@/components/auth/RequireAuth';
import { ApiError } from '@/lib/api';
import {
  createRepository,
  deleteRepository,
  fetchRepositories,
  inspectRepository,
  type Repository,
  type RepositoryInspection,
} from '@/lib/repositories';

const inputClass =
  'w-full border border-pixel-line bg-pixel-white font-sans text-pixel-black px-3 py-2 text-sm outline-none focus:border-pixel-blue';

function RepositoryForm({ onCreated }: { onCreated: () => void }) {
  const [rootPath, setRootPath] = useState('');
  const [name, setName] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await createRepository({
        rootPath: rootPath.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
        defaultBranch: defaultBranch.trim() || 'main',
      });
      setRootPath('');
      setName('');
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to add repository');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3 border border-pixel-line bg-pixel-white shadow-pixel p-4">
      <h2 className="font-medium">Add repository</h2>
      <p className="text-xs text-pixel-black/60">
        Point Loxo at the root of a local git repository. Agents work in separate worktrees on
        loxo/ branches; your checkout is left alone until you merge.
      </p>
      <input
        className={inputClass}
        placeholder="Absolute path, e.g. /home/you/code/ledger"
        value={rootPath}
        onChange={(e) => setRootPath(e.target.value)}
        required
      />
      <div className="grid grid-cols-2 gap-3">
        <input
          className={inputClass}
          placeholder="Display name (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className={inputClass}
          placeholder="Default branch"
          value={defaultBranch}
          onChange={(e) => setDefaultBranch(e.target.value)}
        />
      </div>
      {error && <p className="text-xs text-pixel-red">{error}</p>}
      <button
        type="submit"
        disabled={saving || !rootPath.trim()}
        className="bg-pixel-yellow px-4 py-2 text-sm font-medium text-pixel-black disabled:opacity-50"
      >
        {saving ? 'Checking…' : 'Add repository'}
      </button>
    </form>
  );
}

function StatusLine({ inspection }: { inspection: RepositoryInspection | undefined }) {
  if (!inspection) return <span className="text-pixel-black/50">checking…</span>;
  if (!inspection.valid) return <span className="text-pixel-red">{inspection.error}</span>;
  if (inspection.sameRepository === false) {
    return <span className="text-pixel-red">a different repository now lives at this path</span>;
  }
  return (
    <span className="text-pixel-black/60">
      on {inspection.currentBranch ?? 'detached HEAD'}
      {inspection.dirty ? ' · uncommitted changes' : ' · clean'}
    </span>
  );
}

function RepositoriesPageInner() {
  const [items, setItems] = useState<Repository[]>([]);
  const [inspections, setInspections] = useState<Record<string, RepositoryInspection>>({});
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    fetchRepositories()
      .then((repositories) => {
        setItems(repositories);
        for (const repository of repositories) {
          inspectRepository(repository.id)
            .then((inspection) =>
              setInspections((prev) => ({ ...prev, [repository.id]: inspection }))
            )
            .catch(() => {});
        }
      })
      .catch(() => setError('Failed to load repositories'));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const remove = async (repository: Repository) => {
    if (!confirm(`Remove "${repository.name}" from Loxo? Files on disk are not touched.`)) return;
    setError(null);
    try {
      await deleteRepository(repository.id);
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to remove repository');
    }
  };

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">Repositories</h1>
      {error && <p className="text-sm text-pixel-red">{error}</p>}

      <section className="space-y-3">
        {items.length === 0 && (
          <p className="text-sm text-pixel-black/60">No repositories yet. Add one below.</p>
        )}
        {items.map((repository) => (
          <div
            key={repository.id}
            className="flex items-center justify-between gap-4 border border-pixel-line bg-pixel-white shadow-pixel px-4 py-3"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium">{repository.name}</span>
                <span className="border border-pixel-line bg-pixel-yellow px-1.5 py-0.5 font-sans text-xs text-pixel-black">
                  {repository.defaultBranch}
                </span>
              </div>
              <p className="mt-0.5 truncate font-mono text-xs text-pixel-black/60" title={repository.rootPath}>
                {repository.rootPath}
              </p>
              <p className="mt-0.5 text-xs">
                <StatusLine inspection={inspections[repository.id]} />
              </p>
            </div>
            <button
              onClick={() => remove(repository)}
              className="shrink-0 border border-red-900 px-2 py-1 text-xs text-pixel-red hover:border-pixel-red"
            >
              Remove
            </button>
          </div>
        ))}
      </section>

      <RepositoryForm onCreated={reload} />
    </div>
  );
}

export default function RepositoriesPage() {
  return (
    <RequireAuth>
      <RepositoriesPageInner />
    </RequireAuth>
  );
}
