'use client';

import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RequireAuth } from '@/components/auth/RequireAuth';
import {
  avatarUrl,
  fetchAgent,
  fetchDiagnostics,
  fetchSkills,
  updateAgent,
  updateAgentConfig,
  uploadAvatar,
  uploadSkill,
  type Agent,
  type Diagnostics,
  type SkillSummary,
} from '@/lib/agents';
import { fetchMachines, type MachineView } from '@/lib/machines';
import { fetchProviders, type ProviderView } from '@/lib/providers';

const VENDORS_FOR_RUNTIME: Record<string, string[]> = {
  'claude-code': ['anthropic'],
  codex: ['openai'],
  opencode: ['openai'],
  hermes: ['hermes'],
  openclaw: ['openclaw'],
  api: ['anthropic', 'openai'],
};

const inputClass =
  'w-full border border-pixel-line bg-pixel-white px-3 py-2 font-sans text-sm text-pixel-black outline-none focus:border-pixel-blue';
const sectionClass = 'space-y-3 border border-pixel-line bg-pixel-white p-4';
const sectionStyle = { boxShadow: '5px 5px 0 rgba(17,17,17,0.10)' } as const;
const chipButtonClass =
  'cursor-pointer border border-pixel-line bg-pixel-white px-3 py-1.5 font-sans text-xs text-pixel-black hover:bg-pixel-cream';

