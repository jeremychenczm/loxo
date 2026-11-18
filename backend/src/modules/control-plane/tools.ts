import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client';
import {
  agents,
  tasks,
  runs,
  type Agent,
  type Task,
  type TaskStatus,
  type ApprovalDecision,
  type Run,
} from '../../db/schema';
import { badRequest, unauthorized } from '../../http/errors';
import {
  countAgentRejections,
  recordAgentVerdict,
  REVIEW_CYCLE_CAP,
} from '../tasks/approvals.service';
import { moveTask } from '../tasks/tasks.service';
import { isTransitionAllowed } from '../tasks/task-transitions';
import { addAgentTurn, listTurns } from '../tasks/turns.service';
import { verifyRunToken } from './run-token';

/**
 * The tool surface a woken agent gets back into the platform. Every call is
 * authenticated by a per-run token; context is resolved fresh per call so a
 * finished or cancelled run loses access immediately.
 */

export interface RunToolContext {
  run: Run;
  agent: Agent;
  task: Task;
}

export async function resolveRunContext(token: string): Promise<RunToolContext> {
  const runId = verifyRunToken(token);
  if (!runId) throw unauthorized('Invalid run token');

  const [run] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  if (!run || run.status !== 'running') throw unauthorized('Run is not active');
  if (!run.agentId || !run.taskId) throw unauthorized('Run has no control-plane scope');

  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, run.agentId), eq(agents.userId, run.userId)))
    .limit(1);
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, run.taskId), eq(tasks.userId, run.userId)))
    .limit(1);
  if (!agent || !task) throw unauthorized('Run scope no longer exists');

  return { run, agent, task };
}

/**
 * Tool contexts live for a whole run while the task moves underneath them
 * (often via these very tools); reads always go back to the database.
 */
async function freshTask(ctx: RunToolContext): Promise<Task> {
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, ctx.task.id), eq(tasks.userId, ctx.run.userId)))
    .limit(1);
  if (!task) throw unauthorized('Task no longer exists');
  return task;
}

/**
 * Moves toward `target`, stepping through in_progress when that is the one
 * legal bridge (an agent finishing straight from todo is normal, not an
 * error). Still-illegal moves reject through the transition table.
 */
async function advanceTo(ctx: RunToolContext, target: TaskStatus): Promise<Task> {
  let task = await freshTask(ctx);
  if (task.status === target) return task;
  if (
    !isTransitionAllowed(task.status, target) &&
    isTransitionAllowed(task.status, 'in_progress') &&
    isTransitionAllowed('in_progress', target)
  ) {
    task = await moveTask(ctx.run.userId, task.id, { status: 'in_progress' });
  }
  return moveTask(ctx.run.userId, task.id, { status: target });
}

export interface TaskSnapshot {
  taskNumber: number;
  title: string;
  brief: string;
  status: TaskStatus;
  timeline: Array<{ seq: number; kind: string; content: string; createdAt: string }>;
}

export async function getTaskSnapshot(ctx: RunToolContext): Promise<TaskSnapshot> {
  const task = await freshTask(ctx);
  const timeline = await listTurns(ctx.run.userId, task.id);
  return {
    taskNumber: task.number,
    title: task.title,
    brief: task.brief,
    status: task.status,
    timeline: timeline.map((t) => ({
      seq: t.seq,
      kind: t.kind,
      content: t.content,
      createdAt: t.createdAt.toISOString(),
    })),
  };
}

/** Every timeline entry an agent makes is tied to the run that produced it. */
async function postAsAgent(ctx: RunToolContext, content: string): Promise<void> {
  await addAgentTurn(ctx.run.userId, ctx.task.id, ctx.agent.id, content, { runId: ctx.run.id });
}

export async function commentOnTask(ctx: RunToolContext, body: string): Promise<void> {
  await postAsAgent(ctx, body);
}

/** Status writes go through the same transition table as every other path. */
export async function updateTaskStatus(ctx: RunToolContext, status: TaskStatus): Promise<Task> {
  return moveTask(ctx.run.userId, ctx.task.id, { status });
}

/** Flags the run's task as blocked with the question on the timeline. */
export async function askBlocker(ctx: RunToolContext, question: string): Promise<Task> {
  await postAsAgent(ctx, `[BLOCKER] ${question}`);
  return advanceTo(ctx, 'blocked');
}

/** Posts the result and hands the task to review. */
export async function submitResult(ctx: RunToolContext, summary: string): Promise<Task> {
  if (!summary.trim()) throw badRequest('invalid_input', 'Result summary is required');
  await postAsAgent(ctx, summary);
  return advanceTo(ctx, 'in_review');
}

export interface ReviewVerdictOutcome {
  status: TaskStatus;
  halted: boolean;
  note: string;
}

/**
 * Reviewer verdict from a review run. Asymmetric authority: an agent
 * rejection reopens work (until the automated-cycle fuse blows), but an
 * agent approval only records a recommendation — closing stays human.
 */
