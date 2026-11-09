'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { RequireAuth } from '@/components/auth/RequireAuth';
import { FilePreviewModal, FilesPanel } from '@/components/projects/FilesPanel';
import { openProject, type ProjectView } from '@/lib/projects';

function ProjectWorkspaceInner({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<ProjectView | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);

  useEffect(() => {
    openProject(projectId).then(setProject).catch(() => {});
  }, [projectId]);

  if (!project) {
    return <p className="text-sm text-pixel-black/50">Loading project…</p>;
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">{project.name}</h1>
        <p className="text-sm text-pixel-black/50">{project.description || 'No description yet'}</p>
      </div>

      <div className="h-[70vh] overflow-hidden border border-pixel-line bg-pixel-white shadow-pixel">
        <FilesPanel
          projectId={projectId}
          projectName={project.name}
          refreshToken={0}
          onPreview={setPreviewPath}
          onFileRemoved={(path) => {
            if (previewPath === path) setPreviewPath(null);
          }}
        />
      </div>

      {previewPath && (
        <FilePreviewModal projectId={projectId} path={previewPath} onClose={() => setPreviewPath(null)} />
      )}
    </div>
  );
}

export default function ProjectWorkspacePage() {
  const params = useParams<{ id: string }>();
  return (
    <RequireAuth>
      <ProjectWorkspaceInner projectId={String(params.id)} />
    </RequireAuth>
  );
}
