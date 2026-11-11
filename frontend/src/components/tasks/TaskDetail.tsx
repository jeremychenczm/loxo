'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuthStore } from '@/store/auth';
import type { Agent } from '@/lib/agents';
import { BracketButton, CircularStamp, PAPER, Rule, TornEdge } from './task-detail-parts';
import {
  CLIENT_TRANSITIONS,
  STATUS_META,
  addComment,
  deleteTask,
  fetchComments,
  fetchTask,
  fetchReviews,
  moveTask,
  submitReview,
  updateTask,
  type Task,
  type TaskComment,
  type TaskReview,
  type TaskStatus,
} from '@/lib/tasks';
import { ACTIVE_RUN_STATUSES, fetchRuns, wakeTask, type Run, type RunStatus } from '@/lib/runs';

const RUN_STATUS_TEXT: Record<RunStatus, string> = {
  queued: 'text-pixel-gray',
  running: 'text-pixel-orange',
  succeeded: 'text-pixel-green',
  failed: 'text-pixel-red',
  cancelled: 'text-pixel-gray',
};

/** Mirror of the server-side automated rework fuse; display only. */
const REVIEW_CYCLE_CAP = 3;

const DECISION_META = {
  approved: { label: 'APPROVED', text: 'text-pixel-green' },
  changes_requested: { label: 'CHANGES REQUESTED', text: 'text-pixel-red' },
} as const;

/** Verdict comments carry a stamp prefix; tint them to match the decision. */
function commentTone(body: string): string {
  if (body.startsWith('[APPROVED]')) return 'text-pixel-green';
  if (body.startsWith('[CHANGES REQUESTED]') || body.startsWith('[REVIEW HALTED]')) {
    return 'text-pixel-red';
  }
  return 'text-pixel-black';
}

