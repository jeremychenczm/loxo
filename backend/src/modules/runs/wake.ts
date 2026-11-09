import { and, eq, gte, inArray, ne } from 'drizzle-orm';
import { db } from '../../db/client';
import {
  agents,
  issueComments,
  issues,
  runs,
  type Agent,
  type Issue,
  type Run,
  type RunTrigger,
} from '../../db/schema';
import { badRequest } from '../../http/errors';
import { addAgentComment } from '../issues/comments.service';
import { RunnerError } from '../runner/runner';
import { executeIssueTurn } from './issue-run';
import {
  ACTIVE_RUN_STATUSES,
  acquireIssueLock,
  claimRun,
  createQueuedRun,
  finishRun,
  nextQueuedRunForAgent,
  nextQueuedRunForIssue,
  releaseIssueLock,
} from './runs.service';

export type WakeAdmission = 'started' | 'queued' | 'merged';

export interface WakeInput {
  agentId: string;
  issueId: string;
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
 * Order of checks: agent and issue must exist and be owned by the caller;
 * an active run for the same agent+issue absorbs the wake (merged); otherwise
 * a queued run is created and started if both the agent and the issue's
 * execution lock are free, else it waits in queue for promotion.
 */
export async function requestWake(userId: string, input: WakeInput): Promise<WakeDecision> {
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, input.agentId), eq(agents.userId, userId)))
    .limit(1);
  if (!agent) throw badRequest('invalid_agent', 'Agent does not exist');

  const [issue] = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.id, input.issueId), eq(issues.userId, userId)))
    .limit(1);
  if (!issue) throw badRequest('invalid_issue', 'Issue does not exist');

  // Two racing wakes can both miss this check; the loser then parks as a
  // queued run behind the winner's lock, which is safe, just not merged.
  const [active] = await db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.agentId, input.agentId),
        eq(runs.issueId, input.issueId),
        inArray(runs.status, [...ACTIVE_RUN_STATUSES])
      )
    )
    .limit(1);
  if (active) return { run: active, admitted: 'merged' };

  const run = await createQueuedRun(userId, {
    agentId: agent.id,
    agentName: agent.name,
    issueId: input.issueId,
    trigger: input.trigger,
    reason: input.reason,
  });

  const started = await tryStartRun(run);
  return { run, admitted: started ? 'started' : 'queued' };
}

/**
 * Atomic agent claim; an agent executes at most one turn at a time, no
 * matter which surface (issue run, chat) started it.
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
 * Starts a queued run if both gates open: the agent claim and the issue
 * execution lock. Any failed gate rolls the earlier ones back and leaves the
 * run queued for a later promotion pass.
 */
async function tryStartRun(run: Run): Promise<boolean> {
  if (!run.agentId) {
    await finishRun(run.id, { status: 'failed', error: 'Agent no longer exists' }).catch(() => {});
    return false;
  }
  if (!(await claimAgentForTurn(run.agentId))) return false;

  if (run.issueId && !(await acquireIssueLock(run.issueId, run.id))) {
    await releaseAgentClaim(run.agentId, 'idle');
    return false;
  }

  const claimed = await claimRun(run.id);
  if (!claimed) {
    if (run.issueId) await releaseIssueLock(run.issueId, run.id);
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
  issueId: string,
  agentId: string,
  since: Date | null
): Promise<boolean> {
  const [row] = await db
    .select({ id: issueComments.id })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.issueId, issueId),
        eq(issueComments.authorAgentId, agentId),
        gte(issueComments.createdAt, since ?? new Date(0))
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
    const [issue] = run.issueId
      ? await db.select().from(issues).where(eq(issues.id, run.issueId)).limit(1)
      : [undefined];
    if (!agent || !issue) {
      throw new RunnerError('Agent or issue disappeared before the run started', 'cli_failed');
    }

    const outcome = await executeIssueTurn(run, agent as Agent, issue as Issue);
    await finishRun(run.id, {
      status: 'succeeded',
      output: outcome.text,
      sessionRef: outcome.sessionRef,
    });
    // Fallback report: only when the agent said nothing through the control
    // plane during the run. Best-effort — the run result stands regardless.
    if (outcome.text.trim() && !(await agentSpokeSince(issue.id, agent.id, run.startedAt))) {
      await addAgentComment(run.userId, issue.id, agent.id, outcome.text).catch(() => {});
    }
    succeeded = true;
  } catch (error) {
    const detail = error instanceof RunnerError ? error.message : 'Issue run failed unexpectedly';
    if (!(error instanceof RunnerError)) console.error(`Run ${run.id} failed:`, error);
    await finishRun(run.id, { status: 'failed', error: detail }).catch(() => {});
  } finally {
    if (run.issueId) await releaseIssueLock(run.issueId, run.id);
    if (run.agentId) await releaseAgentClaim(run.agentId, succeeded ? 'idle' : 'error');
    await promoteNext(run);
  }
}

/**
 * After a run settles, try the oldest queued run waiting on the same issue,
 * then the oldest waiting on the same agent. Gate failures leave candidates
 * queued for the next settlement.
 */
async function promoteNext(finished: Run): Promise<void> {
  const candidates: Run[] = [];
  if (finished.issueId) {
    const byIssue = await nextQueuedRunForIssue(finished.issueId);
    if (byIssue) candidates.push(byIssue);
  }
  if (finished.agentId) {
    const byAgent = await nextQueuedRunForAgent(finished.agentId);
    if (byAgent && !candidates.some((c) => c.id === byAgent.id)) candidates.push(byAgent);
  }
  for (const candidate of candidates) {
    await tryStartRun(candidate);
  }
}
