'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { RequireAuth } from '@/components/auth/RequireAuth';
import { BackButton } from '@/components/ui/BackButton';
import { PixelButton } from '@/components/ui/PixelButton';
import { PixelInput } from '@/components/ui/PixelInput';
import { createAgent, RUNTIME_LABELS, RUNTIMES, type Runtime } from '@/lib/agents';

function NewAgentInner() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [runtime, setRuntime] = useState<Runtime>('claude-code');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setError('Give the agent a name.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const agent = await createAgent({ name: name.trim(), description, runtime });
      router.push(`/agents/${agent.id}/settings`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the agent');
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-xl space-y-6 p-4 md:p-8">
      <BackButton href="/agents" label="Agents" />
      <div>
        <h1 className="font-sans text-[2rem] font-bold leading-none text-pixel-black">New agent</h1>
        <p className="mt-2 font-sans text-sm text-pixel-black/55">
          Pick the runtime it runs on; provider and model are set on the next screen.
        </p>
      </div>

      <form onSubmit={submit} className="space-y-5">
        <label className="block space-y-1">
          <span className="font-sans text-sm text-pixel-black">Name</span>
          <PixelInput value={name} onChange={setName} placeholder="e.g. Backend lead" />
        </label>

        <label className="block space-y-1">
          <span className="font-sans text-sm text-pixel-black">Description</span>
          <PixelInput
            value={description}
            onChange={setDescription}
            multiline
            rows={3}
            placeholder="What this agent is good at"
          />
        </label>

        <fieldset className="space-y-2">
          <legend className="font-sans text-sm text-pixel-black">Runtime</legend>
          <div className="flex flex-wrap gap-2">
            {RUNTIMES.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setRuntime(option)}
                className={`border border-pixel-line px-3 py-1.5 font-sans text-sm ${
                  runtime === option ? 'bg-pixel-black text-pixel-white' : 'bg-pixel-white text-pixel-black'
                }`}
                style={{ boxShadow: '2px 2px 0 rgba(17,17,17,0.10)' }}
              >
                {RUNTIME_LABELS[option]}
              </button>
            ))}
          </div>
        </fieldset>

        {error && <p className="font-sans text-sm text-pixel-red">{error}</p>}

        <PixelButton type="submit" disabled={submitting}>
          {submitting ? 'Creating…' : 'Create agent'}
        </PixelButton>
      </form>
    </div>
  );
}

export default function NewAgentPage() {
  return (
    <RequireAuth>
      <NewAgentInner />
    </RequireAuth>
  );
}
