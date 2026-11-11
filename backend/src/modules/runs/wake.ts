import { and, eq, gte, inArray, ne } from 'drizzle-orm';
import { db } from '../../db/client';
import {
  agents,
  taskComments,
  tasks,
  runs,
  type Agent,
  type Task,
  type Run,
  type RunTrigger,
} from '../../db/schema';
import { badRequest } from '../../http/errors';
import { addAgentComment } from '../tasks/comments.service';
import { RunnerError } from '../runner/runner';
import { executeTaskTurn } from './task-run';
import {
  ACTIVE_RUN_STATUSES,
  acquireTaskLock,
  claimRun,
  createQueuedRun,
  finishRun,
  nextQueuedRunForAgent,
  nextQueuedRunForTask,
  releaseTaskLock,
} from './runs.service';

export type WakeAdmission = 'started' | 'queued' | 'merged';

export interface WakeInput {
  agentId: string;
  taskId: string;
  trigger: RunTrigger;
  reason?: string;
}

export interface WakeDecision {
  run: Run;
  admitted: WakeAdmission;
}

/** In-flight executions, awaitable by tests. */
const settling = new Set<Promise<void>>();

/** Test seam: resolves once every started run has settled and promoted. */
export async function drainRunsForTests(): Promise<void> {
  while (settling.size > 0) {
    await Promise.all([...settling]);
  }
}

/**
 * The single admission surface for agent wake-ups. Every trigger source
 * (assignment, manual nudge, review, and later chat) calls this and nothing
 * else; merge, lock, and rejection logic lives here exactly once.
 *
 * Order of checks: agent and task must exist and be owned by the caller;
 * an active run for the same agent+task absorbs the wake (merged); otherwise
 * a queued run is created and started if both the agent and the task's
 * execution lock are free, else it waits in queue for promotion.
 */
export async function requestWake(userId: string, input: WakeInput): Promise<WakeDecision> {
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, input.agentId), eq(agents.userId, userId)))
    .limit(1);
  if (!agent) throw badRequest('invalid_agent', 'Agent does not exist');

  const [task] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, input.taskId), eq(tasks.userId, userId)))
    .limit(1);
  if (!task) throw badRequest('invalid_task', 'Task does not exist');

  // Two racing wakes can both miss this check; the loser then parks as a
  // queued run behind the winner's lock, which is safe, just not merged.
  const [active] = await db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.agentId, input.agentId),
        eq(runs.taskId, input.taskId),
        inArray(runs.status, [...ACTIVE_RUN_STATUSES])
      )
    )
    .limit(1);
  if (active) return { run: active, admitted: 'merged' };

  const run = await createQueuedRun(userId, {
    agentId: agent.id,
    agentName: agent.name,
    taskId: input.taskId,
    trigger: input.trigger,
    reason: input.reason,
  });

  const started = await tryStartRun(run);
  return { run, admitted: started ? 'started' : 'queued' };
}

/**
 * Atomic agent claim; an agent executes at most one turn at a time, no
 * matter which surface (task run, chat) started it.
 */
export async function claimAgentForTurn(agentId: string): Promise<boolean> {
  const rows = await db
    .update(agents)
    .set({ status: 'busy', lastActiveAt: new Date(), updatedAt: new Date() })
    .where(and(eq(agents.id, agentId), ne(agents.status, 'busy')))
    .returning({ id: agents.id });
  return rows.length > 0;
}

/** Bare claim release; gate-rollback paths use this to avoid re-promoting themselves. */
async function releaseAgentClaim(agentId: string, status: 'idle' | 'error'): Promise<void> {
  await db
    .update(agents)
    .set({ status, lastActiveAt: new Date(), updatedAt: new Date() })
    .where(eq(agents.id, agentId));
}

/**
 * Releases the claim and starts the oldest run that queued up behind it —
 * without this, runs parked behind a chat turn would wait forever.
 */
