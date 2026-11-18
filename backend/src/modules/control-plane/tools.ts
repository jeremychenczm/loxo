import { createHash } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db, type Executor, type Tx } from '../../db/client';
import {
  agents,
  controlPlaneRequests,
  tasks,
  runs,
  TERMINAL_CONTROL_PLANE_TOOLS,
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
import { moveTaskWithin } from '../tasks/tasks.service';
import { startQueuedRuns } from '../runs/wake';
import { isTransitionAllowed } from '../tasks/task-transitions';
import { addAgentTurn, listTurns } from '../tasks/turns.service';
import { verifyRunToken } from './run-token';
import { crashPoint } from '../ownership/crash-points';
import { recordFenceRejection } from '../ownership/fence';
import { runLeases } from '../ownership/lease';

/**
 * The tool surface a woken agent gets back into the platform. Every call is
 * checked against the run row under the owner epoch the caller holds, so a
 * settled run, or one that has moved to another owner, loses access on its
 * next call.
 */

export interface RunToolContext {
  run: Run;
  /** Owner epoch the caller acts under: the token's epoch, or the in-process lease's. */
  epoch: number;
  agent: Agent;
  task: Task;
}

/**
 * Refuses a control-plane call unless the run is still running under `epoch`
 * with a live lease. Calls under an older epoch, on an expired lease, or for a
 * run this instance already fenced come from a stale owner and count as fence
 * rejections; a run that settled normally is merely inactive. With `lock` it
 * also holds FOR KEY SHARE on the run row until commit: a takeover needs FOR
 * UPDATE on that row, so it waits for the caller's writes and they can never
 * land under an epoch that has already moved on.
 */
async function assertRunActive(ex: Executor, runId: string, epoch: number, lock = false): Promise<Run> {
  const query = ex
    .select({ run: runs, leaseLive: sql<boolean>`${runs.leaseExpiresAt} > clock_timestamp()` })
    .from(runs)
    .where(eq(runs.id, runId));
  const [row] = lock ? await query.for('key share') : await query.limit(1);
  if (!row) throw unauthorized('Run is not active');
  const { run, leaseLive } = row;
  let stale: string | null = null;
  if (run.ownerEpoch !== epoch) stale = 'Run token is from an earlier owner';
  else if (run.status === 'running' && !leaseLive) stale = 'Run lease expired';
  // Covers the gap between this instance fencing itself and the database
  // lease expiring, while the row still names this instance as owner.
  else if (run.status === 'running' && run.ownerInstance === runLeases.instance && runLeases.isLost(runId)) {
    stale = 'Run lost its lease';
  }
  if (stale) {
    recordFenceRejection('control_plane', runId, epoch);
    throw unauthorized(stale);
  }
  if (run.status !== 'running') throw unauthorized('Run is not active');
  return run;
}

export async function resolveRunContext(token: string): Promise<RunToolContext> {
  const claims = verifyRunToken(token);
  if (!claims) throw unauthorized('Invalid run token');

  const run = await assertRunActive(db, claims.runId, claims.epoch);
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

  return { run, epoch: claims.epoch, agent, task };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const TERMINAL_TOOLS: readonly string[] = TERMINAL_CONTROL_PLANE_TOOLS;

/**
 * Runs one control-plane write as a single transaction: fence the run row,
 * serialize with the run's other calls, answer a repeated call from the
 * stored result, apply the writes, and record the request. A terminal tool
 * repeats whenever the run already called it; any other tool repeats only
 * when it is the run's latest call with the same arguments, so a deliberate
 * sequence such as in_progress, blocked, in_progress still takes effect.
 * Wakes the writes ask for are queued in the same transaction and started
 * after commit.
 */
async function controlPlaneWrite<T>(
  ctx: RunToolContext,
  tool: string,
  args: Record<string, unknown>,
  write: (tx: Tx, queued: Run[]) => Promise<T>
): Promise<T> {
  const argsHash = createHash('sha256').update(canonicalJson(args)).digest('hex');
  const queued: Run[] = [];
  const result = await db.transaction(async (tx) => {
    await assertRunActive(tx, ctx.run.id, ctx.epoch, true);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.run.id}, 0))`);

    const [last] = await tx
      .select()
      .from(controlPlaneRequests)
      .where(eq(controlPlaneRequests.runId, ctx.run.id))
      .orderBy(desc(controlPlaneRequests.seq))
      .limit(1);
    const [prior] = TERMINAL_TOOLS.includes(tool)
      ? await tx
          .select()
          .from(controlPlaneRequests)
          .where(and(eq(controlPlaneRequests.runId, ctx.run.id), eq(controlPlaneRequests.tool, tool)))
          .limit(1)
      : last && last.tool === tool && last.argsHash === argsHash
        ? [last]
        : [];
    if (prior) return prior.result as T;

    const value = await write(tx, queued);
    crashPoint('control_plane.before_record');
    await tx.insert(controlPlaneRequests).values({
      runId: ctx.run.id,
      epoch: ctx.epoch,
      seq: (last?.seq ?? 0) + 1,
      tool,
      argsHash,
      result: value ?? null,
    });
    return value;
  });
  await startQueuedRuns(queued);
  return result;
}

/**
 * Tool contexts live for a whole run while the task moves underneath them
 * (often via these very tools); reads always go back to the database.
 */
async function freshTask(ctx: RunToolContext, ex: Executor = db): Promise<Task> {
  const [task] = await ex
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
async function advanceTo(ctx: RunToolContext, target: TaskStatus, tx: Tx, queued: Run[]): Promise<Task> {
  let task = await freshTask(ctx, tx);
  if (task.status === target) return task;
  if (
    !isTransitionAllowed(task.status, target) &&
    isTransitionAllowed(task.status, 'in_progress') &&
    isTransitionAllowed('in_progress', target)
  ) {
    const bridged = await moveTaskWithin(tx, ctx.run.userId, task.id, { status: 'in_progress' });
    queued.push(...bridged.queued);
    task = bridged.task;
  }
  const moved = await moveTaskWithin(tx, ctx.run.userId, task.id, { status: target });
  queued.push(...moved.queued);
  return moved.task;
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
async function postAsAgent(ctx: RunToolContext, content: string, tx: Tx): Promise<void> {
  await addAgentTurn(ctx.run.userId, ctx.task.id, ctx.agent.id, content, { runId: ctx.run.id }, tx);
}

export interface StatusResult {
  status: TaskStatus;
}

export async function commentOnTask(ctx: RunToolContext, body: string): Promise<void> {
  await controlPlaneWrite(ctx, 'comment_on_task', { body }, (tx) => postAsAgent(ctx, body, tx));
}

/** Status writes go through the same transition table as every other path. */
export async function updateTaskStatus(ctx: RunToolContext, status: TaskStatus): Promise<StatusResult> {
  return controlPlaneWrite(ctx, 'update_task_status', { status }, async (tx, queued) => {
    const moved = await moveTaskWithin(tx, ctx.run.userId, ctx.task.id, { status });
    queued.push(...moved.queued);
    return { status: moved.task.status };
  });
}

/** Flags the run's task as blocked with the question on the timeline. */
export async function askBlocker(ctx: RunToolContext, question: string): Promise<StatusResult> {
  return controlPlaneWrite(ctx, 'ask_blocker', { question }, async (tx, queued) => {
    await postAsAgent(ctx, `[BLOCKER] ${question}`, tx);
    return { status: (await advanceTo(ctx, 'blocked', tx, queued)).status };
  });
}

/** Posts the result and hands the task to review. */
export async function submitResult(ctx: RunToolContext, summary: string): Promise<StatusResult> {
  if (!summary.trim()) throw badRequest('invalid_input', 'Result summary is required');
  return controlPlaneWrite(ctx, 'submit_result', { summary }, async (tx, queued) => {
    await postAsAgent(ctx, summary, tx);
    return { status: (await advanceTo(ctx, 'in_review', tx, queued)).status };
  });
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

  return controlPlaneWrite(ctx, 'submit_review', { decision, feedback }, async (tx, queued) => {
    if (decision === 'approved') {
      await recordAgentVerdict(tx, ctx.run.userId, ctx.task.id, verdict);
      return {
        status: 'in_review',
        halted: false,
        note: 'Approval recorded as a recommendation; final sign-off stays with a human.',
      };
    }

    const priorRejections = await countAgentRejections(ctx.task.id, tx);
    const halted = priorRejections >= REVIEW_CYCLE_CAP;
    const recorded = await recordAgentVerdict(tx, ctx.run.userId, ctx.task.id, verdict, { reopen: !halted });
    queued.push(...recorded.queued);
    if (halted) {
      await postAsAgent(
        ctx,
        `[REVIEW HALTED] ${REVIEW_CYCLE_CAP} automated review cycles reached; a human reviewer needs to take over.`,
        tx
      );
      return {
        status: 'in_review',
        halted: true,
        note: 'Automated review cycles exhausted; the task stays in review for a human.',
      };
    }
    const task = await freshTask(ctx, tx);
    return { status: task.status, halted: false, note: 'Changes requested; the lead has been re-woken.' };
  });
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
 * the executor already holds the run context. Each call passes the same
 * epoch check as an MCP call. Review runs get the reviewer set (read,
 * comment, verdict); worker runs get the worker set.
 */
export function buildControlPlaneToolDefs(ctx: RunToolContext): ControlPlaneToolDef[] {
  return toolDefsFor(ctx).map((def) => ({
    ...def,
    execute: async (args) => {
      await assertRunActive(db, ctx.run.id, ctx.epoch);
      return def.execute(args);
    },
  }));
}

function toolDefsFor(ctx: RunToolContext): ControlPlaneToolDef[] {
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
