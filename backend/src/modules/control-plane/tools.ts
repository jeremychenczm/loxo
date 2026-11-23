import { createHash } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db, type Executor, type Tx } from '../../db/client';
import { canonicalJson } from '../../lib/canonical-json';
import {
  agents,
  controlPlaneRequests,
  dispatchReports,
  tasks,
  runs,
  TERMINAL_CONTROL_PLANE_TOOLS,
  type Agent,
  type Task,
  type TaskStatus,
  type ApprovalDecision,
  type Dispatch,
  type Run,
  type WorkshopPhase,
} from '../../db/schema';
import { config } from '../../config';
import { badRequest, conflict, unauthorized } from '../../http/errors';
import { openHumanRequest } from '../human-requests/human-requests.service';
import {
  countAgentRejections,
  recordAgentVerdict,
  REVIEW_CYCLE_CAP,
} from '../tasks/approvals.service';
import { isWorkshop, moveTaskWithin } from '../tasks/tasks.service';
import { dispatchOf } from '../workshop/dispatch-info';
import { agentPhase } from '../workshop/phases';
import { MAX_EXPLORATION_QUESTIONS, MAX_PACKAGES, parseReport } from '../workshop/reports';
import { activeMembers, workshopRunView } from '../workshop/run-view';
import { describeTool, toolsForRun, type ControlPlaneTool } from './names';
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
  /** Phase of the run's workshop dispatch; null or absent for a legacy run. */
  phase?: WorkshopPhase | null;
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
  const dispatch = run.dispatchId ? await dispatchOf(run.dispatchId) : undefined;

  return { run, epoch: claims.epoch, agent, task, phase: dispatch?.phase ?? null };
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
  crashPoint('control_plane.after_commit');
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

export interface WorkshopTaskSnapshot extends TaskSnapshot {
  workshop: {
    phase: WorkshopPhase;
    round: number;
    role: 'lead' | 'member';
    members: string[];
    /** The tool this run reports with; null when its phase takes no report from it yet. */
    reportTool: string | null;
  };
}

/** A workshop run reads the frozen brief and only the timeline its phase lets it see. */
export async function getTaskSnapshot(ctx: RunToolContext): Promise<TaskSnapshot | WorkshopTaskSnapshot> {
  const task = await freshTask(ctx);
  const view = await workshopRunView(ctx.run);
  if (view) {
    const offered = toolsForRun(ctx.run, view.phase);
    return {
      taskNumber: task.number,
      title: view.title,
      brief: view.brief,
      status: task.status,
      workshop: {
        phase: view.phase,
        round: view.round,
        role: view.role,
        members: view.members.map((m) => m.name),
        reportTool: offered.find((t) => t.startsWith('submit_')) ?? null,
      },
      timeline: view.timeline.map((t) => ({
        seq: t.seq,
        kind: t.kind,
        content: t.content,
        createdAt: t.createdAt.toISOString(),
      })),
    };
  }
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
  await addAgentTurn(ctx.run.userId, ctx.task.id, ctx.agent.id, content, { runId: ctx.run.id, epoch: ctx.epoch }, tx);
}

export interface StatusResult {
  status: TaskStatus;
}

export async function commentOnTask(ctx: RunToolContext, body: string): Promise<void> {
  await controlPlaneWrite(ctx, 'comment_on_task', { body }, (tx) => postAsAgent(ctx, body, tx));
}

/** Status writes go through the same transition table as every other path. */
export async function updateTaskStatus(ctx: RunToolContext, status: TaskStatus): Promise<StatusResult> {
  if (isWorkshop(ctx.task)) {
    throw conflict('workshop_status', "A workshop task's status follows its phases");
  }
  return controlPlaneWrite(ctx, 'update_task_status', { status }, async (tx, queued) => {
    const moved = await moveTaskWithin(tx, ctx.run.userId, ctx.task.id, { status });
    queued.push(...moved.queued);
    return { status: moved.task.status };
  });
}

/**
 * Puts the question on the timeline. A legacy task is flagged as blocked; on
 * a workshop task the question becomes an open request for a person, since
 * only the engine moves its status.
 */
