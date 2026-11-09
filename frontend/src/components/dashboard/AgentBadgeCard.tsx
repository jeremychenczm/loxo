'use client';

import Link from 'next/link';
import { PixelPortrait } from '@/components/agent/PixelPortrait';
import { avatarUrl, type Agent } from '@/lib/agents';

const RUNTIME_ROLES: Record<string, string> = {
  claude: 'Claude CLI Agent',
  codex: 'Codex CLI Agent',
  opencode: 'OpenCode Agent',
  openclaw: 'OpenClaw Agent',
  gemini: 'Gemini CLI Agent',
  hermes: 'Hermes Agent',
  api: 'Hosted API Agent',
};

function roleFor(agent: Agent): string {
  const tag = agent.tags[0];
  if (tag) return tag.charAt(0).toUpperCase() + tag.slice(1);
  return RUNTIME_ROLES[agent.runtime] ?? 'Agent';
}

const STATUS_DOTS: Record<string, { dot: string; label: string }> = {
  idle: { dot: 'bg-pixel-green', label: 'Idle' },
  busy: { dot: 'bg-pixel-yellow animate-pulse', label: 'Busy' },
  error: { dot: 'bg-pixel-red', label: 'Error' },
};

/** ID-badge card: clip, amber name bar, status dot, portrait, role, motto. */
export function AgentBadgeCard({ agent }: { agent: Agent }) {
  const onDuty = Boolean(agent.providerId);
  const status = STATUS_DOTS[agent.status] ?? STATUS_DOTS.idle!;

  return (
    <div className="w-[236px] shrink-0">
      <div className="mx-auto h-3.5 w-9 rounded-t-sm border border-b-0 border-[#111] bg-[#111]" aria-hidden />
      <Link
        href={`/agents/${agent.id}`}
        className="group block rounded border border-[#E4E4E4] bg-white px-4 pb-4 pt-3 no-underline transition-colors hover:border-[#111]"
      >
        <div className="mx-auto mb-3 h-1.5 w-8 rounded-full bg-[#EFEFEF]" aria-hidden />
        <div className="flex items-center justify-between gap-2">
          <span className="inline-block max-w-full truncate rounded-sm bg-pixel-yellow px-3 py-1 text-sm font-semibold leading-tight text-pixel-black">
            {agent.name}
          </span>
          <span
            className={`h-2.5 w-2.5 shrink-0 rounded-full ${status.dot}`}
            title={status.label}
            aria-label={`Status: ${status.label}`}
          />
        </div>
        <div className="flex h-28 items-center justify-center py-2 grayscale contrast-125">
          {avatarUrl(agent) ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={avatarUrl(agent)!}
              alt={agent.name}
              className="h-24 w-24 border border-pixel-line object-cover pixelated"
            />
          ) : (
            <PixelPortrait seed={agent.id} className="h-24 w-24 text-pixel-black" />
          )}
        </div>
        <p className="text-[15px] font-semibold leading-snug text-[#111]">{roleFor(agent)}</p>
        <p className="mt-1 line-clamp-2 min-h-[2.4em] text-[13px] leading-snug text-[#6B6B6B]">
          {agent.description || 'No motto yet — give this agent a description.'}
        </p>
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-[10px] uppercase tracking-[0.18em] text-[#9B9B9B]">Loxo</span>
          <span
            className={`rounded-sm px-2.5 py-1 text-[11px] font-semibold leading-none ${
              onDuty ? 'bg-[#111] text-white' : 'border border-[#C9C9C9] text-[#6B6B6B]'
            }`}
          >
            {onDuty ? (agent.model ?? 'On duty') : 'No provider'}
          </span>
        </div>
      </Link>
    </div>
  );
}

/** Trailing ghost card inviting a new hire. */
export function HireBadgeCard() {
  return (
    <div className="w-[236px] shrink-0 pt-[26px]">
      <Link
        href="/upload"
        className="flex h-[calc(100%-26px)] min-h-[248px] flex-col items-center justify-center gap-2 rounded border border-dashed border-[#C9C9C9] bg-white text-[#6B6B6B] no-underline transition-colors hover:border-[#111] hover:text-[#111]"
      >
        <span className="text-3xl leading-none">+</span>
        <span className="text-sm font-semibold">Hire an agent</span>
        <span className="text-xs">Import a workspace folder or zip</span>
      </Link>
    </div>
  );
}
