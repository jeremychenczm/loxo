'use client';

import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  addEdge,
  Background,
  Controls,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { RequireAuth } from '@/components/auth/RequireAuth';
import { nodeTypes, setCanvasContext } from '@/components/canvas/nodes';
import { fetchAgents, type Agent } from '@/lib/agents';
import { dslToFlow, flowToDsl, type CanvasNodeData } from '@/lib/flow-convert';
import { fetchTeam, generateDsl, saveWorkflow, type TeamView } from '@/lib/teams';

let nodeCounter = 0;

function EditorInner() {
  const params = useParams<{ id: string }>();
  const teamId = params.id;

  const [team, setTeam] = useState<TeamView | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<CanvasNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showOrigin, setShowOrigin] = useState(false);
  const loadedRef = useRef(false);

  useEffect(() => {
    fetchAgents().then(setAgents).catch(() => {});
  }, []);

  useEffect(() => {
    if (loadedRef.current) return;
    fetchTeam(teamId)
      .then((t) => {
        loadedRef.current = true;
        setTeam(t);
        const flow = dslToFlow(t.workflow);
        setNodes(flow.nodes);
        setEdges(flow.edges);
      })
      .catch(() => setMessage('Failed to load team'));
  }, [teamId, setNodes, setEdges]);

  // Custom node components read agents + mutators through this context.
  useEffect(() => {
    setCanvasContext({
      agents,
      updateNode: (id, patch) =>
        setNodes((current) =>
          current.map((node) =>
            node.id === id ? { ...node, data: { ...node.data, ...patch } } : node
          )
        ),
      removeNode: (id) => {
        setNodes((current) => current.filter((node) => node.id !== id));
        setEdges((current) => current.filter((edge) => edge.source !== id && edge.target !== id));
      },
    });
  }, [agents, setNodes, setEdges]);

  const onConnect = useCallback(
    (connection: Connection) => {
      const source = nodes.find((n) => n.id === connection.source);
      const target = nodes.find((n) => n.id === connection.target);
      if (!source || !target) return;
      if (source.type === 'end' || target.type === 'start') {
        setMessage('End nodes have no outputs; start nodes have no inputs');
        return;
      }
      if (source.type === 'condition' && connection.sourceHandle !== 'yes' && connection.sourceHandle !== 'no') {
        setMessage('Connect conditions from their yes/no handles');
        return;
      }
      setMessage(null);
      setEdges((current) =>
        addEdge({ ...connection, label: connection.sourceHandle ?? undefined }, current)
      );
    },
    [nodes, setEdges]
  );

  const addNode = (type: 'agent' | 'condition') => {
    nodeCounter += 1;
    const id = `${type}-${Date.now()}-${nodeCounter}`;
    setNodes((current) => [
      ...current,
      {
        id,
        type,
        position: { x: 300 + Math.random() * 120, y: 160 + Math.random() * 120 },
        data:
          type === 'agent'
            ? { label: `Agent ${nodeCounter}`, kind: 'worker' }
            : { label: 'Review gate', expression: '' },
      },
    ]);
  };

  const save = async (draft: boolean) => {
    if (!team) return;
    setSaving(true);
    setMessage(null);
    try {
      const updated = await saveWorkflow(
        teamId,
        flowToDsl({ name: team.name, description: team.description }, nodes, edges),
        draft
      );
      setTeam(updated);
      const flow = dslToFlow(updated.workflow);
      setNodes(flow.nodes);
      setEdges(flow.edges);
      setMessage(draft ? 'Draft saved.' : 'Saved.');
    } catch (err) {
      setMessage(err instanceof Error ? `${err.message} — use "Save draft" to keep work in progress` : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const generate = async () => {
    if (!prompt.trim()) return;
    setGenerating(true);
    setMessage(null);
    try {
      const result = await generateDsl(prompt.trim());
      const flow = dslToFlow(result.workflow);
      setNodes(flow.nodes);
      setEdges(flow.edges);
      setMessage(
        `Generated via ${result.generator}${result.warnings.length ? ` (${result.warnings[0]})` : ''}. Review bindings, then save.`
      );
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Generation failed');
    } finally {
      setGenerating(false);
    }
  };

  if (!team) return <p className="font-sans text-pixel-black/50">{message ?? 'Loading…'}</p>;

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-2 font-sans text-xl font-bold text-pixel-black">{team.name}</h1>
        <span className="border border-pixel-line bg-pixel-yellow px-1.5 py-0.5 font-sans text-xs text-pixel-black">
          {team.workflow.execution.mode}
        </span>
        {team.workflow.metadata?.origin && (
          <button
            type="button"
            onClick={() => setShowOrigin((v) => !v)}
            title="This workflow was confirmed out of a workshop discussion"
            className="border border-pixel-line bg-pixel-blue/15 px-1.5 py-0.5 font-sans text-xs text-pixel-blue hover:bg-pixel-blue/25"
          >
            v{team.workflow.metadata.version ?? 1} · from workshop {showOrigin ? '▴' : '▾'}
          </button>
        )}
        <button
          onClick={() => addNode('agent')}
          className="border border-pixel-line bg-pixel-white px-3 py-1.5 font-sans text-xs text-pixel-black hover:bg-pixel-cream" style={{ boxShadow: '2px 2px 0 rgba(17,17,17,0.10)' }}
        >
          + Agent node
        </button>
        <button
          onClick={() => addNode('condition')}
          className="border border-pixel-line bg-pixel-white px-3 py-1.5 font-sans text-xs text-pixel-black hover:bg-pixel-cream" style={{ boxShadow: '2px 2px 0 rgba(17,17,17,0.10)' }}
        >
          + Condition
        </button>
        <div className="ml-auto flex gap-2">
          <button
            onClick={() => save(true)}
            disabled={saving}
            className="border border-pixel-line bg-pixel-white px-3 py-1.5 font-sans text-xs text-pixel-black hover:bg-pixel-cream disabled:opacity-50" style={{ boxShadow: '2px 2px 0 rgba(17,17,17,0.10)' }}
          >
            Save draft
          </button>
          <button
            onClick={() => save(false)}
            disabled={saving}
            className="border border-pixel-line bg-pixel-yellow px-4 py-1.5 font-sans text-xs font-bold text-pixel-black hover:bg-pixel-orange disabled:opacity-50" style={{ boxShadow: '2px 2px 0 rgba(17,17,17,0.10)' }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      <div className="flex gap-2">
        <input
          className="flex-1 border border-pixel-line bg-pixel-white px-3 py-2 font-sans text-sm text-pixel-black outline-none placeholder:text-pixel-black/40 focus:border-pixel-blue" style={{ boxShadow: 'inset 2px 2px 0 rgba(17,17,17,0.10)' }}
          placeholder='Describe the workflow, e.g. "research the topic, review quality, then write a summary"'
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && generate()}
        />
        <button
          onClick={generate}
          disabled={generating || !prompt.trim()}
          className="border border-pixel-line bg-pixel-blue px-4 py-2 font-sans text-xs font-bold text-pixel-white hover:bg-pixel-orange disabled:opacity-50" style={{ boxShadow: '2px 2px 0 rgba(17,17,17,0.10)' }}
        >
          {generating ? 'Generating…' : 'Generate'}
        </button>
      </div>

      {showOrigin && team.workflow.metadata?.origin && (
        <div className="border border-pixel-line bg-pixel-cream px-3 py-2 font-sans text-xs text-pixel-black">
          <p>
            Confirmed from workshop “{team.workflow.metadata.origin.sessionTitle}” (draft rev{' '}
            {team.workflow.metadata.origin.revision}
            {team.workflow.metadata.origin.feedback
              ? `, after feedback: ${team.workflow.metadata.origin.feedback}`
              : ''}
            ) on {new Date(team.workflow.metadata.origin.confirmedAt).toLocaleString()}.
          </p>
          {team.workflow.metadata.origin.notes.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-pixel-black/60">
              {team.workflow.metadata.origin.notes.slice(0, 6).map((note, i) => (
                <li key={i}>
                  [{note.column}] {note.text} — {note.authorName}
                </li>
              ))}
              {team.workflow.metadata.origin.notes.length > 6 && (
                <li>…and {team.workflow.metadata.origin.notes.length - 6} more notes</li>
              )}
            </ul>
          )}
        </div>
      )}

      {message && <p className="border border-pixel-yellow bg-pixel-yellow/15 px-2 py-1 font-sans text-xs text-pixel-black">{message}</p>}
      {team.warnings.length > 0 && (
        <p className="font-sans text-xs text-pixel-black/55">
          {team.warnings.map((w) => w.message).join(' · ')}
        </p>
      )}

      <div className="min-h-0 flex-1 border border-pixel-line bg-pixel-white" style={{ boxShadow: '5px 5px 0 rgba(17,17,17,0.10)' }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          nodeTypes={nodeTypes}
          fitView
          colorMode="light"
          deleteKeyCode={['Backspace', 'Delete']}
        >
          <Background gap={16} />
          <Controls />
        </ReactFlow>
      </div>

    </div>
  );
}

export default function TeamEditorPage() {
  return (
    <RequireAuth>
      <EditorInner />
    </RequireAuth>
  );
}