export async function askBlocker(ctx: RunToolContext, question: string): Promise<StatusResult> {
  return controlPlaneWrite(ctx, 'ask_blocker', { question }, async (tx, queued) => {
    await postAsAgent(ctx, `[BLOCKER] ${question}`, tx);
    if (isWorkshop(ctx.task)) {
      await openHumanRequest(
        {
          taskId: ctx.task.id,
          runId: ctx.run.id,
          kind: 'input',
          payload: { question, agentId: ctx.agent.id, agentName: ctx.agent.name },
          choices: [],
          ttlMs: config.blockerQuestionTtlMs,
        },
        tx
      );
      return { status: (await freshTask(ctx, tx)).status };
    }
    return { status: (await advanceTo(ctx, 'blocked', tx, queued)).status };
  });
}

export interface DispatchReportResult {
  /** False when the dispatch already had a report; the stored one is returned. */
  accepted: boolean;
  report: Record<string, unknown>;
}

/**
 * Records the report of the run's workshop dispatch. It only inserts: the
 * dispatch row and the task are left to the run's settlement, so a report
 * never waits on the task row. A second report for the same dispatch, from a
 * retried or handed-off run, returns the first.
 */
export async function submitDispatchReport(
  ctx: RunToolContext,
  tool: string,
  report: Record<string, unknown>
): Promise<DispatchReportResult> {
  if (!ctx.run.dispatchId) throw badRequest('not_a_workshop_run', 'Only workshop runs submit this report');
  const dispatch = await assertReportTool(ctx.run.dispatchId, tool);
  const context = tool === 'submit_plan' ? { members: await activeMembers(dispatch.taskId) } : undefined;
  const parsed = parseReport(tool, report, context);
  return controlPlaneWrite(ctx, tool, parsed, (tx) => insertDispatchReport(tx, ctx, tool, parsed));
}

/** A workshop run reports only through its dispatch's phase tool. */
async function assertReportTool(dispatchId: string, tool: string): Promise<Dispatch> {
  const dispatch = await dispatchOf(dispatchId);
  const expected = dispatch ? agentPhase(dispatch.phase)?.reportTool : undefined;
  if (!dispatch || expected !== tool) {
    throw badRequest('wrong_report_tool', expected ? `This run reports with ${expected}` : 'This run takes no report');
  }
  return dispatch;
}

async function insertDispatchReport(
  tx: Tx,
  ctx: RunToolContext,
  tool: string,
  report: Record<string, unknown>
): Promise<DispatchReportResult> {
  const dispatchId = ctx.run.dispatchId!;
  const [inserted] = await tx
    .insert(dispatchReports)
    .values({ dispatchId, runId: ctx.run.id, epoch: ctx.epoch, tool, report })
    .onConflictDoNothing()
    .returning();
  if (inserted) return { accepted: true, report };
  const [existing] = await tx.select().from(dispatchReports).where(eq(dispatchReports.dispatchId, dispatchId));
  return { accepted: false, report: existing!.report };
}

