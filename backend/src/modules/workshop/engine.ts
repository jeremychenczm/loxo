import type {
  DispatchPurpose,
  DispatchStatus,
  HumanRequestKind,
  HumanRequestStatus,
  WorkshopPhase,
} from '../../db/schema';
import { agentPhase, FINISHED_PHASES, type AgentPhaseSpec } from './phases';
import { questionsOf } from './reports';

/**
 * The workshop engine's decision function. It reads a snapshot of one task's
 * workshop state and returns what should happen next; it does no IO. The
 * advancing transaction loads the state, applies the actions, and runs it
 * again later. Deciding on the state the actions produce must return nothing
 * new, so a repeated or interrupted advance is harmless.
 */

export interface MemberView {
  agentId: string;
  skipped: boolean;
}

export interface DispatchView {
  id: string;
  phase: WorkshopPhase;
  purpose: DispatchPurpose;
  packageKey: string;
  cycle: number;
  round: number;
  agentId: string | null;
  status: DispatchStatus;
  report: Record<string, unknown> | null;
  /** Start of the current running span; null before the first run starts or while paused. */
  startedAtMs: number | null;
  pausedAtMs: number | null;
  elapsedMs: number;
  timeoutMs: number;
  cancelRequested: boolean;
  /** The dispatch's run is interrupted or has an open request: the clock stops. */
  waitingOnPerson: boolean;
}

export interface RequestView {
  id: string;
  kind: HumanRequestKind;
  dedupeKey: string | null;
  status: HumanRequestStatus;
  answer: Record<string, unknown> | null;
  /** Null for a request that does not expire. */
  expiresAtMs: number | null;
}

export interface WorkshopState {
  taskId: string;
  playbook: 'build' | 'solo';
  /** Null until the workshop starts. */
  phase: WorkshopPhase | null;
  cycle: number;
  round: number;
  leadAgentId: string;
  /** Frozen roster in speaking order. */
  members: MemberView[];
  parallelism: number;
  snapshotFrozen: boolean;
  /**
   * The members' worktrees: absent before any are asked for (always, for a
   * workshop without a repository), preparing while their operations run,
   * ready once all are prepared, cleaning and cleaned after the workshop ends.
   */
  worktrees: WorktreeState;
  hasRepository: boolean;
  dispatches: DispatchView[];
  requests: RequestView[];
  nowMs: number;
}

export type WorktreeState = 'absent' | 'preparing' | 'ready' | 'cleaning' | 'cleaned';

export interface EngineSettings {
  readOnlyTimeoutMs: number;
  writeTimeoutMs: number;
  /** How long the members' explore questions wait for a person before Plan goes ahead without answers. */
  questionsTtlMs: number;
}

export type MemberFailedChoice = 'retry' | 'skip' | 'stop';

export type Action =
  | { type: 'freeze_snapshot' }
  | { type: 'prepare_worktrees' }
  | { type: 'cleanup_worktrees' }
  | {
      type: 'dispatch';
      phase: WorkshopPhase;
      purpose: DispatchPurpose;
      agentId: string;
      packageKey: string;
      cycle: number;
      round: number;
      readOnly: boolean;
      timeoutMs: number;
    }
  | { type: 'cancel_dispatch'; dispatchId: string; reason: 'timeout' }
  | { type: 'pause_dispatch'; dispatchId: string }
  | { type: 'resume_dispatch'; dispatchId: string }
  | {
      type: 'open_request';
      kind: HumanRequestKind;
      dedupeKey: string;
      payload: Record<string, unknown>;
      choices: string[];
      /** Omitted for requests that wait until a person answers. */
      ttlMs?: number;
    }
  | { type: 'expire_request'; requestId: string }
  | { type: 'skip_member'; agentId: string }
  | { type: 'transition'; from: WorkshopPhase | null; to: WorkshopPhase; cycle: number; round: number; cause: Record<string, unknown> }
  | { type: 'stop'; reason: string };

const UNFINISHED: readonly DispatchStatus[] = ['pending', 'running'];
const SETTLED_OK: readonly DispatchStatus[] = ['reported', 'skipped'];

export function questionsKey(cycle: number): string {
  return `questions:explore:${cycle}`;
}

export function memberFailedKey(phase: WorkshopPhase, cycle: number, round: number, agentId: string): string {
  return `member_failed:${phase}:${cycle}:${round}:${agentId}`;
}