interface TaskDetailProps {
  taskId: string;
  /** Play the thermal-printer feed entrance (used right after creation). */
  printEntrance?: boolean;
  repositoryName?: string;
  agents: Agent[];
  onClose: () => void;
  /** Fired after any mutation so the board behind can refresh. */
  onChanged: () => void;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function principalValue(agentId: string | null, userId: string | null): string {
  if (agentId) return `agent:${agentId}`;
  if (userId) return `user:${userId}`;
  return '';
}

/** Deterministic pseudo-barcode drawn from the task id. */
function Barcode({ seed }: { seed: string }) {
  const bars = seed
    .replace(/-/g, '')
    .slice(0, 28)
    .split('')
    .map((ch, i) => ({ w: (ch.charCodeAt(0) % 3) + 1, gap: i % 4 === 3 ? 3 : 1 }));
  return (
    <div className="flex h-7 items-stretch justify-center" aria-hidden>
      {bars.map((b, i) => (
        <span
          key={i}
          className="bg-pixel-black"
          style={{ width: b.w, marginRight: b.gap }}
        />
      ))}
    </div>
  );
}

/** Ticket key-value row: label, dotted leader, right-aligned value. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-end gap-1">
      <span className="shrink-0 font-pixel text-sm uppercase text-pixel-gray">{label}</span>
      <span className="mb-[3px] min-w-4 flex-1 border-b border-dotted border-pixel-gray/50" />
      {children}
    </div>
  );
}

const VALUE_SELECT =
  'max-w-[55%] cursor-pointer appearance-none border-b border-transparent bg-transparent text-right font-pixel text-sm text-pixel-black hover:border-pixel-black focus:border-pixel-black focus:outline-none';

export function TaskDetail({
  taskId,
  printEntrance = false,
  repositoryName,
  agents,
  onClose,
  onChanged,
}: TaskDetailProps) {
  const me = useAuthStore((s) => s.user);
  const [task, setTask] = useState<Task | null>(null);
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [reviews, setReviews] = useState<TaskReview[]>([]);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [draft, setDraft] = useState('');
  const [verdictNote, setVerdictNote] = useState('');
  const [error, setError] = useState('');
  const [fed, setFed] = useState(!printEntrance);

  // Reduced-motion users never get an animationend event; time out the feed.
  useEffect(() => {
    if (!printEntrance) return;
    const t = setTimeout(() => setFed(true), 4800);
    return () => clearTimeout(t);
  }, [printEntrance]);

  const load = useCallback(async () => {
    const [{ task: fetched }, { comments: timeline }, { runs: ledger }, { reviews: verdicts }] =
      await Promise.all([
        fetchTask(taskId),
        fetchComments(taskId),
        fetchRuns({ taskId }),
        fetchReviews(taskId),
      ]);
    setTask(fetched);
    setTitle(fetched.title);
    setBrief(fetched.brief);
    setComments(timeline);
    setRuns(ledger);
    setReviews(verdicts);
  }, [taskId]);

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : 'Load failed'));
  }, [load]);

  // Live runs settle asynchronously; keep the ticket fresh while one is
  // hot, and let the board behind track the agent-driven moves too.
  useEffect(() => {
    if (!runs.some((r) => ACTIVE_RUN_STATUSES.includes(r.status))) return;
    const t = setTimeout(() => {
      void load()
        .then(() => onChanged())
        .catch(() => undefined);
    }, 2000);
    return () => clearTimeout(t);
  }, [runs, load, onChanged]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const mutate = useCallback(
    async (action: () => Promise<unknown>) => {
      setError('');
      try {
        await action();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Update failed');
      }
      await load().catch(() => undefined);
      onChanged();
    },
    [load, onChanged]
  );

  if (!task) {
    return (
      <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
        <div className="absolute inset-0 bg-pixel-black/40" onClick={onClose} />
        {printEntrance && (
          <div className="relative w-[470px]">
            <div className="h-4 bg-pixel-black px-3">
              <div className="mt-[6px] h-[3px] bg-pixel-cream/30" />
            </div>
            <p className="mt-3 animate-blink-steps text-center font-pixel text-xs uppercase tracking-[0.3em] text-pixel-white">
              printing...
            </p>
          </div>
        )}
      </div>
    );
  }

  const feeding = printEntrance && !fed;

  const meta = STATUS_META[task.status];
  const legalMoves = CLIENT_TRANSITIONS[task.status].filter((s) => s !== 'cancelled');
  const canCancel = CLIENT_TRANSITIONS[task.status].includes('cancelled');
  const agentName = (id: string | null) => agents.find((a) => a.id === id)?.name ?? 'agent';
  const orderNo = `ORD-${String(task.number).padStart(4, '0')}`;
  const agentRejections = reviews.filter(
    (r) => r.reviewerType === 'agent' && r.decision === 'changes_requested'
  ).length;

  const saveTitle = () => {
    const next = title.trim();
    if (!next || next === task.title) {
      setTitle(task.title);
      return;
    }
    void mutate(() => updateTask(task.id, { title: next }));
  };

  const saveBrief = () => {
    if (brief === task.brief) return;
    void mutate(() => updateTask(task.id, { brief }));
  };

  const changePrincipal = (slot: 'assignee' | 'reviewer', value: string) => {
    const patch =
      value === ''
        ? null
        : value.startsWith('agent:')
          ? { agentId: value.slice(6) }
          : { userId: value.slice(5) };
    void mutate(() => updateTask(task.id, { [slot]: patch }));
  };

  const postComment = () => {
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    void mutate(() => addComment(task.id, body));
  };

  const wakeAssignee = () => {
    void mutate(() => wakeTask(task.id));
  };

  // Approve stands alone; requesting changes needs a written reason the
  // reworking agent can act on.
  const stampVerdict = (decision: 'approved' | 'changes_requested') => {
    const body = verdictNote.trim() || (decision === 'approved' ? 'Approved.' : '');
    if (!body) return;
    setVerdictNote('');
    void mutate(() => submitReview(task.id, { decision, body }));
  };

  const cancelTask = () => {
    if (window.confirm(`Cancel ${orderNo}? This cannot be undone.`)) {
      void mutate(() => moveTask(task.id, { status: 'cancelled' }));
    }
  };

  const removeTask = async () => {
    if (!window.confirm(`Delete ${orderNo} and its activity permanently?`)) return;
    setError('');
    try {
      await deleteTask(task.id);
      onChanged();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-pixel-black/40" onClick={onClose} />
      <div
        className="relative flex max-h-[90vh] w-[470px] flex-col"
        style={{ filter: 'drop-shadow(3px 5px 0px rgba(17,17,17,0.25))' }}
      >
        {feeding && (
          <div className="relative z-10 -mx-3 h-4 bg-pixel-black px-3">
            <div className="mt-[6px] h-[3px] bg-pixel-cream/30" />
          </div>
        )}
        <div className={`flex min-h-0 flex-col ${feeding ? 'overflow-hidden' : ''}`}>
          <div
            className={`flex min-h-0 flex-col ${feeding ? 'animate-print-feed motion-reduce:animate-none' : ''}`}
            onAnimationEnd={() => setFed(true)}
          >
        <TornEdge />
        <div
          className="relative min-h-0 flex-1 overflow-y-auto px-6 py-3"
          style={{ backgroundColor: PAPER }}
        >
          {/* Header row doubles as the stamping zone: centered masthead with
              the chop inked over its right side via multiply blend */}
          <div className="relative flex min-h-[112px] items-center justify-center">
            <div className="text-center">
              <p className="font-pixel text-lg tracking-[0.3em] text-pixel-black">LOXO</p>
              <p className="mt-0.5 font-pixel text-[10px] uppercase tracking-[0.2em] text-pixel-gray">
                * work order *
              </p>
              <p className="mt-1 font-pixel text-[10px] text-pixel-gray">
                {orderNo} · {formatTime(task.createdAt)}
              </p>
            </div>
            <div
              className={`absolute right-0 top-1/2 -translate-y-1/2 mix-blend-multiply ${meta.text}`}
            >
              <CircularStamp
                label={meta.label}
                date={formatTime(task.updatedAt).slice(0, 5)}
                orderNo={orderNo}
                seed={task.id}
              />
              {legalMoves.length > 0 && (
                <select
                  value={task.status}
                  onChange={(e) =>
                    e.target.value !== task.status &&
                    void mutate(() => moveTask(task.id, { status: e.target.value as TaskStatus }))
                  }
                  aria-label="Task status"
                  className="absolute inset-0 cursor-pointer opacity-0"
                >
                  <option value={task.status}>{meta.label}</option>
                  {legalMoves.map((s) => (
                    <option key={s} value={s}>
                      {`-> ${STATUS_META[s].label}`}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>

          <Rule />

          <textarea
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={saveTitle}
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), (e.target as HTMLTextAreaElement).blur())}
            rows={2}
            className="w-full resize-none border border-transparent bg-transparent text-center font-pixel text-base uppercase leading-snug text-pixel-black hover:border-pixel-gray/40 focus:border-pixel-black focus:outline-none"
          />

          {error && (
            <p className="my-1 text-center font-pixel text-[10px] uppercase text-pixel-red">
              ! {error}
            </p>
          )}

          <Rule dashed />

          {/* Details */}
          <div className="flex flex-col gap-1.5">
            <Row label="Repo">
              <span className="max-w-[55%] truncate font-pixel text-sm text-pixel-black">
                {repositoryName ?? '-'}
              </span>
            </Row>
            <Row label="Assignee">
              <select
                value={principalValue(task.assigneeAgentId, task.assigneeUserId)}
                onChange={(e) => changePrincipal('assignee', e.target.value)}
                className={VALUE_SELECT}
              >
                <option value="">None</option>
                {me && <option value={`user:${me.id}`}>{me.username} (me)</option>}
                {agents.map((a) => (
                  <option key={a.id} value={`agent:${a.id}`}>
                    {a.name} (agent)
                  </option>
                ))}
              </select>
            </Row>
            <Row label="Reviewer">
              <select
                value={principalValue(task.reviewerAgentId, task.reviewerUserId)}
                onChange={(e) => changePrincipal('reviewer', e.target.value)}
                className={VALUE_SELECT}
              >
                <option value="">None</option>
                {me && <option value={`user:${me.id}`}>{me.username} (me)</option>}
                {agents.map((a) => (
                  <option key={a.id} value={`agent:${a.id}`}>
                    {a.name} (agent)
                  </option>
                ))}
              </select>
            </Row>
          </div>

          <Rule dashed />

          {/* Brief */}
          <p className="mb-1 font-pixel text-[10px] uppercase tracking-[0.2em] text-pixel-gray">
            Brief
          </p>
          <textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            onBlur={saveBrief}
            rows={3}
            placeholder="(none)"
            className="w-full resize-y border border-transparent bg-transparent font-pixel text-sm leading-relaxed text-pixel-black hover:border-pixel-gray/40 focus:border-pixel-black focus:outline-none"
          />

          <Rule dashed />

          {/* Activity */}
          <p className="mb-2 font-pixel text-[10px] uppercase tracking-[0.2em] text-pixel-gray">
            Activity log
          </p>
          <div className="flex flex-col gap-2">
            {comments.map((c) => (
              <div key={c.id} className="font-pixel text-sm">
                <span className="text-pixel-gray">{formatTime(c.createdAt).slice(6)}</span>{' '}
                <span className={c.authorType === 'agent' ? 'text-pixel-orange' : 'text-pixel-black'}>
                  {c.authorType === 'agent' ? agentName(c.authorAgentId).toUpperCase() : 'YOU'}
                </span>
                <p className={`whitespace-pre-wrap break-words pl-4 text-sm ${commentTone(c.body)}`}>
                  {c.body}
                </p>
              </div>
            ))}
            {comments.length === 0 && (
              <p className="font-pixel text-xs text-pixel-gray">(no entries)</p>
            )}
          </div>
          <div className="mt-2 flex items-end gap-1">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={2}
              placeholder="Add entry..."
              className="min-w-0 flex-1 resize-none border border-dashed border-pixel-gray/60 bg-transparent p-1.5 font-pixel text-xs text-pixel-black focus:border-pixel-black focus:outline-none"
            />
            <BracketButton onClick={postComment} disabled={!draft.trim()}>
              POST
            </BracketButton>
          </div>

          <Rule dashed />

          {/* Runs ledger */}
          <div className="mb-2 flex items-end justify-between">
            <p className="font-pixel text-[10px] uppercase tracking-[0.2em] text-pixel-gray">
              Runs
            </p>
            {task.assigneeAgentId && (
              <BracketButton
                onClick={wakeAssignee}
                disabled={runs.some((r) => ACTIVE_RUN_STATUSES.includes(r.status))}
              >
                WAKE
              </BracketButton>
            )}
          </div>
          <div className="flex flex-col gap-1">
            {runs.map((r) => (
              <div key={r.id} className="font-pixel text-sm">
                <button
                  type="button"
                  onClick={() => setOpenRunId(openRunId === r.id ? null : r.id)}
                  className="flex w-full items-end gap-1 text-left"
                >
                  <span className="shrink-0 text-pixel-gray">
                    {formatTime(r.createdAt).slice(6)}
                  </span>
                  <span className="shrink-0 truncate text-pixel-black">
                    {r.agentName.toUpperCase()}
                  </span>
                  <span className="shrink-0 text-[10px] uppercase text-pixel-gray">
                    {r.trigger}
                  </span>
                  <span className="mb-[3px] min-w-2 flex-1 border-b border-dotted border-pixel-gray/50" />
                  <span
                    className={`shrink-0 text-xs font-bold uppercase ${RUN_STATUS_TEXT[r.status]} ${r.status === 'running' ? 'animate-blink-steps' : ''}`}
                  >
                    {r.status}
                  </span>
                </button>
                {openRunId === r.id && (
                  <div className="mt-1 border-l-2 border-pixel-gray/40 pl-2">
                    {r.reason && (
                      <p className="text-[10px] uppercase text-pixel-gray">{r.reason}</p>
                    )}
                    {r.error ? (
                      <p className="whitespace-pre-wrap break-words text-xs text-pixel-red">
                        {r.error}
                      </p>
                    ) : r.output ? (
                      <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-xs text-pixel-black">
                        {r.output}
                      </p>
                    ) : (
                      <p className="text-xs text-pixel-gray">(no output yet)</p>
                    )}
                  </div>
                )}
              </div>
            ))}
            {runs.length === 0 && (
              <p className="font-pixel text-xs text-pixel-gray">(no runs yet)</p>
            )}
          </div>

          <Rule dashed />

          {/* Review verdicts */}
          <div className="mb-2 flex items-end justify-between">
            <p className="font-pixel text-[10px] uppercase tracking-[0.2em] text-pixel-gray">
              Review
            </p>
            {agentRejections > 0 && (
              <span
                className={`font-pixel text-[10px] uppercase ${
                  agentRejections >= REVIEW_CYCLE_CAP ? 'text-pixel-red' : 'text-pixel-gray'
                }`}
              >
                rework {agentRejections}/{REVIEW_CYCLE_CAP}
              </span>
            )}
          </div>
          <div className="flex flex-col gap-1">
            {reviews.map((r) => (
              <div key={r.id} className="flex items-end gap-1 font-pixel text-sm">
                <span className="shrink-0 text-pixel-gray">
                  {formatTime(r.createdAt).slice(6)}
                </span>
                <span
                  className={`shrink-0 truncate ${r.reviewerType === 'agent' ? 'text-pixel-orange' : 'text-pixel-black'}`}
                >
                  {r.reviewerType === 'agent' ? agentName(r.reviewerAgentId).toUpperCase() : 'YOU'}
                </span>
                <span className="mb-[3px] min-w-2 flex-1 border-b border-dotted border-pixel-gray/50" />
                <span
                  className={`shrink-0 text-xs font-bold uppercase ${DECISION_META[r.decision].text}`}
                >
                  {DECISION_META[r.decision].label}
                </span>
              </div>
            ))}
            {reviews.length === 0 && (
              <p className="font-pixel text-xs text-pixel-gray">(no verdicts yet)</p>
            )}
          </div>
          {task.status === 'in_review' && (
            <div className="mt-2">
              {agentRejections >= REVIEW_CYCLE_CAP && (
                <p className="mb-1 font-pixel text-[10px] uppercase text-pixel-red">
                  ! auto-review halted - your verdict required
                </p>
              )}
              <textarea
                value={verdictNote}
                onChange={(e) => setVerdictNote(e.target.value)}
                rows={2}
                placeholder="Verdict notes (required to request changes)..."
                className="w-full resize-none border border-dashed border-pixel-gray/60 bg-transparent p-1.5 font-pixel text-xs text-pixel-black focus:border-pixel-black focus:outline-none"
              />
              <div className="mt-1 flex justify-end gap-3">
                <BracketButton
                  danger
                  onClick={() => stampVerdict('changes_requested')}
                  disabled={!verdictNote.trim()}
                >
                  REQUEST CHANGES
                </BracketButton>
                <BracketButton onClick={() => stampVerdict('approved')}>APPROVE</BracketButton>
              </div>
            </div>
          )}

          <Rule dashed />

          {/* Danger + footer */}
          <div className="flex justify-center gap-4">
            {canCancel && (
              <BracketButton onClick={cancelTask}>CANCEL TASK</BracketButton>
            )}
            <BracketButton danger onClick={() => void removeTask()}>
              DELETE
            </BracketButton>
          </div>

          <Rule />

          <Barcode seed={task.id} />
          <p className="mt-1 text-center font-pixel text-[10px] tracking-[0.25em] text-pixel-gray">
            {orderNo}
          </p>
          <p className="mb-1 mt-2 text-center font-pixel text-[10px] uppercase tracking-[0.2em] text-pixel-gray">
            * * * keep this ticket * * *
          </p>
        </div>
        <TornEdge bottom />
          </div>
        </div>
      </div>
    </div>
  );
}
