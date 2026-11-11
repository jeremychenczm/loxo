'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { RequireAuth } from '@/components/auth/RequireAuth';
import { AgentSprite } from '@/components/agent/AgentSprite';
import { PixelButton } from '@/components/ui/PixelButton';
import { useAgentChat, type LiveMessage } from '@/hooks/useAgentChat';
import {
  fetchAgent,
  fetchDiagnostics,
  fetchSkills,
  updateAgentConfig,
  uploadSkill,
  type Agent,
  type Diagnostics,
  type SkillSummary,
} from '@/lib/agents';
import {
  createConversation,
  deleteConversation,
  draftTask,
  fetchConversations,
  fetchMessages,
  fileTask,
  renameConversation,
  type ChatMessage,
  type Conversation,
  type TaskDraft,
} from '@/lib/chat';
import { fetchProviders, type ProviderView } from '@/lib/providers';
import { API_BASE } from '@/lib/runtime';
import { useAuthStore } from '@/store/auth';
import { RUNTIME_LABELS } from '@/lib/runtime-detect';

type TabType = 'chat' | 'monitor' | 'skills';

function MessageBubble({ message, agentName }: { message: LiveMessage | ChatMessage; agentName: string }) {
  const isUser = message.role === 'user';
  const isError = message.role === 'system' && message.meta?.error;

  if (message.role === 'system' && !isError) {
    return (
      <div className="flex justify-center">
        <div className="max-w-[85%] border border-pixel-line bg-pixel-yellow/20 px-3 py-1.5 text-center">
          <p className="font-sans text-xs text-pixel-black/70">
            {message.content}
            {message.meta?.taskId && (
              <>
                {' '}
                <Link
                  href={`/tasks?task=${message.meta.taskId}`}
                  className="font-bold text-pixel-blue underline"
                >
                  View task →
                </Link>
              </>
            )}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={isUser ? 'flex justify-end' : 'flex justify-start'}>
      <div className="max-w-[85%] md:max-w-[75%]">
        <p className={`mb-1 font-sans text-xs text-pixel-black/45 ${isUser ? 'text-right' : ''}`}>
          {isUser ? 'You' : isError ? 'System' : agentName}
        </p>
        <div
          className={`border border-pixel-line px-4 py-2 ${
            isUser
              ? 'bg-pixel-blue text-pixel-white'
              : isError
                ? 'bg-pixel-red/10 text-pixel-red'
                : 'bg-pixel-white text-pixel-black'
          }`}
          style={{ boxShadow: '3px 3px 0 rgba(17,17,17,0.10)' }}
        >
          {isUser || isError ? (
            <p className="whitespace-pre-wrap font-sans text-sm">{message.content}</p>
          ) : (
            <div className="prose prose-sm max-w-none font-sans prose-headings:font-sans prose-p:my-1 prose-pre:border prose-pre:border-pixel-line prose-pre:bg-pixel-black prose-pre:text-pixel-white">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

type DraftCard =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'editing' | 'filing'; draft: TaskDraft; title: string; brief: string; error?: string };

function sliceLabel(draft: TaskDraft, messages: Array<LiveMessage | ChatMessage>): string {
  const base = `Drafted from ${draft.window.count} message${draft.window.count === 1 ? '' : 's'}`;
  const from = messages.find((m) => m.id === draft.window.fromMessageId);
  const to = messages.find((m) => m.id === draft.window.toMessageId);
  if (!from || !to) return base;
  const stamp = (iso: string) =>
    new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${base} · ${stamp(from.createdAt)} – ${stamp(to.createdAt)}`;
}

function TaskDraftCard({
  card,
  messages,
  onEdit,
  onCancel,
  onRetry,
  onFile,
}: {
  card: DraftCard;
  messages: Array<LiveMessage | ChatMessage>;
  onEdit: (patch: { title?: string; brief?: string }) => void;
  onCancel: () => void;
  onRetry: () => void;
  onFile: () => void;
}) {
  return (
    <div
      className="border border-pixel-line bg-pixel-white"
      style={{ boxShadow: '4px 4px 0 rgba(17,17,17,0.10)' }}
    >
      <div className="flex items-center justify-between border-b border-pixel-line bg-pixel-black px-3 py-1.5">
        <span className="font-sans text-xs font-bold text-pixel-white">■ TASK DRAFT</span>
        <button
          onClick={onCancel}
          className="font-sans text-xs text-pixel-white/70 hover:text-pixel-white"
          aria-label="Dismiss draft"
        >
          ✕
        </button>
      </div>

      {card.phase === 'loading' && (
        <p className="animate-pulse p-4 font-sans text-sm text-pixel-black/50">
          Reading the current topic…
        </p>
      )}

      {card.phase === 'error' && (
        <div className="space-y-2 p-4">
          <p className="font-sans text-sm text-pixel-red">{card.message}</p>
          <div className="flex gap-2">
            <PixelButton variant="secondary" size="sm" onClick={onRetry}>
              Retry
            </PixelButton>
            <PixelButton variant="secondary" size="sm" onClick={onCancel}>
              Dismiss
            </PixelButton>
          </div>
        </div>
      )}

      {(card.phase === 'editing' || card.phase === 'filing') && (
        <div className="space-y-2 p-3">
          <input
            className="w-full border border-pixel-line bg-pixel-white px-2 py-1.5 font-sans text-sm font-bold text-pixel-black outline-none focus:border-pixel-blue"
            style={{ boxShadow: 'inset 2px 2px 0 rgba(17,17,17,0.08)' }}
            value={card.title}
            disabled={card.phase === 'filing'}
            onChange={(e) => onEdit({ title: e.target.value })}
            placeholder="Task title"
          />
          <textarea
            className="min-h-28 w-full resize-y border border-pixel-line bg-pixel-white px-2 py-1.5 font-sans text-sm text-pixel-black outline-none focus:border-pixel-blue"
            style={{ boxShadow: 'inset 2px 2px 0 rgba(17,17,17,0.08)' }}
            value={card.brief}
            disabled={card.phase === 'filing'}
            onChange={(e) => onEdit({ brief: e.target.value })}
            placeholder="What should the crew build?"
          />
          <p className="font-sans text-xs text-pixel-black/50">{sliceLabel(card.draft, messages)}</p>
          {card.draft.warnings.map((warning) => (
            <p key={warning} className="border border-pixel-yellow bg-pixel-yellow/15 px-2 py-1 font-sans text-xs text-pixel-black/70">
              {warning}
            </p>
          ))}
          {card.error && <p className="font-sans text-xs text-pixel-red">{card.error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <PixelButton variant="secondary" size="sm" onClick={onCancel} disabled={card.phase === 'filing'}>
              Cancel
            </PixelButton>
            <PixelButton
              variant="primary"
              size="sm"
              onClick={onFile}
              disabled={card.phase === 'filing' || !card.title.trim()}
            >
              {card.phase === 'filing' ? 'Filing…' : 'File task'}
            </PixelButton>
          </div>
        </div>
      )}
    </div>
  );
}

function SessionsSidebar({
  conversations,
  activeId,
  onSelect,
  onNew,
  onRename,
  onExport,
  onDelete,
}: {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => Promise<void>;
  onExport: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  const saveRename = async (id: string) => {
    if (renameDraft.trim()) await onRename(id, renameDraft.trim());
    setRenamingId(null);
  };

  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-pixel-line bg-pixel-white md:flex">
      <div className="flex items-center justify-between border-b border-pixel-line bg-pixel-blue p-3">
        <span className="font-sans text-sm font-bold text-pixel-white">SESSIONS</span>
        <button
          onClick={onNew}
          className="border border-pixel-line bg-pixel-white px-2 py-1 font-sans text-xs font-bold text-pixel-black hover:bg-pixel-cream"
          style={{ boxShadow: '2px 2px 0 rgba(17,17,17,0.10)' }}
        >
          + NEW
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {conversations.map((conversation) => (
          <div
            key={conversation.id}
            className={`cursor-pointer border-b border-pixel-black/10 px-3 py-2 ${
              conversation.id === activeId ? 'border-l-2 border-l-pixel-black bg-pixel-yellow/30' : 'hover:bg-pixel-cream'
            }`}
            onClick={() => onSelect(conversation.id)}
          >
            {renamingId === conversation.id ? (
              <input
                autoFocus
                className="w-full border border-pixel-line bg-pixel-white px-1 py-0.5 font-sans text-xs"
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                onBlur={() => void saveRename(conversation.id)}
                onKeyDown={(e) => e.key === 'Enter' && void saveRename(conversation.id)}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <p className="truncate font-sans text-sm font-bold text-pixel-black">{conversation.title}</p>
            )}
            <p className="truncate font-sans text-xs text-pixel-black/50">{conversation.lastMessagePreview}</p>
            <div className="mt-1 flex gap-2 font-sans text-[10px] text-pixel-black/45">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setRenamingId(conversation.id);
                  setRenameDraft(conversation.title);
                }}
                className="hover:text-pixel-blue"
              >
                rename
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onExport(conversation.id);
                }}
                className="hover:text-pixel-blue"
              >
                export
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(conversation.id);
                }}
                className="hover:text-pixel-red"
              >
                delete
              </button>
            </div>
          </div>
        ))}
        {conversations.length === 0 && (
          <p className="p-3 font-sans text-xs text-pixel-black/50">No sessions yet. Send a message to start.</p>
        )}
      </div>
    </aside>
  );
}

function MonitorView({
  agent,
  diagnostics,
  messageCount,
  busy,
}: {
  agent: Agent;
  diagnostics: Diagnostics | null;
  messageCount: number;
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
    { label: 'Messages loaded', value: String(messageCount) },
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

function SkillsView({ agentId }: { agentId: string }) {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(() => {
    fetchSkills(agentId).then(setSkills).catch(() => setSkills([]));
  }, [agentId]);

  useEffect(reload, [reload]);

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setError('');
    try {
      await uploadSkill(agentId, file);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Skill upload failed');
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-3 p-6">
      <div className="flex items-center justify-between">
        <h2 className="font-sans text-xl font-bold text-pixel-black">■ Skills</h2>
        <PixelButton variant="secondary" size="sm" onClick={() => inputRef.current?.click()}>
          + Add skill
        </PixelButton>
        <input ref={inputRef} type="file" accept=".md,.zip" className="hidden" onChange={handleUpload} />
      </div>
      <p className="font-sans text-xs text-pixel-black/55">
        SKILL.md files under the agent workspace; injected as a skill index for chat turns.
      </p>
      {error && <p className="font-sans text-sm text-pixel-red">{error}</p>}
      {skills.map((skill) => (
        <div
          key={skill.id}
          className="border border-pixel-line bg-pixel-white px-4 py-3"
          style={{ boxShadow: '3px 3px 0 rgba(17,17,17,0.10)' }}
        >
          <p className="font-sans text-sm font-bold text-pixel-black">{skill.name}</p>
          <p className="mt-1 font-sans text-xs text-pixel-black/60">{skill.description || 'No description'}</p>
        </div>
      ))}
      {skills.length === 0 && (
        <p className="border border-dashed border-pixel-black/30 p-6 text-center font-sans text-sm text-pixel-black/45">
          No skills yet — upload a SKILL.md or a zip of skill folders.
        </p>
      )}
    </div>
  );
}

function ChatPageInner() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const agentId = params.id;
  const token = useAuthStore((s) => s.token);

  const [agent, setAgent] = useState<Agent | null>(null);
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [draftCard, setDraftCard] = useState<DraftCard | null>(null);
  const [activeTab, setActiveTab] = useState<TabType>('chat');
  const [savingModel, setSavingModel] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const reloadConversations = useCallback(() => {
    fetchConversations(agentId).then(setConversations).catch(() => {});
  }, [agentId]);

  useEffect(() => {
    fetchAgent(agentId).then(setAgent).catch(() => {});
    fetchProviders().then(setProviders).catch(() => setProviders([]));
    fetchDiagnostics(agentId).then(setDiagnostics).catch(() => {});
    reloadConversations();
  }, [agentId, reloadConversations]);

  useEffect(() => {
    setDraftCard(null);
    if (!activeId) {
      setHistory([]);
      return;
    }
    fetchMessages(activeId).then(setHistory).catch(() => setHistory([]));
  }, [activeId]);

  const onConversationCreated = useCallback(
    (id: string) => {
      setActiveId(id);
      reloadConversations();
    },
    [reloadConversations]
  );

  const { connected, busy, liveMessages, error, sendMessage, stopTurn } = useAgentChat({
    agentId,
    conversationId: activeId,
    onConversationCreated,
    onTurnComplete: reloadConversations,
  });

  const allMessages = useMemo(() => {
    const liveIds = new Set(liveMessages.map((m) => m.id));
    return [...history.filter((m) => !liveIds.has(m.id)), ...liveMessages];
  }, [history, liveMessages]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [allMessages.length, draftCard?.phase]);

  const openDraftCard = useCallback(async () => {
    if (!activeId) return;
    setDraftCard({ phase: 'loading' });
    try {
      const taskDraft = await draftTask(activeId);
      setDraftCard({
        phase: 'editing',
        draft: taskDraft,
        title: taskDraft.title,
        brief: taskDraft.brief,
      });
    } catch (err) {
      setDraftCard({
        phase: 'error',
        message: err instanceof Error ? err.message : 'Drafting failed',
      });
    }
  }, [activeId]);

  const fileDraftCard = useCallback(async () => {
    if (!activeId || draftCard?.phase !== 'editing') return;
    const editing = draftCard;
    setDraftCard({ ...editing, phase: 'filing', error: undefined });
    try {
      await fileTask(activeId, {
        title: editing.title.trim(),
        brief: editing.brief,
      });
      // The system-message breadcrumb is the durable record; the card retires.
      setDraftCard(null);
      const refreshed = await fetchMessages(activeId);
      setHistory(refreshed);
      reloadConversations();
    } catch (err) {
      setDraftCard({
        ...editing,
        phase: 'editing',
        error: err instanceof Error ? err.message : 'Filing failed',
      });
    }
  }, [activeId, draftCard, reloadConversations]);

  const agentProvider = useMemo(
    () => providers.find((p) => p.id === agent?.providerId) ?? null,
    [providers, agent?.providerId]
  );

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft.trim() || busy) return;
    sendMessage(draft);
    setDraft('');
  };

  const newConversation = async () => {
    const conversation = await createConversation(agentId);
    reloadConversations();
    setActiveId(conversation.id);
  };

  const removeConversation = async (id: string) => {
    if (!confirm('Delete this session?')) return;
    await deleteConversation(id);
    if (id === activeId) setActiveId(null);
    reloadConversations();
  };

  const exportConversation = async (id: string) => {
    const res = await fetch(`${API_BASE}/api/conversations/${id}/export`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `conversation-${id}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const changeModel = async (model: string) => {
    if (!agent || savingModel) return;
    setSavingModel(true);
    try {
      // Model changes invalidate CLI sessions server-side; the next turn starts fresh.
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
                    busy ? 'bg-pixel-yellow animate-pulse' : connected ? 'bg-pixel-green' : 'bg-pixel-gray'
                  }`}
                  title={busy ? 'Working' : connected ? 'Online' : 'Offline'}
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
                  title="Switch model (starts a fresh CLI session)"
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
              {busy && (
                <PixelButton variant="danger" size="sm" onClick={stopTurn}>
                  Stop
                </PixelButton>
              )}
            </div>
          </div>

          {!providerConfigured && (
            <div className="mt-2 border border-pixel-yellow bg-pixel-yellow/15 px-3 py-1.5">
              <p className="font-sans text-xs text-pixel-black">
                No provider configured — replies will fail.{' '}
                <Link href={`/agents/${agentId}/settings`} className="text-pixel-blue underline">
                  Configure now →
                </Link>
              </p>
            </div>
          )}
        </div>

        <div className="flex border-t border-pixel-line">
          {(
            [
              ['chat', 'Chat'],
              ['monitor', 'Monitor'],
              ['skills', 'Skills'],
            ] as Array<[TabType, string]>
          ).map(([tab, label], index) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex-1 px-4 py-2 font-sans text-sm transition-colors ${index < 2 ? 'border-r border-pixel-line' : ''} ${
                activeTab === tab
                  ? 'bg-pixel-black text-pixel-white'
                  : 'bg-pixel-white text-pixel-black hover:bg-pixel-black/10'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </motion.div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {activeTab === 'chat' && (
          <>
            <SessionsSidebar
              conversations={conversations}
              activeId={activeId}
              onSelect={setActiveId}
              onNew={() => void newConversation()}
              onRename={async (id, title) => {
                await renameConversation(id, title);
                reloadConversations();
              }}
              onExport={(id) => void exportConversation(id)}
              onDelete={(id) => void removeConversation(id)}
            />

            <section className="flex min-w-0 flex-1 flex-col bg-pixel-cream">
              <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-4">
                {allMessages.map((message) => (
                  <MessageBubble key={message.id} message={message} agentName={agent.name} />
                ))}
                {busy && (
                  <p className="animate-pulse font-sans text-xs text-pixel-black/50">
                    {agent.name} is composing a reply…
                  </p>
                )}
                {allMessages.length === 0 && !busy && (
                  <div className="py-16 text-center">
                    <p className="font-sans text-sm text-pixel-black/50">
                      Send a message to start the conversation.
                    </p>
                  </div>
                )}
                {draftCard && (
                  <TaskDraftCard
                    card={draftCard}
                    messages={allMessages}
                    onEdit={(patch) =>
                      setDraftCard((current) =>
                        current && current.phase === 'editing' ? { ...current, ...patch } : current
                      )
                    }
                    onCancel={() => setDraftCard(null)}
                    onRetry={() => void openDraftCard()}
                    onFile={() => void fileDraftCard()}
                  />
                )}
              </div>

              {error && <p className="px-4 pb-1 font-sans text-xs text-pixel-red">{error}</p>}

              {allMessages.some((m) => m.role !== 'system') && !draftCard && (
                <div className="flex justify-end border-t border-pixel-line bg-pixel-cream px-3 py-1">
                  <button
                    onClick={() => void openDraftCard()}
                    disabled={busy}
                    className="font-sans text-xs font-bold text-pixel-black/60 hover:text-pixel-blue disabled:opacity-40"
                    title="Draft a task from the current topic"
                  >
                    ▣ FILE AS TASK
                  </button>
                </div>
              )}

              <form onSubmit={submit} className="flex gap-2 border-t border-pixel-line bg-pixel-white p-3">
                <textarea
                  className="max-h-40 min-h-[2.75rem] flex-1 resize-y border border-pixel-line bg-pixel-white px-3 py-2 font-sans text-sm text-pixel-black outline-none placeholder:text-pixel-black/40 focus:border-pixel-blue"
                  style={{ boxShadow: 'inset 2px 2px 0 rgba(17,17,17,0.10)' }}
                  placeholder={`Message ${agent.name}…`}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      submit(e);
                    }
                  }}
                />
                {busy ? (
                  <PixelButton variant="danger" onClick={stopTurn}>
                    Stop
                  </PixelButton>
                ) : (
                  <PixelButton
                    type="submit"
                    variant="primary"
                    disabled={!connected || !draft.trim()}
                  >
                    Send
                  </PixelButton>
                )}
              </form>
            </section>
          </>
        )}

        {activeTab === 'monitor' && (
          <div className="min-h-0 flex-1 overflow-y-auto bg-pixel-cream">
            <MonitorView agent={agent} diagnostics={diagnostics} messageCount={allMessages.length} busy={busy} />
          </div>
        )}

        {activeTab === 'skills' && (
          <div className="min-h-0 flex-1 overflow-y-auto bg-pixel-cream">
            <SkillsView agentId={agentId} />
          </div>
        )}
      </div>
    </div>
  );
}

export default function AgentChatPage() {
  return (
    <RequireAuth>
      <ChatPageInner />
    </RequireAuth>
  );
}