function SettingsInner() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const agentId = params.id;

  const [agent, setAgent] = useState<Agent | null>(null);
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [machines, setMachines] = useState<MachineView[]>([]);
  const [workdir, setWorkdir] = useState('');
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const reload = useCallback(() => {
    fetchAgent(agentId)
      .then((a) => {
        setAgent(a);
        setName(a.name);
        setDescription(a.description);
        setWorkdir(a.machineWorkdir ?? '');
      })
      .catch(() => router.replace('/agents'));
    fetchSkills(agentId).then(setSkills).catch(() => {});
  }, [agentId, router]);

  useEffect(reload, [reload]);
  useEffect(() => {
    fetchProviders().then(setProviders).catch(() => {});
    fetchMachines().then(setMachines).catch(() => {});
  }, []);

  const eligibleProviders = useMemo(() => {
    if (!agent) return [];
    const vendors = VENDORS_FOR_RUNTIME[agent.runtime] ?? [];
    return providers.filter((p) => vendors.includes(p.vendor));
  }, [agent, providers]);

  const selectedProvider = useMemo(
    () => providers.find((p) => p.id === agent?.providerId) ?? null,
    [providers, agent]
  );

  if (!agent) return <p className="font-sans text-pixel-black/50">Loading…</p>;

  const saveProfile = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      setAgent(await updateAgent(agentId, { name, description }));
      setMessage('Saved.');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const changeProvider = async (providerId: string) => {
    setMessage(null);
    try {
      setAgent(await updateAgentConfig(agentId, { providerId: providerId || null, model: null }));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Update failed');
    }
  };

  const changeModel = async (model: string) => {
    setMessage(null);
    try {
      setAgent(await updateAgentConfig(agentId, { model: model || null }));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Update failed');
    }
  };

  const changeExecution = async (input: {
    execution?: 'server' | 'machine';
    machineId?: string | null;
    machineWorkdir?: string | null;
  }) => {
    setMessage(null);
    try {
      setAgent(await updateAgentConfig(agentId, input));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Update failed');
    }
  };

  const onAvatar = async (file: File | undefined) => {
    if (!file) return;
    await uploadAvatar(agentId, file);
    reload();
  };

  const onSkill = async (file: File | undefined) => {
    if (!file) return;
    setSkills(await uploadSkill(agentId, file).then((r) => r.skills));
  };

  const runDiagnostics = async () => {
    setDiagnostics(await fetchDiagnostics(agentId));
  };

  const avatar = avatarUrl(agent);

  return (
    <div className="mx-auto max-w-2xl space-y-8 pb-16">
      <div className="flex items-center gap-4">
        {avatar ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={avatar} alt="" className="h-14 w-14 border border-pixel-line object-cover pixelated" />
        ) : (
          <div className="flex h-14 w-14 items-center justify-center border border-pixel-line bg-pixel-blue font-sans text-pixel-white">
            {agent.name.slice(0, 2).toUpperCase()}
          </div>
        )}
        <div>
          <h1 className="font-sans text-2xl font-bold text-pixel-black">{agent.name}</h1>
          <span className="border border-pixel-line bg-pixel-yellow px-1.5 py-0.5 font-sans text-xs text-pixel-black">
            {agent.runtime}
          </span>
        </div>
        <label className={`ml-auto ${chipButtonClass}`} style={{ boxShadow: '2px 2px 0 rgba(17,17,17,0.10)' }}>
          Change avatar
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => onAvatar(e.target.files?.[0])}
          />
        </label>
      </div>

      {message && <p className="border border-pixel-yellow bg-pixel-yellow/15 p-2 font-sans text-sm text-pixel-black">{message}</p>}

      <form onSubmit={saveProfile} className={sectionClass} style={sectionStyle}>
        <h2 className="font-sans text-lg font-bold text-pixel-black">■ Profile</h2>
        <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required />
        <textarea
          className={inputClass}
          rows={3}
          placeholder="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <button
          disabled={saving}
          className="border border-pixel-line bg-pixel-yellow px-4 py-2 font-sans text-sm text-pixel-black hover:bg-pixel-orange disabled:opacity-60" style={{ boxShadow: '3px 3px 0 rgba(17,17,17,0.10)' }}
        >
          Save
        </button>
      </form>

      <section className={sectionClass} style={sectionStyle}>
        <h2 className="font-sans text-lg font-bold text-pixel-black">■ Model provider</h2>
        <select
          className={inputClass}
          value={agent.providerId ?? ''}
          onChange={(e) => changeProvider(e.target.value)}
        >
          <option value="">No provider (use environment credentials)</option>
          {eligibleProviders.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.vendor})
            </option>
          ))}
        </select>
        {selectedProvider && selectedProvider.models.length > 0 && (
          <select
            className={inputClass}
            value={agent.model ?? ''}
            onChange={(e) => changeModel(e.target.value)}
          >
            <option value="">Default model</option>
            {selectedProvider.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        )}
        {eligibleProviders.length === 0 && (
          <p className="font-sans text-xs text-pixel-black/55">
            No provider matches this runtime. Add one under Settings → Providers.
          </p>
        )}
      </section>

      {agent.runtime !== 'api' && (
        <section className={sectionClass} style={sectionStyle}>
          <h2 className="font-sans text-lg font-bold text-pixel-black">■ Execution</h2>
          <div className="flex gap-2">
            {(['server', 'machine'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() =>
                  mode === agent.execution
                    ? undefined
                    : changeExecution(
                        mode === 'server'
                          ? { execution: 'server' }
                          : {
                              execution: 'machine',
                              machineId: machines.find((m) => m.online)?.id ?? machines[0]?.id ?? null,
                            }
                      )
                }
                className={`${chipButtonClass} ${agent.execution === mode ? '!bg-pixel-yellow' : ''}`}
                style={{ boxShadow: '2px 2px 0 rgba(17,17,17,0.10)' }}
              >
                {mode === 'server' ? 'On this server' : 'On a paired machine'}
              </button>
            ))}
          </div>
          {agent.execution === 'machine' && (
            <>
              <select
                className={inputClass}
                value={agent.machineId ?? ''}
                onChange={(e) => changeExecution({ execution: 'machine', machineId: e.target.value || null })}
              >
                {machines.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                    {m.online ? '' : ' (offline)'}
                  </option>
                ))}
              </select>
              <input
                className={inputClass}
                placeholder="Working directory on the machine (optional)"
                value={workdir}
                onChange={(e) => setWorkdir(e.target.value)}
                onBlur={() =>
                  workdir !== (agent.machineWorkdir ?? '') &&
                  changeExecution({ execution: 'machine', machineWorkdir: workdir.trim() || null })
                }
              />
            </>
          )}
          {agent.execution === 'machine' && machines.length === 0 && (
            <p className="font-sans text-xs text-pixel-black/55">
              No machines paired. Add one under Settings → Machines.
            </p>
          )}
        </section>
      )}

      <section className={sectionClass} style={sectionStyle}>
        <div className="flex items-center justify-between">
          <h2 className="font-sans text-lg font-bold text-pixel-black">■ Skills</h2>
          <label className={chipButtonClass} style={{ boxShadow: '2px 2px 0 rgba(17,17,17,0.10)' }}>
            Upload skill (.md / .zip)
            <input
              type="file"
              accept=".md,.zip"
              className="hidden"
              onChange={(e) => onSkill(e.target.files?.[0])}
            />
          </label>
        </div>
        {skills.length === 0 ? (
          <p className="font-sans text-xs text-pixel-black/55">No skills installed.</p>
        ) : (
          <ul className="space-y-2">
            {skills.map((skill) => (
              <li key={skill.id} className="border border-pixel-line px-3 py-2" style={{ boxShadow: '2px 2px 0 rgba(17,17,17,0.10)' }}>
                <span className="font-sans text-sm font-bold text-pixel-black">{skill.name}</span>
                <p className="font-sans text-xs text-pixel-black/60">{skill.description}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={sectionClass} style={sectionStyle}>
        <div className="flex items-center justify-between">
          <h2 className="font-sans text-lg font-bold text-pixel-black">■ Diagnostics</h2>
          <button
            onClick={runDiagnostics}
            className={chipButtonClass} style={{ boxShadow: '2px 2px 0 rgba(17,17,17,0.10)' }}
          >
            Run check
          </button>
        </div>
        {diagnostics && (
          <div className="space-y-1 font-sans text-sm text-pixel-black">
            <p>
              CLI:{' '}
              {diagnostics.cli.available ? (
                <span className="text-pixel-green">{diagnostics.cli.version}</span>
              ) : (
                <span className="text-pixel-red">{diagnostics.cli.error}</span>
              )}
            </p>
            <p>
              Provider:{' '}
              {diagnostics.provider ? (
                <span className={diagnostics.provider.vendorMatch ? 'text-pixel-green' : 'text-pixel-red'}>
                  {diagnostics.provider.vendor}
                  {diagnostics.provider.vendorMatch ? '' : ' (vendor mismatch)'}
                </span>
              ) : (
                <span className="text-pixel-black/50">not configured</span>
              )}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

export default function AgentSettingsPage() {
  return (
    <RequireAuth>
      <SettingsInner />
    </RequireAuth>
  );
}
