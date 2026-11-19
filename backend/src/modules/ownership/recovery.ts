import { and, desc, eq, inArray } from 'drizzle-orm';
import { config } from '../../config';
import { db, type Tx } from '../../db/client';
import {
  agents,
  changeSnapshots,
  humanRequests,
  runs,
  workspaces,
  type Agent,
  type RecoveryClass,
  type Run,
  type Workspace,
  type WorkspaceStatus,
} from '../../db/schema';
import { runBeforeRef } from '../code-workspaces/branch-name';
import { getTaskWorkspace, inspectWorktreeForRecovery } from '../code-workspaces/workspace.service';
import { hasCommittedEffects, readRunLedger, type RunLedger } from '../runs/run-ledger';
import { createQueuedRun, ownerOf, type RunOwner } from '../runs/runs.service';
import { addSystemTurn } from '../tasks/turns.service';
import { crashPoint } from './crash-points';
import { fence } from './fence';
import { endOrphans, type LauncherIdentity } from './orphans';

/**
 * Recovery of a run that lost its owner. The taker owns the run (running,
 * next epoch, fresh lease) and moves it through recovery_step:
 *
 *   taken_over --assess--> assessed --resolve--> resolved
 *
 * Assessing ends what is left of the agent's processes (see orphans.ts), then
 * reads what the run committed and inspects its worktree outside
 * any transaction, then records a recovery snapshot and the class in one
 * fenced transaction. Resolving applies the class in one fenced transaction.
 * A recoverer that dies leaves the run running at the step it reached; once
 * its lease expires the next taker resumes from there, and its fence refuses
 * anything the dead recoverer still tries to write.
 *
 *   class        run                    workspace              decision request
 *   retry        failed + queued retry  untouched              none (gives up at the attempt cap)
 *   known        succeeded (owner_lost) quarantined if writer  none
 *   interrupted  interrupted            quarantined            retry (continue / discard / stop)
 */

export type WorktreeState = 'none' | 'unchanged' | 'changed' | 'unknown';

export interface RecoveryFacts {
  ledger: RunLedger;
  worktree: WorktreeState;
  /** Agent processes of the run may still be alive and writing its worktree: no launcher could be found and ended. */
  orphanRisk: boolean;
}

/**
 * Only a run with nothing committed and nothing changed may run again
 * unattended; a committed terminal call settles the outcome; anything else
 * is for a person to decide.
 */
export function classifyRecovery(facts: RecoveryFacts): RecoveryClass {
  if (facts.ledger.terminal) return 'known';
  if (hasCommittedEffects(facts.ledger)) return 'interrupted';
  if (facts.worktree === 'changed' || facts.worktree === 'unknown') return 'interrupted';
  if (facts.orphanRisk) return 'interrupted';
  return 'retry';
}

type AgentTraits = Pick<Agent, 'name' | 'runtime' | 'permissionLevel'>;

/** A CLI agent on a non-review run above read-only can change the task's worktree. */
export function couldWriteWorktree(run: Pick<Run, 'trigger'>, agent: AgentTraits | undefined): boolean {
  return (
    agent !== undefined && agent.runtime !== 'api' && run.trigger !== 'review' && agent.permissionLevel !== 'read_only'
  );
}

/** Workspace states a lost writer can leave behind and that a new run could pick up. */
const LIVE_WORKSPACE: WorkspaceStatus[] = ['preparing', 'ready', 'dirty', 'conflicted', 'missing', 'error'];

async function agentOf(run: Run): Promise<AgentTraits | undefined> {
  if (!run.agentId) return undefined;
  const [agent] = await db
    .select({ name: agents.name, runtime: agents.runtime, permissionLevel: agents.permissionLevel })
    .from(agents)
    .where(eq(agents.id, run.agentId));
  return agent;
}

function launcherOf(run: Run): LauncherIdentity | null {
  return run.launcherPid && run.launcherTag && run.launcherHost
    ? { pid: run.launcherPid, tag: run.launcherTag, host: run.launcherHost }
    : null;
}

async function workspaceOf(run: Run): Promise<Workspace | null> {
  return run.taskId ? getTaskWorkspace(run.userId, run.taskId) : null;
}

/** Drives a taken-over run to its resolved state, starting from the step it reached. */
export async function recoverRun(run: Run): Promise<Run> {
  const owner = ownerOf(run);
  let current = run;
  if (current.recoveryStep === 'taken_over') {
    crashPoint('recovery.before_assess');
    current = await assess(current, owner);
  }
  if (current.recoveryStep === 'assessed') {
    crashPoint('recovery.before_resolve');
    current = await resolve(current, owner);
  }
  return current;
}

async function assess(run: Run, owner: RunOwner): Promise<Run> {
  const agent = await agentOf(run);
  const writer = couldWriteWorktree(run, agent);
  const ledger = await readRunLedger(run.id);
  const workspace = await workspaceOf(run);
  // End what is left of the agent before looking at its worktree, so nothing
  // can still change it once it has been compared.
  const orphans = await endOrphans(launcherOf(run));
  const inspection = workspace ? await inspectWorktreeForRecovery(run, workspace, writer) : null;
  const recoveryClass = classifyRecovery({
    ledger,
    worktree: inspection?.worktree ?? 'none',
    orphanRisk: writer && workspace !== null && run.beforeTree !== null && orphans !== 'cleared',
  });

  return db.transaction(async (tx) => {
    await fence(tx, owner, 'recovery_assess');
    if (inspection?.snapshot) {
      await tx
        .insert(changeSnapshots)
        .values({ ...inspection.snapshot, runId: run.id, epoch: owner.epoch, kind: 'recovery' })
        .onConflictDoNothing();
    }
    const [assessed] = await tx
      .update(runs)
      .set({ recoveryClass, recoveryStep: 'assessed' })
      .where(eq(runs.id, run.id))
      .returning();
    return assessed!;
  });
}

