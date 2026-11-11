import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client';
import { agents, taskMembers, turns, type Agent, type Task, type Turn, type Workspace } from '../../db/schema';
import { badRequest } from '../../http/errors';
import { repoReadTools } from '../hosts/repo-read-tools';
import { openHumanRequest } from '../human-requests/human-requests.service';

/** Everything a tool call may act on; resolved fresh from the database per call. */
export interface TaskToolContext {
  turn: Turn;
  task: Task;
  agent: Agent;
  workspace: Workspace | null;
}

export interface TaskTool {
  description: string;
  /** zod raw shape, registered as the MCP input schema. */
  input: z.ZodRawShape;
  run: (ctx: TaskToolContext, args: Record<string, unknown>) => Promise<unknown>;
}

const TIMELINE_ENTRIES = 20;
const TIMELINE_ENTRY_CHARS = 2000;
const QUESTION_TTL_MS = 24 * 60 * 60_000;

async function getTask(ctx: TaskToolContext): Promise<unknown> {
  const members = await db
    .select({ agentId: taskMembers.agentId, name: agents.name, position: taskMembers.position })
    .from(taskMembers)
    .innerJoin(agents, eq(agents.id, taskMembers.agentId))
    .where(sql`${taskMembers.taskId} = ${ctx.task.id} AND ${taskMembers.state} = 'active'`)
    .orderBy(asc(taskMembers.position));
  // Finished contributions with something in them; running turns, this one included, say nothing yet.
  const recent = await db
    .select()
    .from(turns)
    .where(
      and(
        eq(turns.taskId, ctx.task.id),
        eq(turns.status, 'completed'),
        sql`(${turns.content} <> '' OR ${turns.report} IS NOT NULL)`
      )
    )
    .orderBy(desc(turns.seq))
    .limit(TIMELINE_ENTRIES);
  const authorIds = [...new Set(recent.map((t) => t.agentId).filter((id): id is string => Boolean(id)))];
  const names = new Map(
    authorIds.length
      ? (await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, authorIds))).map(
          (a) => [a.id, a.name] as const
        )
      : []
  );
  // The frozen snapshot is the task as members must see it; before Brief, the live row stands in.
  const snapshot = ctx.task.snapshot;
  return {
    number: ctx.task.number,
    title: snapshot?.title ?? ctx.task.title,
    brief: snapshot?.brief ?? ctx.task.brief,
    playbook: ctx.task.playbook,
    phase: ctx.turn.phase,
    you: ctx.agent.name,
    lead: members.find((m) => m.agentId === ctx.task.leadAgentId)?.name ?? null,
    members: members.map((m) => m.name),
    hasWorkspace: ctx.workspace !== null,
    timeline: recent.reverse().map((t) => ({
      seq: t.seq,
      kind: t.kind,
      author: t.kind === 'agent' ? (names.get(t.agentId ?? '') ?? 'agent') : t.kind,
      content: t.content.slice(0, TIMELINE_ENTRY_CHARS),
    })),
  };
}

async function reportProgress(ctx: TaskToolContext, args: Record<string, unknown>): Promise<unknown> {
  const entry = { at: new Date().toISOString(), summary: String(args.summary) };
  await db
    .update(turns)
    .set({
      report: sql`jsonb_set(coalesce(${turns.report}, '{}'::jsonb), '{progress}', coalesce(${turns.report}->'progress', '[]'::jsonb) || ${JSON.stringify([entry])}::jsonb)`,
    })
    .where(eq(turns.id, ctx.turn.id));
  return 'Progress noted';
}

async function requestHuman(ctx: TaskToolContext, args: Record<string, unknown>): Promise<unknown> {
  const request = await openHumanRequest({
    taskId: ctx.task.id,
    kind: 'input',
    payload: { question: String(args.question), agentId: ctx.agent.id, turnId: ctx.turn.id },
    choices: Array.isArray(args.choices) ? args.choices.map(String) : [],
    ttlMs: QUESTION_TTL_MS,
  });
  return `Your question is waiting for a person (request ${request.id}). Continue with what you can; the answer arrives in a later turn.`;
}

function repoTool(name: 'read_file' | 'list_files' | 'get_diff' | 'get_checks') {
  return async (ctx: TaskToolContext, args: Record<string, unknown>) => {
    if (!ctx.workspace) throw badRequest('no_workspace', 'This turn has no worktree to read');
    const tool = repoReadTools({
      root: ctx.workspace.worktreePath,
      baseCommit: ctx.workspace.baseCommit,
      workspaceId: ctx.workspace.id,
      taskId: ctx.task.id,
    }).find((t) => t.name === name)!;
    return tool.execute(args);
  };
}

export const TASK_TOOLS = {
  get_task: {
    description: 'Read the task as frozen for this work: brief, phase, members, and the recent timeline.',
    input: {},
    run: getTask,
  },
  report_progress: {
    description: 'Record a short progress note on your current turn. It does not end the turn.',
    input: { summary: z.string().trim().min(1).max(2000) },
    run: reportProgress,
  },
  request_human: {
    description:
      'Ask a person something only they can decide. It does not block: keep working, and the answer arrives in a later turn.',
    input: {
      question: z.string().trim().min(1).max(4000),
      choices: z.array(z.string().trim().min(1).max(200)).max(6).optional(),
    },
    run: requestHuman,
  },
  read_file: {
    description: 'Read a text file in your worktree, optionally a line range.',
    input: {
      path: z.string().min(1),
      startLine: z.number().int().min(1).optional(),
      endLine: z.number().int().min(1).optional(),
    },
    run: repoTool('read_file'),
  },
  list_files: {
    description: 'List files in your worktree, honoring .gitignore.',
    input: { path: z.string().optional() },
    run: repoTool('list_files'),
  },
  get_diff: {
    description: 'Show every change in your worktree against the task base, as the platform sees it.',
    input: {},
    run: repoTool('get_diff'),
  },
  get_checks: {
    description: 'Show the latest platform-run check results for this work.',
    input: {},
    run: repoTool('get_checks'),
  },
} satisfies Record<string, TaskTool>;

export type TaskToolName = keyof typeof TASK_TOOLS;

const GENERAL_TOOLS: readonly TaskToolName[] = [
  'get_task',
  'report_progress',
  'request_human',
  'read_file',
  'list_files',
  'get_diff',
  'get_checks',
];

/**
 * Tools offered per phase. Phases without an entry get the general set;
 * phase-specific reporting tools join their phases as playbooks define them.
 */
export const PHASE_TOOLS: Readonly<Record<string, readonly TaskToolName[]>> = {
  brief: ['get_task'],
  deliver: ['get_task'],
};

export function toolsForPhase(phase: string | null): readonly TaskToolName[] {
  return (phase && PHASE_TOOLS[phase]) || GENERAL_TOOLS;
}