export async function releaseAgentAfterTurn(
  agentId: string,
  status: 'idle' | 'error'
): Promise<void> {
  await releaseAgentClaim(agentId, status);
  const queued = await nextQueuedRunForAgent(agentId);
  if (queued) await tryStartRun(queued);
}

/**
 * Starts a queued run if both gates open: the agent claim and the task
 * execution lock. Any failed gate rolls the earlier ones back and leaves the
 * run queued for a later promotion pass.
 */
async function tryStartRun(run: Run): Promise<boolean> {
  if (!run.agentId) {
    await finishRun(run.id, { status: 'failed', error: 'Agent no longer exists' }).catch(() => {});
    return false;
  }
  if (!(await claimAgentForTurn(run.agentId))) return false;

  if (run.taskId && !(await acquireTaskLock(run.taskId, run.id))) {
    await releaseAgentClaim(run.agentId, 'idle');
    return false;
  }

  const claimed = await claimRun(run.id);
  if (!claimed) {
    if (run.taskId) await releaseTaskLock(run.taskId, run.id);
    await releaseAgentClaim(run.agentId, 'idle');
    return false;
  }

  const settled = performRun(claimed).catch((error) => {
    console.error(`Run ${claimed.id} settlement failed:`, error);
  });
  settling.add(settled);
  void settled.finally(() => settling.delete(settled));
  return true;
}

async function agentSpokeSince(
  taskId: string,
  agentId: string,
  since: Date | null
): Promise<boolean> {
  const [row] = await db
    .select({ id: taskComments.id })
    .from(taskComments)
    .where(
      and(
        eq(taskComments.taskId, taskId),
        eq(taskComments.authorAgentId, agentId),
        gte(taskComments.createdAt, since ?? new Date(0))
      )
    )
    .limit(1);
  return row !== undefined;
}

async function performRun(run: Run): Promise<void> {
  let succeeded = false;
  try {
    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, run.agentId!))
      .limit(1);
    const [task] = run.taskId
      ? await db.select().from(tasks).where(eq(tasks.id, run.taskId)).limit(1)
      : [undefined];
    if (!agent || !task) {
      throw new RunnerError('Agent or task disappeared before the run started', 'cli_failed');
    }

    const outcome = await executeTaskTurn(run, agent as Agent, task as Task);
    await finishRun(run.id, {
      status: 'succeeded',
      output: outcome.text,
      sessionRef: outcome.sessionRef,
    });
    // Fallback report: only when the agent said nothing through the control
    // plane during the run. Best-effort — the run result stands regardless.
    if (outcome.text.trim() && !(await agentSpokeSince(task.id, agent.id, run.startedAt))) {
      await addAgentComment(run.userId, task.id, agent.id, outcome.text).catch(() => {});
    }
    succeeded = true;
  } catch (error) {
    const detail = error instanceof RunnerError ? error.message : 'Task run failed unexpectedly';
    if (!(error instanceof RunnerError)) console.error(`Run ${run.id} failed:`, error);
    await finishRun(run.id, { status: 'failed', error: detail }).catch(() => {});
  } finally {
    if (run.taskId) await releaseTaskLock(run.taskId, run.id);
    if (run.agentId) await releaseAgentClaim(run.agentId, succeeded ? 'idle' : 'error');
    await promoteNext(run);
  }
}

/**
 * After a run settles, try the oldest queued run waiting on the same task,
 * then the oldest waiting on the same agent. Gate failures leave candidates
 * queued for the next settlement.
 */
async function promoteNext(finished: Run): Promise<void> {
  const candidates: Run[] = [];
  if (finished.taskId) {
    const byTask = await nextQueuedRunForTask(finished.taskId);
    if (byTask) candidates.push(byTask);
  }
  if (finished.agentId) {
    const byAgent = await nextQueuedRunForAgent(finished.agentId);
    if (byAgent && !candidates.some((c) => c.id === byAgent.id)) candidates.push(byAgent);
  }
  for (const candidate of candidates) {
    await tryStartRun(candidate);
  }
}