async function resolve(run: Run, owner: RunOwner): Promise<Run> {
  const agent = await agentOf(run);
  const writer = couldWriteWorktree(run, agent);
  const ledger = await readRunLedger(run.id);
  return db.transaction(async (tx) => {
    await fence(tx, owner, 'recovery_resolve');
    const finished = { leaseExpiresAt: null, recoveryStep: 'resolved' as const, finishedAt: new Date() };
    let resolved: Run;
    switch (run.recoveryClass) {
      case 'known':
        resolved = await update(tx, run.id, { ...finished, status: 'succeeded', error: null, stopReason: 'owner_lost' });
        if (writer) {
          await quarantine(tx, run, `Run ${run.id} lost its owner after submitting its result; its agent may still be writing here. Reconcile the workspace before running again.`);
        }
        break;
      case 'interrupted':
        resolved = await update(tx, run.id, { ...finished, finishedAt: null, status: 'interrupted' });
        await quarantine(tx, run, `Run ${run.id} was interrupted; decide on its retry request before running again.`);
        await openRetryDecision(tx, run, owner, ledger, agent);
        break;
      default: {
        const retrying = run.agentId !== null && run.attempt < retryPolicy.maxAttempts;
        const lost = run.error ?? 'Owner lost';
        resolved = await update(tx, run.id, {
          ...finished,
          status: 'failed',
          error: retrying
            ? `${lost}; retrying as attempt ${run.attempt + 1}`
            : `${lost}; gave up after ${run.attempt} attempt(s)`,
        });
        if (retrying) await queueRetry(tx, run);
      }
    }
    if (run.agentId) {
      await tx
        .update(agents)
        .set({ status: resolved.status === 'succeeded' ? 'idle' : 'error', updatedAt: new Date() })
        .where(eq(agents.id, run.agentId));
    }
    return resolved;
  });
}

let retryPolicy = { maxAttempts: config.runMaxAttempts, backoffMs: config.runRetryBackoffMs };

/** Test seam: change how often and how soon runs that did nothing are retried. */
export function setRetryPolicyForTests(policy: Partial<typeof retryPolicy> | null): void {
  retryPolicy = policy
    ? { ...retryPolicy, ...policy }
    : { maxAttempts: config.runMaxAttempts, backoffMs: config.runRetryBackoffMs };
}

/**
 * The retry is a new run queued in the resolving transaction: same agent,
 * task, trigger, and reason, the next attempt, and an exponential back-off
 * the promoter honors through not_before. Nothing ran, so nothing repeats.
 */
async function queueRetry(tx: Tx, run: Run): Promise<void> {
  await createQueuedRun(
    run.userId,
    {
      agentId: run.agentId!,
      agentName: run.agentName,
      taskId: run.taskId,
      trigger: run.trigger,
      reason: run.reason,
      model: run.model,
      parentRunId: run.id,
      attempt: run.attempt + 1,
      delayMs: retryPolicy.backoffMs * 2 ** (run.attempt - 1),
    },
    tx
  );
}

async function update(tx: Tx, runId: string, patch: Partial<typeof runs.$inferInsert>): Promise<Run> {
  const [row] = await tx.update(runs).set(patch).where(eq(runs.id, runId)).returning();
  return row!;
}

async function quarantine(tx: Tx, run: Run, reason: string): Promise<void> {
  if (!run.taskId) return;
  await tx
    .update(workspaces)
    .set({ status: 'quarantined', lastError: reason, updatedAt: new Date() })
    .where(and(eq(workspaces.taskId, run.taskId), inArray(workspaces.status, LIVE_WORKSPACE)));
}

/** Exactly one retry request per interrupted run; a resumed resolve finds it already there. */
async function openRetryDecision(
  tx: Tx,
  run: Run,
  owner: RunOwner,
  ledger: RunLedger,
  agent: AgentTraits | undefined
): Promise<void> {
  if (!run.taskId) return;
  const [snapshot] = await tx
    .select({ changedFiles: changeSnapshots.changedFiles })
    .from(changeSnapshots)
    .where(and(eq(changeSnapshots.runId, run.id), eq(changeSnapshots.kind, 'recovery')))
    .orderBy(desc(changeSnapshots.capturedAt))
    .limit(1);
  const canDiscard = snapshot !== undefined && run.beforeTree !== null;
  const [request] = await tx
    .insert(humanRequests)
    .values({
      taskId: run.taskId,
      runId: run.id,
      kind: 'retry',
      payload: {
        runId: run.id,
        agentName: agent?.name ?? run.agentName,
        controlPlaneWrites: ledger.controlPlaneWrites,
        timelineEntries: ledger.timelineEntries,
        changedFiles: snapshot?.changedFiles ?? null,
        beforeRef: canDiscard ? runBeforeRef(run.id) : null,
      },
      choices: canDiscard ? ['continue', 'discard', 'stop'] : ['continue', 'stop'],
      expiresAt: new Date(Date.now() + config.retryDecisionTtlMs),
    })
    .onConflictDoNothing()
    .returning({ id: humanRequests.id });
  if (!request) return;
  const changed = snapshot ? `, ${snapshot.changedFiles} changed file(s) in the worktree` : '';
  await addSystemTurn(
    run.userId,
    run.taskId,
    `Run by ${agent?.name ?? run.agentName} lost its owner partway through (${ledger.controlPlaneWrites} control-plane write(s)${changed}). The task waits until someone decides: continue, ${canDiscard ? 'discard the changes, ' : ''}or stop.`,
    { runId: run.id, epoch: owner.epoch },
    tx
  );
}
