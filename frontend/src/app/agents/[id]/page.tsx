'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { RequireAuth } from '@/components/auth/RequireAuth';
import { AgentSprite } from '@/components/agent/AgentSprite';
import { PixelButton } from '@/components/ui/PixelButton';
import {
  fetchAgent,
  fetchDiagnostics,
  RUNTIME_LABELS,
  updateAgentConfig,
  type Agent,
  type Diagnostics,
} from '@/lib/agents';
import { fetchProviders, type ProviderView } from '@/lib/providers';

function MonitorView({
  agent,
  diagnostics,
  busy,
}: {
  agent: Agent;
  diagnostics: Diagnostics | null;
  busy: boolean;
}) {
  const rows: Array<{ label: string; value: string; ok?: boolean }> = [
    { label: 'Runtime', value: RUNTIME_LABELS[agent.runtime] ?? agent.runtime },
    { label: 'State', value: busy ? 'WORKING' : 'IDLE', ok: !busy },
    {
      label: 'CLI',
      value: diagnostics ? (diagnostics.cli.available ? diagnostics.cli.version : diagnostics.cli.error || 'unavailable') : '…',
      ok: diagnostics?.cli.available,
    },
    {
      label: 'Provider',
      value: diagnostics?.provider
        ? `${diagnostics.provider.vendor} · ${diagnostics.provider.modelCount} models${diagnostics.provider.vendorMatch ? '' : ' · VENDOR MISMATCH'}`
        : 'not configured',
      ok: Boolean(diagnostics?.provider?.vendorMatch),
    },
    { label: 'Model', value: agent.model ?? 'default' },
  ];

  return (
    <div className="mx-auto max-w-2xl space-y-3 p-6">
      <h2 className="font-sans text-xl font-bold text-pixel-black">■ Agent monitor</h2>
      {rows.map((row) => (
        <div
          key={row.label}
          className="flex items-center justify-between border border-pixel-line bg-pixel-white px-4 py-3"
          style={{ boxShadow: '3px 3px 0 rgba(17,17,17,0.10)' }}
        >
          <span className="font-sans text-sm text-pixel-black/60">{row.label}</span>
          <span
            className={`font-sans text-sm font-bold ${
              row.ok === undefined ? 'text-pixel-black' : row.ok ? 'text-pixel-green' : 'text-pixel-red'
            }`}
          >
            {row.value}
          </span>
        </div>
      ))}
    </div>
  );
}

function AgentDetailInner() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const agentId = params.id;

  const [agent, setAgent] = useState<Agent | null>(null);
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [savingModel, setSavingModel] = useState(false);

  useEffect(() => {
    fetchAgent(agentId).then(setAgent).catch(() => {});
    fetchProviders().then(setProviders).catch(() => setProviders([]));
    fetchDiagnostics(agentId).then(setDiagnostics).catch(() => {});
  }, [agentId]);

  const agentProvider = useMemo(
    () => providers.find((p) => p.id === agent?.providerId) ?? null,
    [providers, agent?.providerId]
  );

  const changeModel = async (model: string) => {
    if (!agent || savingModel) return;
    setSavingModel(true);
    try {
      const updated = await updateAgentConfig(agent.id, { model: model || null });
      setAgent(updated);
    } finally {
      setSavingModel(false);
    }
  };

  if (!agent) {
    return (
      <div className="flex min-h-[70vh] items-center justify-center bg-pixel-cream">
        <div className="animate-pulse font-sans text-2xl text-pixel-black">Summoning agent…</div>
      </div>
    );
  }

  const providerConfigured = Boolean(agent.providerId);

  const busy = agent.status === 'busy';

  return (
    <div className="flex h-[100dvh] min-h-0 flex-col overflow-hidden bg-pixel-cream md:h-[calc(100vh-10rem)] md:border md:border-pixel-line" style={{ boxShadow: '6px 6px 0 rgba(17,17,17,0.10)' }}>
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="shrink-0 border-b border-pixel-line bg-pixel-cream"
      >
        <div className="relative px-3 py-2 md:px-4 md:py-3">
          <div className="flex items-center justify-between">
            <div className="flex min-w-0 items-center gap-2 md:gap-4">
              <button
                type="button"
                onClick={() => router.push('/agents')}
                className="flex h-9 w-9 shrink-0 items-center justify-center border border-pixel-line bg-pixel-white text-pixel-black"
                style={{ boxShadow: '1px 1px 0px 0px rgba(17,17,17,0.10)' }}
                aria-label="Back to agents"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden="true">
                  <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
                </svg>
              </button>

              <div className="relative">
                <AgentSprite agent={agent} size="sm" />
                <div
                  className={`absolute -bottom-1 -right-1 h-4 w-4 rounded-full border border-pixel-line ${
                    busy ? 'bg-pixel-yellow animate-pulse' : 'bg-pixel-green'
                  }`}
                  title={busy ? 'Working' : 'Idle'}
                />
              </div>

              <div className="min-w-0">
                <h1 className="truncate font-sans text-base leading-none text-pixel-black md:text-xl">{agent.name}</h1>
                <div className="flex items-center gap-2">
                  <span className="hidden font-sans text-xs text-pixel-black/60 sm:inline">
                    {RUNTIME_LABELS[agent.runtime] ?? agent.runtime}
                  </span>
                  <span
                    className={`border border-pixel-line px-2 py-0.5 font-sans text-xs ${
                      busy ? 'bg-pixel-black text-pixel-white' : 'bg-pixel-white text-pixel-black'
                    }`}
                  >
                    {busy ? 'WORKING' : providerConfigured ? 'READY' : 'NO PROVIDER'}
                  </span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 md:gap-4">
              {agentProvider && (
                <select
                  className="hidden border border-pixel-line bg-pixel-white px-2 py-1.5 font-sans text-xs text-pixel-black md:block"
                  style={{ boxShadow: '2px 2px 0 rgba(17,17,17,0.10)' }}
                  value={agent.model ?? ''}
                  disabled={savingModel}
                  onChange={(e) => void changeModel(e.target.value)}
                  title="Switch model"
                >
                  <option value="">default model</option>
                  {agentProvider.models.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
              )}
              <PixelButton variant="secondary" size="sm" onClick={() => router.push(`/agents/${agentId}/settings`)} title="Agent settings">
                Settings
              </PixelButton>
            </div>
          </div>

          {!providerConfigured && (
            <div className="mt-2 border border-pixel-yellow bg-pixel-yellow/15 px-3 py-1.5">
              <p className="font-sans text-xs text-pixel-black">
                No provider configured — API turns will fail.{' '}
                <Link href={`/agents/${agentId}/settings`} className="text-pixel-blue underline">
                  Configure now →
                </Link>
              </p>
            </div>
          )}
        </div>

      </motion.div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-pixel-cream">
        <MonitorView agent={agent} diagnostics={diagnostics} busy={busy} />
      </div>
    </div>
  );
}

export default function AgentDetailPage() {
  return (
    <RequireAuth>
      <AgentDetailInner />
    </RequireAuth>
  );
}
