'use client';

import type { HumanRequest } from '@/lib/human-requests';
import type { TaskWorkspace } from '@/lib/workspaces';
import { BracketButton, Rule, formatTime } from './task-detail-parts';

const CHOICE_META: Record<string, { label: string; hint: string; danger?: boolean }> = {
  continue: { label: 'CONTINUE', hint: 'run again on the worktree as it is now' },
  discard: { label: 'DISCARD CHANGES', hint: 'restore the worktree to how the run found it, then run again', danger: true },
  stop: { label: 'STOP', hint: 'end the run; the workspace stays locked until you reconcile it' },
  allow: { label: 'ALLOW', hint: 'let the agent go ahead' },
  deny: { label: 'DENY', hint: 'refuse; the agent carries on without it', danger: true },
};

function count(value: unknown, noun: string): string | null {
  return typeof value === 'number' ? `${value} ${noun}${value === 1 ? '' : 's'}` : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

interface ActionRequiredProps {
  requests: HumanRequest[];
  workspace: TaskWorkspace | null;
  agentName: (id: string | null) => string;
  /** A request is being answered; every button waits for it. */
  busy: boolean;
  onAnswer: (request: HumanRequest, choice: string) => void;
  onReconcile: () => void;
}

/**
 * Decisions waiting on a person for this task: retry decisions for runs that
 * lost their owner, permission requests from a running agent, and a workspace
 * left locked after a run was stopped.
 */
export function ActionRequired({ requests, workspace, agentName, busy, onAnswer, onReconcile }: ActionRequiredProps) {
  const retryPending = requests.some((r) => r.kind === 'retry');
  const locked = workspace?.status === 'quarantined' && !retryPending;
  if (requests.length === 0 && !locked) return null;

  return (
    <section aria-label="Action required">
      <Rule dashed />
      <p className="mb-2 font-pixel text-[10px] uppercase tracking-[0.2em] text-pixel-red">! Action required</p>
      <div className="flex flex-col gap-3">
        {requests.map((request) => (
          <div key={request.id} className="border-l-2 border-pixel-red pl-2 font-pixel">
            <RequestSummary request={request} agentName={agentName} />
            <div className="mt-1 flex flex-wrap justify-end gap-2">
              {request.choices.map((choice) => {
                const meta = CHOICE_META[choice] ?? { label: choice.toUpperCase(), hint: '' };
                return (
                  <span key={choice} title={meta.hint}>
                    <BracketButton danger={meta.danger} disabled={busy} onClick={() => onAnswer(request, choice)}>
                      {meta.label}
                    </BracketButton>
                  </span>
                );
              })}
            </div>
            {request.kind === 'retry' && (
              <ul className="mt-1 text-[10px] text-pixel-gray">
                {request.choices.map((choice) => (
                  <li key={choice}>
                    {CHOICE_META[choice]?.label ?? choice}: {CHOICE_META[choice]?.hint}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
        {locked && (
          <div className="border-l-2 border-pixel-red pl-2 font-pixel">
            <p className="text-sm text-pixel-black">WORKSPACE LOCKED</p>
            {workspace?.lastError && (
              <p className="whitespace-pre-wrap break-words text-xs text-pixel-gray">{workspace.lastError}</p>
            )}
            <div className="mt-1 flex justify-end" title="Re-check the worktree and unlock it">
              <BracketButton disabled={busy} onClick={onReconcile}>
                RECONCILE
              </BracketButton>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function RequestSummary({ request, agentName }: { request: HumanRequest; agentName: (id: string | null) => string }) {
  const p = request.payload;
  const deadline = request.expiresAt ? formatTime(request.expiresAt) : null;

  if (request.kind === 'retry') {
    const facts = [count(p.controlPlaneWrites, 'platform write'), count(p.changedFiles, 'changed file')].filter(Boolean);
    return (
      <>
        <p className="text-sm text-pixel-black">RUN INTERRUPTED · {(text(p.agentName) ?? 'agent').toUpperCase()}</p>
        <p className="text-xs text-pixel-gray">
          The backend lost track of this run partway through{facts.length > 0 ? ` (${facts.join(', ')})` : ''}.
          {deadline && (
            <>
              {' '}Stops on its own at <span className="whitespace-nowrap">{deadline}</span> if nobody decides.
            </>
          )}
        </p>
      </>
    );
  }

  if (request.kind === 'permission') {
    const paths = Array.isArray(p.paths) ? p.paths.filter((x): x is string => typeof x === 'string') : [];
    const command = text(p.command);
    return (
      <>
        <p className="text-sm text-pixel-black">
          PERMISSION · {agentName(text(p.agentId)).toUpperCase()}
        </p>
        <p className="break-words text-xs text-pixel-black">{text(p.title) ?? text(p.toolKind) ?? 'Tool call'}</p>
        {command && <p className="break-all bg-pixel-black/5 px-1 text-xs text-pixel-black">$ {command}</p>}
        {paths.map((path) => (
          <p key={path} className="break-all text-[10px] text-pixel-gray">
            {path}
          </p>
        ))}
        {text(p.reason) && <p className="text-[10px] uppercase text-pixel-gray">{text(p.reason)}</p>}
        {deadline && (
          <p className="text-[10px] text-pixel-gray">
            Denied automatically at <span className="whitespace-nowrap">{deadline}</span>.
          </p>
        )}
      </>
    );
  }

  return <p className="text-sm uppercase text-pixel-black">{request.kind.replace('_', ' ')}</p>;
}
