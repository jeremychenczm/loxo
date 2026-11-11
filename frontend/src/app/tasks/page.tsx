'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DragDropContext,
  Draggable,
  Droppable,
  type DropResult,
} from '@hello-pangea/dnd';
import { RequireAuth } from '@/components/auth/RequireAuth';
import { TaskCard } from '@/components/tasks/TaskCard';
import { TaskDetail } from '@/components/tasks/TaskDetail';
import { NewTaskModal } from '@/components/tasks/NewTaskModal';
import { ApiError } from '@/lib/api';
import { fetchAgents, type Agent } from '@/lib/agents';
import {
  CLIENT_TRANSITIONS,
  STATUS_META,
  fetchBoard,
  moveTask,
  type Board,
  type Task,
  type TaskStatus,
} from '@/lib/tasks';
import { fetchProjects, type ProjectView } from '@/lib/projects';

/** Columns rendered on the board; blocked cards ride inside In Progress. */
const BOARD_COLUMNS: TaskStatus[] = ['todo', 'in_progress', 'in_review', 'done'];

const EMPTY_BOARD: Board = {
  backlog: [],
  todo: [],
  in_progress: [],
  in_review: [],
  blocked: [],
  done: [],
  cancelled: [],
};

/** Cards a column displays: In Progress interleaves its blocked tasks. */
function columnCards(board: Board, status: TaskStatus): Task[] {
  if (status !== 'in_progress') return board[status];
  return [...board.in_progress, ...board.blocked].sort((a, b) => a.boardOrder - b.boardOrder);
}

/** Midpoint ordering: land between the new neighbours without renumbering. */
function orderAt(cards: Task[], index: number, draggedId: string): number {
  const rest = cards.filter((c) => c.id !== draggedId);
  const prev = rest[index - 1]?.boardOrder;
  const next = rest[index]?.boardOrder;
  if (prev === undefined && next === undefined) return 1;
  if (prev === undefined) return next! / 2;
  if (next === undefined) return prev + 1;
  return (prev + next) / 2;
}

