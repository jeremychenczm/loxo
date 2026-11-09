'use client';

import { useEffect, useState } from 'react';
import type { ProjectView } from '@/lib/projects';
import { createIssue, type Issue } from '@/lib/issues';
import { BracketButton, PAPER, Rule, TornEdge } from './receipt-parts';

interface NewTicketModalProps {
  projects: ProjectView[];
  /** Preselected project, e.g. the board's active filter. */
  initialProjectId?: string;
  onClose: () => void;
  onCreated: (issue: Issue) => void;
}

const FIELD =
  'w-full border border-dashed border-pixel-gray/60 bg-transparent p-2 font-pixel text-sm text-pixel-black focus:border-pixel-black focus:outline-none';

export function NewTicketModal({
  projects,
  initialProjectId,
  onClose,
  onCreated,
}: NewTicketModalProps) {
  const defaultProject = projects.find((p) => p.kind === 'default');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [projectId, setProjectId] = useState(initialProjectId ?? defaultProject?.id ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const print = async () => {
    const trimmed = title.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const { issue } = await createIssue({
        title: trimmed,
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(projectId ? { projectId } : {}),
      });
      onCreated(issue);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed');
      setSubmitting(false);
    }
  };

  const ordered = [
    ...projects.filter((p) => p.kind === 'default'),
    ...projects.filter((p) => p.kind !== 'default'),
  ];

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-pixel-black/40" onClick={onClose} />
      <div
        className="relative flex max-h-[90vh] w-[470px] flex-col"
        style={{ filter: 'drop-shadow(3px 5px 0px rgba(17,17,17,0.25))' }}
      >
        <TornEdge />
        <div
          className="min-h-0 flex-1 overflow-y-auto px-6 py-3"
          style={{ backgroundColor: PAPER }}
        >
          <div className="text-center">
            <p className="font-pixel text-lg tracking-[0.3em] text-pixel-black">LOXO</p>
            <p className="mt-0.5 font-pixel text-[10px] uppercase tracking-[0.2em] text-pixel-gray">
              * new work order *
            </p>
          </div>

          <Rule />

          <p className="mb-1 font-pixel text-[10px] uppercase tracking-[0.2em] text-pixel-gray">
            Title
          </p>
          <textarea
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) =>
              e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), void print())
            }
            rows={2}
            autoFocus
            placeholder="What needs doing?"
            className={`${FIELD} resize-none`}
          />

          <p className="mb-1 mt-3 font-pixel text-[10px] uppercase tracking-[0.2em] text-pixel-gray">
            Description
          </p>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="(optional)"
            className={`${FIELD} resize-y`}
          />

          <div className="mt-3 flex gap-3">
            <div className="min-w-0 flex-1">
              <p className="mb-1 font-pixel text-[10px] uppercase tracking-[0.2em] text-pixel-gray">
                Project
              </p>
              <select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className={FIELD}
              >
                {ordered.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {error && (
            <p className="mt-2 text-center font-pixel text-[10px] uppercase text-pixel-red">
              ! {error}
            </p>
          )}

          <Rule dashed />

          <p className="text-center font-pixel text-[10px] uppercase tracking-[0.15em] text-pixel-gray">
            files to backlog
          </p>

          <div className="my-2 flex justify-center gap-4">
            <BracketButton onClick={() => void print()} disabled={!title.trim() || submitting}>
              {submitting ? 'PRINTING...' : 'PRINT TICKET'}
            </BracketButton>
            <BracketButton onClick={onClose}>DISCARD</BracketButton>
          </div>
        </div>
        <TornEdge bottom />
      </div>
    </div>
  );
}