export async function submitReviewVerdict(
  ctx: RunToolContext,
  decision: ApprovalDecision,
  feedback: string
): Promise<ReviewVerdictOutcome> {
  if (ctx.run.trigger !== 'review') {
    throw badRequest('not_a_review_run', 'Only review runs can submit review verdicts');
  }
  const verdict = { agentId: ctx.agent.id, runId: ctx.run.id, decision, body: feedback };

  if (decision === 'approved') {
    await recordAgentVerdict(ctx.run.userId, ctx.task.id, verdict);
    return {
      status: 'in_review',
      halted: false,
      note: 'Approval recorded as a recommendation; final sign-off stays with a human.',
    };
  }

  const priorRejections = await countAgentRejections(ctx.task.id);
  const halted = priorRejections >= REVIEW_CYCLE_CAP;
  await recordAgentVerdict(ctx.run.userId, ctx.task.id, verdict, { reopen: !halted });
  if (halted) {
    await postAsAgent(
      ctx,
      `[REVIEW HALTED] ${REVIEW_CYCLE_CAP} automated review cycles reached; a human reviewer needs to take over.`
    );
    return {
      status: 'in_review',
      halted: true,
      note: 'Automated review cycles exhausted; the task stays in review for a human.',
    };
  }
  const task = await freshTask(ctx);
  return { status: task.status, halted: false, note: 'Changes requested; the lead has been re-woken.' };
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw badRequest('invalid_input', `"${key}" must be a non-empty string`);
  }
  return value;
}

const STATUS_VALUES: TaskStatus[] = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'blocked',
  'done',
  'cancelled',
];

export interface ControlPlaneToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

/**
 * In-process flavor of the control-plane tools for the api lane; same
 * implementations the MCP endpoint wraps, minus the token round-trip since
 * the executor already holds the run context. Review runs get the reviewer
 * set (read, comment, verdict); worker runs get the worker set.
 */
export function buildControlPlaneToolDefs(ctx: RunToolContext): ControlPlaneToolDef[] {
  const shared: ControlPlaneToolDef[] = [
    {
      name: 'get_task',
      description:
        'Read the task this run was woken for: title, brief, status, and timeline.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => JSON.stringify(await getTaskSnapshot(ctx)),
    },
    {
      name: 'comment_on_task',
      description: 'Post a progress note to the task timeline as yourself.',
      parameters: {
        type: 'object',
        properties: { body: { type: 'string' } },
        required: ['body'],
      },
      execute: async (args) => {
        await commentOnTask(ctx, requireString(args, 'body'));
        return 'Comment posted';
      },
    },
  ];

  if (ctx.run.trigger === 'review') {
    return [
      ...shared,
      {
        name: 'submit_review',
        description:
          'Deliver your review verdict. approved records a recommendation (a human closes the task); changes_requested reopens work with your feedback.',
        parameters: {
          type: 'object',
          properties: {
            decision: { type: 'string', enum: ['approved', 'changes_requested'] },
            feedback: { type: 'string' },
          },
          required: ['decision', 'feedback'],
        },
        execute: async (args) => {
          const decision = requireString(args, 'decision') as ApprovalDecision;
          if (decision !== 'approved' && decision !== 'changes_requested') {
            throw badRequest('invalid_input', `Unknown decision "${decision}"`);
          }
          const outcome = await submitReviewVerdict(ctx, decision, requireString(args, 'feedback'));
          return JSON.stringify(outcome);
        },
      },
    ];
  }

  return [
    ...shared,
    {
      name: 'update_task_status',
      description:
        'Move the task to a new status. Transitions follow the board rules; illegal moves are rejected.',
      parameters: {
        type: 'object',
        properties: { status: { type: 'string', enum: STATUS_VALUES } },
        required: ['status'],
      },
      execute: async (args) => {
        const status = requireString(args, 'status') as TaskStatus;
        if (!STATUS_VALUES.includes(status)) {
          throw badRequest('invalid_input', `Unknown status "${status}"`);
        }
        const task = await updateTaskStatus(ctx, status);
        return JSON.stringify({ status: task.status });
      },
    },
    {
      name: 'ask_blocker',
      description:
        'You are stuck and need a human decision. Posts the question to the timeline and marks the task blocked.',
      parameters: {
        type: 'object',
        properties: { question: { type: 'string' } },
        required: ['question'],
      },
      execute: async (args) => {
        const task = await askBlocker(ctx, requireString(args, 'question'));
        return JSON.stringify({ status: task.status });
      },
    },
    {
      name: 'submit_result',
      description:
        'You finished the work. Posts your result summary to the timeline and hands the task to review.',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
      },
      execute: async (args) => {
        const task = await submitResult(ctx, requireString(args, 'summary'));
        return JSON.stringify({ status: task.status });
      },
    },
  ];
}