function BoardPage() {
  const [board, setBoard] = useState<Board>(EMPTY_BOARD);
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [projectFilter, setProjectFilter] = useState<string>('');
  const [dragSource, setDragSource] = useState<TaskStatus | null>(null);
  const [openTask, setOpenTask] = useState<Task | null>(null);
  const [printEntrance, setPrintEntrance] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const { board: next } = await fetchBoard(projectFilter || undefined);
    setBoard(next);
  }, [projectFilter]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      fetchBoard(projectFilter || undefined),
      fetchProjects(),
      fetchAgents().catch(() => [] as Agent[]),
    ])
      .then(([boardRes, projectsRes, agentList]) => {
        if (cancelled) return;
        setBoard(boardRes.board);
        setProjects(projectsRes);
        setAgents(agentList);
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : 'Load failed'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [projectFilter]);

  // Deep link (?task=<id>): open the ticket once the board is in, then
  // strip the param so refreshes and closes don't reopen it.
  useEffect(() => {
    if (loading) return;
    const requested = new URLSearchParams(window.location.search).get('task');
    if (!requested) return;
    const task = Object.values(board)
      .flat()
      .find((candidate) => candidate.id === requested);
    if (task) {
      setPrintEntrance(false);
      setOpenTask(task);
    }
    window.history.replaceState(null, '', window.location.pathname);
  }, [loading, board]);

  const legalTargets = useMemo(() => {
    if (!dragSource) return null;
    return new Set<TaskStatus>([dragSource, ...CLIENT_TRANSITIONS[dragSource]]);
  }, [dragSource]);

  const applyMove = useCallback(
    async (task: Task, status: TaskStatus, boardOrder?: number) => {
      setError('');
      try {
        await moveTask(task.id, { status, ...(boardOrder !== undefined ? { boardOrder } : {}) });
      } catch (err) {
        setError(
          err instanceof ApiError && err.code === 'invalid_transition'
            ? `#${task.number}: ${STATUS_META[task.status].label} -> ${STATUS_META[status].label} is not allowed`
            : err instanceof Error
              ? err.message
              : 'Move failed'
        );
      }
      await refresh();
    },
    [refresh]
  );

  const onDragEnd = useCallback(
    (result: DropResult) => {
      setDragSource(null);
      const { source, destination, draggableId } = result;
      if (!destination) return;
      const from = source.droppableId as TaskStatus;
      const to = destination.droppableId as TaskStatus;
      const cards = columnCards(board, from);
      const dragged = cards.find((c) => c.id === draggableId);
      if (!dragged) return;
      if (from === to && source.index === destination.index) return;

      const targetOrder = orderAt(columnCards(board, to), destination.index, draggableId);
      // Same-column drop for a blocked card means "unblock" (blocked cards
      // live inside In Progress); everything else is a plain move.
      const targetStatus = to === 'in_progress' && dragged.status === 'blocked' ? 'in_progress' : to;
      if (dragged.status === targetStatus && from === to) {
        void applyMove(dragged, dragged.status, targetOrder);
        return;
      }
      void applyMove(dragged, targetStatus, targetOrder);
    },
    [board, applyMove]
  );

  const toggleBlocked = useCallback(
    (task: Task) => {
      void applyMove(task, task.status === 'blocked' ? 'in_progress' : 'blocked');
    },
    [applyMove]
  );

  const renderCard = (task: Task, index: number) => (
    <Draggable
      key={task.id}
      draggableId={task.id}
      index={index}
      isDragDisabled={task.status === 'done' || task.status === 'cancelled'}
    >
      {(dragProvided, dragSnapshot) => (
        <div
          ref={dragProvided.innerRef}
          {...dragProvided.draggableProps}
          {...dragProvided.dragHandleProps}
        >
          <TaskCard
            task={task}
            dragging={dragSnapshot.isDragging}
            onOpen={(i) => {
              setPrintEntrance(false);
              setOpenTask(i);
            }}
            onToggleBlocked={
              task.status === 'in_progress' || task.status === 'blocked'
                ? toggleBlocked
                : undefined
            }
          />
        </div>
      )}
    </Draggable>
  );

  /** Station plate: black tag with the status signal, like a kitchen rail label. */
  const columnHeader = (status: TaskStatus, count: number) => {
    const meta = STATUS_META[status];
    return (
      <div className="mb-2 flex items-center gap-2">
        <span className="flex items-center gap-1.5 bg-pixel-black px-2 py-0.5">
          <span className={`h-2 w-2 ${meta.swatch}`} aria-hidden />
          <span className="font-sans text-[11px] uppercase tracking-[0.15em] text-pixel-white">
            {meta.label}
          </span>
        </span>
        <span className="font-sans text-xs text-pixel-gray">x {count}</span>
      </div>
    );
  };

  const renderColumn = (status: TaskStatus, cards: Task[]) => {
    const dimmed = legalTargets !== null && !legalTargets.has(status);
    return (
      <div
        key={status}
        className={`flex min-h-0 min-w-[240px] flex-1 flex-col transition-opacity duration-150 ${
          dimmed ? 'opacity-35' : ''
        }`}
      >
        {columnHeader(status, cards.length)}
        <Droppable droppableId={status} isDropDisabled={dimmed}>
          {(provided, snapshot) => (
            <div
              ref={provided.innerRef}
              {...provided.droppableProps}
              className={`flex min-h-[120px] flex-1 flex-col gap-2 border p-2 ${
                snapshot.isDraggingOver
                  ? 'border-pixel-black bg-pixel-cream'
                  : 'border-pixel-line bg-pixel-cream/40'
              }`}
            >
              {cards.map(renderCard)}
              {provided.placeholder}
              {cards.length === 0 && (
                <p className="m-auto font-sans text-[10px] uppercase tracking-[0.15em] text-pixel-gray">no tickets</p>
              )}
            </div>
          )}
        </Droppable>
      </div>
    );
  };

  /** Full-width bottom pool; cards flow in a wrapping grid, not one long column. */
  const renderBacklogZone = () => {
    const cards = board.backlog;
    const dimmed = legalTargets !== null && !legalTargets.has('backlog');
    return (
      <div className={`transition-opacity duration-150 ${dimmed ? 'opacity-35' : ''}`}>
        {columnHeader('backlog', cards.length)}
        <Droppable droppableId="backlog" direction="horizontal" isDropDisabled={dimmed}>
          {(provided, snapshot) => (
            <div
              ref={provided.innerRef}
              {...provided.droppableProps}
              className={`grid min-h-[96px] grid-cols-2 content-start gap-2 border p-2 md:grid-cols-3 xl:grid-cols-4 ${
                snapshot.isDraggingOver
                  ? 'border-pixel-black bg-pixel-cream'
                  : 'border-pixel-line bg-pixel-cream/40'
              }`}
            >
              {cards.map(renderCard)}
              {provided.placeholder}
              {cards.length === 0 && (
                <p className="col-span-full m-auto font-sans text-xs text-pixel-gray">
                  NO TICKETS WAITING
                </p>
              )}
            </div>
          )}
        </Droppable>
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col px-4 py-4">
      <div className="mb-5 flex flex-wrap items-center gap-3 border-b border-pixel-line pb-4">
        <h1 className="font-sans text-xl text-pixel-black">Tasks</h1>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="bg-pixel-black px-2 py-1 font-sans text-xs uppercase tracking-wide text-pixel-white hover:bg-pixel-orange hover:text-pixel-black"
        >
          [ NEW TICKET ]
        </button>
        <select
          value={projectFilter}
          onChange={(e) => setProjectFilter(e.target.value)}
          className="border border-pixel-line bg-pixel-white px-2 py-1 font-sans text-xs text-pixel-black focus:border-pixel-black focus:outline-none"
        >
          <option value="">All projects</option>
          {projects
            .filter((p) => p.kind === 'default')
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          {projects
            .filter((p) => p.kind !== 'default')
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </select>
        {error && (
          <span className="border border-pixel-red bg-pixel-white px-2 py-1 font-sans text-xs text-pixel-red">
            {error}
          </span>
        )}
      </div>

      {loading ? (
        <p className="font-sans text-sm text-pixel-gray">Loading board...</p>
      ) : (
        <DragDropContext
          onDragStart={(start) => setDragSource(start.source.droppableId as TaskStatus)}
          onDragEnd={onDragEnd}
        >
          <div className="flex min-h-0 flex-1 flex-col gap-4 pb-4">
            <div className="flex min-h-[52vh] gap-4 overflow-x-auto">
              {BOARD_COLUMNS.map((status) => renderColumn(status, columnCards(board, status)))}
            </div>
            {renderBacklogZone()}
          </div>
        </DragDropContext>
      )}

      {creating && (
        <NewTaskModal
          projects={projects}
          initialProjectId={projectFilter || undefined}
          onClose={() => setCreating(false)}
          onCreated={(task) => {
            setCreating(false);
            setPrintEntrance(true);
            setOpenTask(task);
            void refresh();
          }}
        />
      )}

      {openTask && (
        <TaskDetail
          taskId={openTask.id}
          printEntrance={printEntrance}
          projectName={projects.find((p) => p.id === openTask.projectId)?.name}
          agents={agents}
          onClose={() => {
            setOpenTask(null);
            void refresh();
          }}
          onChanged={() => void refresh()}
        />
      )}
    </div>
  );
}

export default function TasksPage() {
  return (
    <RequireAuth>
      <BoardPage />
    </RequireAuth>
  );
}