/** Running time so far, excluding paused spans. */
export function elapsedMs(d: Pick<DispatchView, 'elapsedMs' | 'startedAtMs' | 'pausedAtMs'>, nowMs: number): number {
  const span = d.startedAtMs !== null && d.pausedAtMs === null ? Math.max(0, nowMs - d.startedAtMs) : 0;
  return d.elapsedMs + span;
}

export function decide(state: WorkshopState, settings: EngineSettings): Action[] {
  if (state.phase === null) return [];
  if (FINISHED_PHASES.includes(state.phase)) {
    return state.worktrees === 'ready' ? [{ type: 'cleanup_worktrees' }] : [];
  }
  if (state.phase === 'brief') return decideBrief(state);
  const spec = agentPhase(state.phase);
  // Platform phases (integrate, check, approval, merge) arrive with their steps.
  if (!spec) return [];
  return decideAgentPhase(state, spec, settings);
}

function decideBrief(state: WorkshopState): Action[] {
  if (!state.snapshotFrozen) return [{ type: 'freeze_snapshot' }];
  if (state.hasRepository && state.worktrees === 'absent') return [{ type: 'prepare_worktrees' }];
  // Their operations report back when they settle; nothing to do until then.
  if (state.hasRepository && state.worktrees !== 'ready') return [];
  const to: WorkshopPhase = state.playbook === 'solo' ? 'build' : 'explore';
  return [transition(state, to, 0, { brief: 'ready' })];
}

function participantsOf(state: WorkshopState, spec: AgentPhaseSpec): string[] {
  const active = state.members.filter((m) => !m.skipped).map((m) => m.agentId);
  switch (spec.participants) {
    case 'lead':
      return [state.leadAgentId];
    case 'others':
      return active.filter((id) => id !== state.leadAgentId);
    case 'all':
    case 'signers':
      return active;
  }
}

/** A participant's latest dispatch in the current phase instance. */
function slotOf(state: WorkshopState, spec: AgentPhaseSpec, agentId: string): DispatchView | undefined {
  let latest: DispatchView | undefined;
  for (const d of state.dispatches) {
    if (d.phase !== state.phase || d.purpose !== spec.purpose || d.agentId !== agentId) continue;
    if (d.cycle !== state.cycle || d.round < state.round) continue;
    if (!latest || d.round > latest.round) latest = d;
  }
  return latest;
}

function noReportsInInstance(state: WorkshopState, spec: AgentPhaseSpec, agentId: string): number {
  return state.dispatches.filter(
    (d) =>
      d.phase === state.phase &&
      d.purpose === spec.purpose &&
      d.agentId === agentId &&
      d.cycle === state.cycle &&
      d.round >= state.round &&
      d.status === 'no_report'
  ).length;
}

function requestFor(state: WorkshopState, dedupeKey: string): RequestView | undefined {
  return state.requests.find((r) => r.dedupeKey === dedupeKey);
}

function choiceOf(request: RequestView): string | undefined {
  const choice = request.answer?.choice;
  return typeof choice === 'string' ? choice : undefined;
}