/** Posts the result; a legacy task moves to review, a workshop run records it as its dispatch's report. */
export async function submitResult(ctx: RunToolContext, summary: string): Promise<StatusResult> {
  if (!summary.trim()) throw badRequest('invalid_input', 'Result summary is required');
  if (ctx.run.dispatchId) await assertReportTool(ctx.run.dispatchId, 'submit_result');
  return controlPlaneWrite(ctx, 'submit_result', { summary }, async (tx, queued) => {
    await postAsAgent(ctx, summary, tx);
    if (ctx.run.dispatchId) await insertDispatchReport(tx, ctx, 'submit_result', { summary });
    if (isWorkshop(ctx.task)) return { status: (await freshTask(ctx, tx)).status };
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
  const verdict = { agentId: ctx.agent.id, runId: ctx.run.id, epoch: ctx.epoch, decision, body: feedback };

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
 * epoch check as an MCP call, and the run is offered the same tools
 * (toolsForRun).
 */
export function buildControlPlaneToolDefs(ctx: RunToolContext): ControlPlaneToolDef[] {
  const workshop = ctx.run.dispatchId !== null;
  return toolsForRun(ctx.run, ctx.phase ?? null).map((name) => {
    const def = TOOL_DEFS[name];
    return {
      name,
      description: describeTool(name, workshop),
      parameters: def.parameters,
      execute: async (args) => {
        await assertRunActive(db, ctx.run.id, ctx.epoch);
        return def.execute(ctx, args);
      },
    };
  });
}

const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false };

const TOOL_DEFS: Record<
  ControlPlaneTool,
  { parameters: Record<string, unknown>; execute: (ctx: RunToolContext, args: Record<string, unknown>) => Promise<string> }
> = {
  get_task: {
    parameters: NO_ARGS,
    execute: async (ctx) => JSON.stringify(await getTaskSnapshot(ctx)),
  },
  comment_on_task: {
    parameters: { type: 'object', properties: { body: { type: 'string' } }, required: ['body'] },
    execute: async (ctx, args) => {
      await commentOnTask(ctx, requireString(args, 'body'));
      return 'Comment posted';
    },
  },
  update_task_status: {
    parameters: {
      type: 'object',
      properties: { status: { type: 'string', enum: STATUS_VALUES } },
      required: ['status'],
    },
    execute: async (ctx, args) => {
      const status = requireString(args, 'status') as TaskStatus;
      if (!STATUS_VALUES.includes(status)) {
        throw badRequest('invalid_input', `Unknown status "${status}"`);
      }
      const task = await updateTaskStatus(ctx, status);
      return JSON.stringify({ status: task.status });
    },
  },
  submit_review: {
    parameters: {
      type: 'object',
      properties: {
        decision: { type: 'string', enum: ['approved', 'changes_requested'] },
        feedback: { type: 'string' },
      },
      required: ['decision', 'feedback'],
    },
    execute: async (ctx, args) => {
      const decision = requireString(args, 'decision') as ApprovalDecision;
      if (decision !== 'approved' && decision !== 'changes_requested') {
        throw badRequest('invalid_input', `Unknown decision "${decision}"`);
      }
      return JSON.stringify(await submitReviewVerdict(ctx, decision, requireString(args, 'feedback')));
    },
  },
  ask_blocker: {
    parameters: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
    execute: async (ctx, args) => {
      const task = await askBlocker(ctx, requireString(args, 'question'));
      return JSON.stringify({ status: task.status });
    },
  },
  submit_result: {
    parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
    execute: async (ctx, args) => {
      const task = await submitResult(ctx, requireString(args, 'summary'));
      return JSON.stringify({ status: task.status });
    },
  },
  submit_exploration: {
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        questions: { type: 'array', items: { type: 'string' }, maxItems: MAX_EXPLORATION_QUESTIONS },
      },
      required: ['summary'],
      additionalProperties: false,
    },
    execute: async (ctx, args) => JSON.stringify(await submitDispatchReport(ctx, 'submit_exploration', args)),
  },
  submit_plan: {
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        packages: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_PACKAGES,
          items: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              title: { type: 'string' },
              owner: { type: 'string' },
              area: { type: 'string' },
              dependsOn: { type: 'array', items: { type: 'string' } },
              acceptance: { type: 'array', items: { type: 'string' }, minItems: 1 },
            },
            required: ['key', 'title', 'owner', 'area', 'acceptance'],
            additionalProperties: false,
          },
        },
        integration: { type: 'string' },
        verification: { type: 'string' },
      },
      required: ['summary', 'packages', 'integration', 'verification'],
      additionalProperties: false,
    },
    execute: async (ctx, args) => JSON.stringify(await submitDispatchReport(ctx, 'submit_plan', args)),
  },
  submit_plan_review: {
    parameters: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['approve', 'object'] },
        comments: { type: 'string' },
      },
      required: ['verdict'],
      additionalProperties: false,
    },
    execute: async (ctx, args) => JSON.stringify(await submitDispatchReport(ctx, 'submit_plan_review', args)),
  },
};
