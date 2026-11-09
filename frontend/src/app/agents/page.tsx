'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion } from 'framer-motion';
import { RequireAuth } from '@/components/auth/RequireAuth';
import { PixelPortrait } from '@/components/agent/PixelPortrait';
import { BackButton } from '@/components/ui/BackButton';
import { avatarUrl, fetchAgents, type Agent, type Runtime } from '@/lib/agents';

const RUNTIME_LABELS: Record<Runtime, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  hermes: 'Hermes',
  openclaw: 'OpenClaw',
  api: 'Hosted API',
};

/** Badge headline under the portrait: the agent's own role tag, else its runtime. */
function roleLine(agent: Agent): string {
  return agent.tags[0] ?? `${RUNTIME_LABELS[agent.runtime]} agent`;
}

/** Unselected pills sit at staggered depths; deterministic so the crowd holds still. */
const FADE_STEPS = ['opacity-[0.42]', 'opacity-[0.58]', 'opacity-[0.74]', 'opacity-[0.88]'];

function fadeFor(agent: Agent): string {
  let hash = 0;
  for (const ch of agent.id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return FADE_STEPS[hash % FADE_STEPS.length]!;
}

function PortraitFill({ agent }: { agent: Agent }) {
  const avatar = avatarUrl(agent);
  if (avatar) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={avatar} alt={agent.name} className="h-full w-full object-cover pixelated" />;
  }
  return <PixelPortrait seed={agent.id} className="h-full w-full p-1 text-pixel-black" />;
}

function RosterPill({
  agent,
  selected,
  onSelect,
}: {
  agent: Agent;
  selected: boolean;
  onSelect: () => void;
}) {
  const resting = `${fadeFor(agent)} shadow-[0_2px_10px_-4px_rgba(17,17,17,0.18)] hover:opacity-100 hover:shadow-[0_10px_24px_-8px_rgba(17,17,17,0.3)]`;
  const raised = 'opacity-100 scale-[1.03] shadow-[0_12px_28px_-8px_rgba(17,17,17,0.35)]';
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`flex items-center gap-3 rounded-lg bg-white py-2 pl-2 pr-6 text-left transition-all duration-200 ${selected ? raised : resting}`}
    >
      <span className="h-12 w-12 shrink-0 overflow-hidden rounded-md bg-pixel-cream">
        <PortraitFill agent={agent} />
      </span>
      <span className="min-w-0">
        <span className="block truncate font-sans text-base font-semibold text-pixel-black">
          {agent.name}
        </span>
        <span className="block truncate font-sans text-xs text-pixel-black/50">
          {roleLine(agent)}
        </span>
      </span>
    </button>
  );
}

function BadgeCard({ agent }: { agent: Agent }) {
  return (
    <div className="rounded-xl bg-white px-7 pb-7 pt-4 shadow-[0_18px_40px_-12px_rgba(17,17,17,0.25)]">
      {/* Lanyard slot. */}
      <div className="mx-auto mb-4 h-2 w-14 rounded-sm bg-pixel-black/15 shadow-inner" />

      <div className="rounded bg-pixel-black px-3 py-1.5">
        <p className="truncate font-sans text-base font-medium text-pixel-white">{agent.name}</p>
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={agent.id}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.16 }}
        >
          <div className="mt-7 h-32 w-32 overflow-hidden rounded-md bg-pixel-cream shadow-[0_4px_14px_-6px_rgba(17,17,17,0.3)]">
            <PortraitFill agent={agent} />
          </div>

          <h2 className="mt-6 font-sans text-2xl font-bold leading-tight text-pixel-black">
            {roleLine(agent)}
          </h2>
          <p className="mt-2 min-h-[3.75rem] font-sans text-sm leading-relaxed text-pixel-black/60">
            {agent.description || 'No description yet — give this agent a story in Settings.'}
          </p>

          <div className="mt-3 flex items-center justify-between font-sans text-[10px] uppercase tracking-[0.18em] text-pixel-black/40">
            <span>
              {RUNTIME_LABELS[agent.runtime]} · {agent.status}
            </span>
            <Link
              href={`/agents/${agent.id}/settings`}
              className="text-pixel-black/50 underline-offset-2 hover:text-pixel-black hover:underline"
            >
              Settings
            </Link>
          </div>
        </motion.div>
      </AnimatePresence>

      <div className="my-5 border-t border-dashed border-pixel-black/20" />

      <div className="flex items-center justify-between">
        <span className="font-sans text-lg font-bold tracking-[0.18em] text-pixel-black">
          LOXO
        </span>
        <Link
          href={`/agents/${agent.id}`}
          className="rounded-md bg-pixel-black px-5 py-2 font-sans text-sm font-medium text-pixel-white transition-transform hover:scale-[1.04]"
        >
          Open Chat
        </Link>
      </div>
    </div>
  );
}

function AgentsPageInner() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const reload = useCallback(async () => {
    const agentList = await fetchAgents().catch(() => []);
    setAgents(agentList);
    setSelectedId((current) => current ?? agentList[0]?.id ?? null);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const selected = agents.find((a) => a.id === selectedId) ?? agents[0] ?? null;

  if (isLoading) {
    return (
      <div className="mx-auto max-w-6xl px-4 pb-16">
        <BackButton href="/" />
        <div className="flex min-h-[60vh] items-center justify-center">
          <p className="font-sans text-pixel-black/60">Loading…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 pb-24 md:pb-16">
      <BackButton href="/" />

      <div className="mb-8 mt-2 flex items-end justify-between">
        <div>
          <h1 className="font-sans text-[2rem] font-bold leading-none text-pixel-black">
            My Agents
          </h1>
          <p className="mt-2 font-sans text-sm text-pixel-black/55">
            {agents.length} on the roster
          </p>
        </div>
        <Link
          href="/upload"
          className="hidden rounded-md border-2 border-dashed border-pixel-black/30 px-5 py-2 font-sans text-sm text-pixel-black/60 transition-colors hover:border-pixel-black hover:text-pixel-black md:block"
        >
          + New agent
        </Link>
      </div>

      {agents.length === 0 ? (
        <div className="py-24 text-center">
          <p className="mb-6 font-sans text-lg text-pixel-black/60">Nobody on the roster yet.</p>
          <Link
            href="/upload"
            className="rounded-md bg-pixel-black px-6 py-3 font-sans text-sm text-pixel-white"
          >
            Hire your first agent
          </Link>
        </div>
      ) : (
        <div className="flex flex-col gap-10 md:flex-row md:items-start">
          {selected && (
            <div className="mx-auto w-full max-w-[360px] shrink-0 md:sticky md:top-24 md:mx-0 md:w-[340px]">
              <BadgeCard agent={selected} />
            </div>
          )}

          <div className="flex flex-1 flex-wrap content-start items-start justify-center gap-x-4 gap-y-5 md:justify-start md:pt-4">
            {agents.map((agent) => (
              <RosterPill
                key={agent.id}
                agent={agent}
                selected={agent.id === selected?.id}
                onSelect={() => setSelectedId(agent.id)}
              />
            ))}
            <Link
              href="/upload"
              className="flex items-center rounded-md border-2 border-dashed border-pixel-black/25 px-6 py-4 font-sans text-sm text-pixel-black/50 transition-colors hover:border-pixel-black hover:text-pixel-black md:hidden"
            >
              + New agent
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

export default function AgentsPage() {
  return (
    <RequireAuth>
      <AgentsPageInner />
    </RequireAuth>
  );
}
