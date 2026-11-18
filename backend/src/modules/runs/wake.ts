import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { agents, tasks, type Agent, type Task, type Run, type RunTrigger } from '../../db/schema';
import { badRequest } from '../../http/errors';
import { addAgentTurn, runHasTurns } from '../tasks/turns.service';
import { RunnerError } from '../runner/runner';
import { executeTaskTurn } from './task-run';
import {
  admitRun,
  createQueuedRun,
  failQueuedRun,
  nextQueuedRunForAgent,
  nextQueuedRunForTask,
  queuedRunFor,
  settleRun,
  type RunOutcome,
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
 * (assignment, manual nudge, review) calls this and nothing else.
 *
 * Agent and task must exist and be owned by the caller. A wake joins a run
 * already queued for the same agent and task (merged); otherwise it becomes a
 * new queued run that starts at once if the agent and the task are both free,
 * or waits for promotion. A running run never absorbs a wake: its prompt is
 * already built, and if its owner has died the wake would die with it.
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

  // Two racing wakes can both miss this check; the loser then queues a second
  // run behind the winner, which is safe, just not merged.
  const pending = await queuedRunFor(input.agentId, input.taskId);
  if (pending) return { run: pending, admitted: 'merged' };

  const run = await createQueuedRun(userId, {
    agentId: agent.id,
    agentName: agent.name,
    taskId: input.taskId,
    trigger: input.trigger,
    reason: input.reason,
  });

  const started = await tryStartRun(run);
  return { run: started ?? run, admitted: started ? 'started' : 'queued' };
}

/**
 * Starts a queued run if its agent and task are free; otherwise it stays
 * queued for a later promotion pass. Admission is a single transaction, so a
 * failure part-way leaves no claim or lock behind.
 */
async function tryStartRun(run: Run): Promise<Run | undefined> {
  if (!run.agentId) {
    await failQueuedRun(run.id, 'Agent no longer exists').catch(() => {});
    return undefined;
  }
  const admission = await admitRun(run.id);
  if (!admission) return undefined;

  const started = admission.run;
  const settled = performRun(started).catch((error) => {
    console.error(`Run ${started.id} settlement failed:`, error);
  });
  settling.add(settled);
  void settled.finally(() => settling.delete(settled));
  return started;
}

async function performRun(run: Run): Promise<void> {
  let outcome: RunOutcome;
  let report: { taskId: string; agentId: string; text: string } | undefined;
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

    const result = await executeTaskTurn(run, agent as Agent, task as Task);
    outcome = {
      status: result.ok ? 'succeeded' : 'failed',
      output: result.text,
      error: result.ok ? null : (result.error ?? `Turn ended: ${result.stopReason}`),
      sessionRef: result.sessionRef,
      transport: result.transport,
      stopReason: result.stopReason,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      costUsd: result.costUsd,
    };
    if (result.ok && result.text.trim()) {
      report = { taskId: task.id, agentId: agent.id, text: result.text };
    }
  } catch (error) {
    const detail = error instanceof RunnerError ? error.message : 'Task run failed unexpectedly';
    if (!(error instanceof RunnerError)) console.error(`Run ${run.id} failed:`, error);
    outcome = { status: 'failed', error: detail };
  }

  // Fallback report: only when the agent said nothing through the control
  // plane during the run. Posted while the run still holds the task, so the
  // next run's prompt sees it. Best-effort — the run result stands regardless.
  if (report && !(await runHasTurns(run.id))) {
    await addAgentTurn(run.userId, report.taskId, report.agentId, report.text, { runId: run.id }).catch(
      () => {}
    );
  }
  // If settling fails the run keeps its lease and the reconciler takes it over.
  await settleRun(run.id, outcome, outcome.status === 'succeeded' ? 'idle' : 'error').catch((error) => {
    console.error(`Run ${run.id} could not be settled:`, error);
  });
  await promoteNext(run);
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