function decideAgentPhase(state: WorkshopState, spec: AgentPhaseSpec, settings: EngineSettings): Action[] {
  const phase = state.phase!;
  const actions: Action[] = [];
  const timeoutMs = spec.readOnly ? settings.readOnlyTimeoutMs : settings.writeTimeoutMs;
  let unfinished = state.dispatches.filter((d) => UNFINISHED.includes(d.status)).length;
  let allSettled = true;

  const dispatchAt = (agentId: string, round: number) => {
    if (unfinished >= state.parallelism) return;
    unfinished += 1;
    actions.push({
      type: 'dispatch',
      phase,
      purpose: spec.purpose,
      agentId,
      packageKey: '',
      cycle: state.cycle,
      round,
      readOnly: spec.readOnly,
      timeoutMs,
    });
  };

  for (const agentId of participantsOf(state, spec)) {
    const slot = slotOf(state, spec, agentId);
    if (!slot) {
      allSettled = false;
      dispatchAt(agentId, state.round);
      continue;
    }
    if (SETTLED_OK.includes(slot.status)) continue;
    allSettled = false;

    if (UNFINISHED.includes(slot.status)) {
      actions.push(...clockActions(state, slot));
      continue;
    }

    // no_report, failed, or cancelled without a report
    const firstMiss = slot.status === 'no_report' && noReportsInInstance(state, spec, agentId) === 1;
    if (firstMiss) {
      dispatchAt(agentId, slot.round + 1);
      continue;
    }
    const key = memberFailedKey(phase, state.cycle, slot.round, agentId);
    const request = requestFor(state, key);
    if (!request) {
      const isLead = agentId === state.leadAgentId;
      actions.push({
        type: 'open_request',
        kind: 'member_failed',
        dedupeKey: key,
        payload: { phase, agentId, dispatchId: slot.id, outcome: slot.status },
        choices: isLead ? ['retry', 'stop'] : ['retry', 'skip', 'stop'],
      });
      continue;
    }
    if (request.status !== 'answered') continue;
    const choice = choiceOf(request);
    if (choice === 'retry') dispatchAt(agentId, slot.round + 1);
    else if (choice === 'skip' && agentId !== state.leadAgentId) actions.push({ type: 'skip_member', agentId });
    else if (choice === 'stop') return [{ type: 'stop', reason: `Stopped after ${agentId} failed in ${phase}` }];
  }

  if (allSettled) actions.push(...exitAgentPhase(state, spec, settings));
  return actions;
}

/** Timeout and pause bookkeeping for a dispatch that is queued or running. */
function clockActions(state: WorkshopState, d: DispatchView): Action[] {
  if (d.status !== 'running') return [];
  if (d.waitingOnPerson && d.pausedAtMs === null) return [{ type: 'pause_dispatch', dispatchId: d.id }];
  if (!d.waitingOnPerson && d.pausedAtMs !== null) return [{ type: 'resume_dispatch', dispatchId: d.id }];
  if (!d.cancelRequested && d.pausedAtMs === null && elapsedMs(d, state.nowMs) > d.timeoutMs) {
    return [{ type: 'cancel_dispatch', dispatchId: d.id, reason: 'timeout' }];
  }
  return [];
}

function transition(
  state: WorkshopState,
  to: WorkshopPhase,
  round: number,
  cause: Record<string, unknown>
): Action {
  return { type: 'transition', from: state.phase, to, cycle: state.cycle, round, cause };
}

/** Where an agent phase leads once every participant has settled. */
function exitAgentPhase(state: WorkshopState, spec: AgentPhaseSpec, settings: EngineSettings): Action[] {
  const cause = { settled: state.phase };
  switch (state.phase) {
    case 'explore':
      return exitExplore(state, spec, settings);
    case 'plan': {
      const othersLeft = state.members.some((m) => !m.skipped && m.agentId !== state.leadAgentId);
      return [transition(state, othersLeft ? 'plan_review' : 'build', 0, cause)];
    }
    case 'plan_review':
      return [transition(state, 'build', 0, cause)];
    default:
      // Exits from build onward arrive with their steps.
      return [];
  }
}

/**
 * Explore ends in Plan. Questions the members put in their reports go to a
 * person first, all in one request; Plan waits for the answer, or goes ahead
 * without one once the request expires.
 */
function exitExplore(state: WorkshopState, spec: AgentPhaseSpec, settings: EngineSettings): Action[] {
  const questions = participantsOf(state, spec).flatMap((agentId) => {
    const slot = slotOf(state, spec, agentId);
    return slot?.status === 'reported' ? questionsOf(slot.report).map((question) => ({ agentId, question })) : [];
  });
  if (questions.length === 0) return [transition(state, 'plan', 0, { settled: 'explore' })];

  const key = questionsKey(state.cycle);
  const request = requestFor(state, key);
  if (!request) {
    return [
      {
        type: 'open_request',
        kind: 'input',
        dedupeKey: key,
        payload: { phase: 'explore', cycle: state.cycle, questions },
        choices: [],
        ttlMs: settings.questionsTtlMs,
      },
    ];
  }
  if (request.status === 'open') {
    const overdue = request.expiresAtMs !== null && request.expiresAtMs <= state.nowMs;
    return overdue ? [{ type: 'expire_request', requestId: request.id }] : [];
  }
  const answered = request.status === 'answered';
  return [transition(state, 'plan', 0, { settled: 'explore', questions: request.id, answered })];
}
