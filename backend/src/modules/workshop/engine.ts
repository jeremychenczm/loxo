import type {
  DispatchPurpose,
  PlanSource,
  DispatchStatus,
  HumanRequestKind,
  HumanRequestStatus,
  PlatformOpStatus,
  WorkPackageStatus,
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

/** A recorded plan version. */
export interface PlanView {
  id: string;
  cycle: number;
  version: number;
  /** The plan-phase instance (task round) it was recorded in. */
  round: number;
  source: PlanSource;
  dispatchId: string | null;
}

/** A work package of the pinned plan. */
export interface PackageView {
  key: string;
  /** Null once the owner's agent was deleted. */
  ownerAgentId: string | null;
  dependsOn: string[];
  status: WorkPackageStatus;
  attempt: number;
}

export type PackageOpKind = 'branch_package' | 'checkpoint' | 'integrate';

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
  plans: PlanView[];
  /** A plan has been pinned and its work packages written. */
  planPinned: boolean;
  /** The pinned plan's packages, in plan order. */
  packages: PackageView[];
  /** Status of each package operation asked for, by operation key. */
  packageOps: Record<string, PlatformOpStatus>;
  /** The frozen base commit; null without a repository. */
  baseCommit: string | null;
  /** The integration worktree's head as last recorded; null without a repository. */
  integrationHead: string | null;
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
  | { type: 'record_plan'; version: number; round: number; source: PlanSource; dispatchId: string | null }
  | { type: 'pin_plan'; planId: string }
  | {
      type: 'package_op';
      kind: PackageOpKind;
      packageKey: string;
      opKey: string;
      /** Where a package branch starts; set for branch_package only. */
      startCommit?: string;
    }
  | { type: 'transition'; from: WorkshopPhase | null; to: WorkshopPhase; cycle: number; round: number; cause: Record<string, unknown> }
  | { type: 'stop'; reason: string };

const UNFINISHED: readonly DispatchStatus[] = ['pending', 'running'];
const SETTLED_OK: readonly DispatchStatus[] = ['reported', 'skipped'];

export function questionsKey(cycle: number): string {
  return `questions:explore:${cycle}`;
}

export function planDisputeKey(cycle: number): string {
  return `plan_dispute:${cycle}`;
}

/** A build failure is per package: one owner builds several packages, each from round 0. */
export function memberFailedKey(phase: WorkshopPhase, cycle: number, round: number, agentId: string, packageKey = ''): string {
  return `member_failed:${phase}:${cycle}:${round}:${agentId}${packageKey ? `:${packageKey}` : ''}`;
}

/** One operation of each kind per package attempt and cycle. */
export function packageOpKey(kind: PackageOpKind, cycle: number, pkg: Pick<PackageView, 'key' | 'attempt'>): string {
  return `${kind}:${cycle}:${pkg.attempt}:${pkg.key}`;
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
  // Platform phases (check, approval, merge) arrive with their steps.
  if (!spec) return [];
  if (state.phase === 'build') return decideBuild(state, spec, settings);
  return decideAgentPhase(state, spec, settings);
}

/** Solo has no plan phase: its one member builds the brief as a single package. */
function decideBrief(state: WorkshopState): Action[] {
  if (!state.snapshotFrozen) return [{ type: 'freeze_snapshot' }];
  if (state.hasRepository && state.worktrees === 'absent') return [{ type: 'prepare_worktrees' }];
  // Their operations report back when they settle; nothing to do until then.
  if (state.hasRepository && state.worktrees !== 'ready') return [];
  if (state.playbook === 'build') return [transition(state, 'explore', 0, { brief: 'ready' })];
  const plan = plansInCycle(state)[0];
  if (!plan) return [{ type: 'record_plan', version: 1, round: 0, source: 'solo', dispatchId: null }];
  return pinAndBuild(state, plan, { brief: 'ready', plan: plan.version, source: plan.source });
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

/** A participant's latest dispatch in the current phase instance, for one package in Build. */
function slotOf(state: WorkshopState, spec: AgentPhaseSpec, agentId: string, packageKey = ''): DispatchView | undefined {
  let latest: DispatchView | undefined;
  for (const d of state.dispatches) {
    if (d.phase !== state.phase || d.purpose !== spec.purpose || d.agentId !== agentId || d.packageKey !== packageKey) continue;
    if (d.cycle !== state.cycle || d.round < state.round) continue;
    if (!latest || d.round > latest.round) latest = d;
  }
  return latest;
}

function noReportsInInstance(state: WorkshopState, spec: AgentPhaseSpec, agentId: string, packageKey = ''): number {
  return state.dispatches.filter(
    (d) =>
      d.phase === state.phase &&
      d.purpose === spec.purpose &&
      d.agentId === agentId &&
      d.packageKey === packageKey &&
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
  let leadGaveUp = false;

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
    // A lead who gave no acceptable plan, asked twice, has not failed: the plan degrades or goes to a person.
    if (spec.purpose === 'plan' && slot.status === 'no_report' && noReportsInInstance(state, spec, agentId) > 1) {
      leadGaveUp = true;
      continue;
    }
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

  if (allSettled) actions.push(...exitAgentPhase(state, spec, settings, leadGaveUp));
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
function exitAgentPhase(
  state: WorkshopState,
  spec: AgentPhaseSpec,
  settings: EngineSettings,
  leadGaveUp: boolean
): Action[] {
  switch (state.phase) {
    case 'explore':
      return exitExplore(state, spec, settings);
    case 'plan':
      return exitPlan(state, spec, leadGaveUp);
    case 'plan_review':
      return exitPlanReview(state, spec);
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

function plansInCycle(state: WorkshopState): PlanView[] {
  return state.plans.filter((p) => p.cycle === state.cycle).sort((a, b) => a.version - b.version);
}

/** A round above every round used in the cycle, so a phase entered again never reuses a dispatch key. */
function nextRound(state: WorkshopState): number {
  return Math.max(state.round, ...state.dispatches.filter((d) => d.cycle === state.cycle).map((d) => d.round)) + 1;
}

const othersLeft = (state: WorkshopState) => state.members.some((m) => !m.skipped && m.agentId !== state.leadAgentId);

/**
 * Plan records the lead's plan as the next version, then sends it to the
 * other members for review, or straight to Build when none are left. A lead
 * who gave no acceptable plan after being asked again gets one package for
 * the whole task (degraded) the first time; during a revision, the plan as
 * it stands goes to a person.
 */
function exitPlan(state: WorkshopState, spec: AgentPhaseSpec, leadGaveUp: boolean): Action[] {
  const versions = plansInCycle(state);
  const recorded = versions.find((p) => p.round === state.round);
  if (!recorded) {
    const slot = slotOf(state, spec, state.leadAgentId);
    if (slot?.status === 'reported') {
      return [{ type: 'record_plan', version: versions.length + 1, round: state.round, source: 'lead', dispatchId: slot.id }];
    }
    if (!leadGaveUp) return [];
    if (versions.length === 0) {
      return [{ type: 'record_plan', version: 1, round: state.round, source: 'degraded', dispatchId: null }];
    }
    return decidePlanDispute(state, versions.at(-1)!);
  }
  const cause = { settled: 'plan', plan: recorded.version, source: recorded.source };
  if (!othersLeft(state)) return pinAndBuild(state, recorded, cause);
  return [transition(state, 'plan_review', versions.length > 1 ? nextRound(state) : 0, cause)];
}

/** Every reviewer approves: the plan goes ahead. Objections get one revision, then a person decides. */
function exitPlanReview(state: WorkshopState, spec: AgentPhaseSpec): Action[] {
  const versions = plansInCycle(state);
  const latest = versions.at(-1);
  if (!latest) return [];
  const objections = participantsOf(state, spec).filter((agentId) => {
    const slot = slotOf(state, spec, agentId);
    return slot?.status === 'reported' && slot.report?.verdict === 'object';
  }).length;
  if (objections === 0) return pinAndBuild(state, latest, { settled: 'plan_review', plan: latest.version });
  if (versions.length < 2) {
    return [transition(state, 'plan', nextRound(state), { settled: 'plan_review', plan: latest.version, objections })];
  }
  return decidePlanDispute(state, latest);
}

function decidePlanDispute(state: WorkshopState, plan: PlanView): Action[] {
  const key = planDisputeKey(state.cycle);
  const request = requestFor(state, key);
  if (!request) {
    return [
      {
        type: 'open_request',
        kind: 'plan_dispute',
        dedupeKey: key,
        payload: { cycle: state.cycle, planId: plan.id, version: plan.version },
        choices: ['proceed', 'stop'],
      },
    ];
  }
  if (request.status !== 'answered') return [];
  const choice = choiceOf(request);
  if (choice === 'proceed') {
    return pinAndBuild(state, plan, { settled: state.phase, plan: plan.version, dispute: request.id });
  }
  return choice === 'stop' ? [{ type: 'stop', reason: 'Stopped over a disputed plan' }] : [];
}

function pinAndBuild(state: WorkshopState, plan: PlanView, cause: Record<string, unknown>): Action[] {
  return [...(state.planPinned ? [] : [{ type: 'pin_plan' as const, planId: plan.id }]), transition(state, 'build', 0, cause)];
}

/**
 * Build schedules the pinned plan's packages. A package starts once every
 * package it depends on is in; an owner builds one package at a time, and
 * different owners build side by side up to the parallelism. On a repository
 * a package is branched in its owner's worktree (from the base, or from the
 * integration head once its dependencies are merged), built, checkpointed,
 * and merged into the integration branch; without one, it is in once its
 * owner reports. Build ends in Check when every package is in.
 */
function decideBuild(state: WorkshopState, spec: AgentPhaseSpec, settings: EngineSettings): Action[] {
  // A pinned plan always has packages; with none there is nothing to schedule.
  if (state.packages.length === 0) return [];
  const actions: Action[] = [];
  const onRepository = state.hasRepository;
  let unfinished = state.dispatches.filter((d) => UNFINISHED.includes(d.status)).length;
  const byKey = new Map(state.packages.map((p) => [p.key, p]));
  const slot = (p: PackageView) => (p.ownerAgentId ? slotOf(state, spec, p.ownerAgentId, p.key) : undefined);
  const opOf = (kind: PackageOpKind, p: PackageView) => state.packageOps[packageOpKey(kind, state.cycle, p)];
  const isIn = (p: PackageView) => (onRepository ? p.status === 'integrated' : slot(p)?.status === 'reported');
  // The owner's worktree is taken from the package's branch until its checkpoint.
  const holdsOwner = (p: PackageView) =>
    onRepository
      ? p.status === 'branched' || (p.status === 'pending' && opOf('branch_package', p) !== undefined)
      : slot(p) !== undefined && !isIn(p);
  const busy = new Set(state.packages.filter(holdsOwner).map((p) => p.ownerAgentId));
  const canStart = (p: PackageView) =>
    !busy.has(p.ownerAgentId) &&
    p.dependsOn.every((key) => {
      const dep = byKey.get(key);
      return dep !== undefined && isIn(dep);
    });

  const dispatchAt = (p: PackageView, round: number) => {
    if (unfinished >= state.parallelism) return;
    unfinished += 1;
    actions.push({
      type: 'dispatch',
      phase: 'build',
      purpose: spec.purpose,
      agentId: p.ownerAgentId!,
      packageKey: p.key,
      cycle: state.cycle,
      round,
      readOnly: false,
      timeoutMs: settings.writeTimeoutMs,
    });
  };
  const packageOp = (kind: PackageOpKind, p: PackageView, startCommit?: string) =>
    actions.push({
      type: 'package_op',
      kind,
      packageKey: p.key,
      opKey: packageOpKey(kind, state.cycle, p),
      ...(startCommit ? { startCommit } : {}),
    });

  for (const p of state.packages) {
    if (isIn(p)) continue;
    const owner = p.ownerAgentId;
    // TODO(workshop): open package_blocked for a package whose owner was deleted.
    if (!owner) continue;
    if (onRepository && p.status === 'built') {
      if (!opOf('integrate', p)) packageOp('integrate', p);
      continue;
    }
    if (onRepository && p.status === 'pending') {
      // A branch operation in flight, or failed and waiting on a person, is left to settle.
      if (opOf('branch_package', p) || !canStart(p)) continue;
      busy.add(owner);
      packageOp('branch_package', p, startOf(state, p));
      continue;
    }

    const s = slot(p);
    if (!s) {
      if (!onRepository) {
        if (!canStart(p)) continue;
        busy.add(owner);
      }
      dispatchAt(p, state.round);
      continue;
    }
    if (s.status === 'reported') {
      if (!opOf('checkpoint', p)) packageOp('checkpoint', p);
      continue;
    }
    if (UNFINISHED.includes(s.status)) {
      actions.push(...clockActions(state, s));
      continue;
    }
    // no_report, failed, or cancelled without a report
    if (s.status === 'no_report' && noReportsInInstance(state, spec, owner, p.key) === 1) {
      dispatchAt(p, s.round + 1);
      continue;
    }
    const key = memberFailedKey('build', state.cycle, s.round, owner, p.key);
    const request = requestFor(state, key);
    if (!request) {
      actions.push({
        type: 'open_request',
        kind: 'member_failed',
        dedupeKey: key,
        payload: { phase: 'build', agentId: owner, packageKey: p.key, dispatchId: s.id, outcome: s.status },
        choices: ['retry', 'stop'],
      });
      continue;
    }
    if (request.status !== 'answered') continue;
    const choice = choiceOf(request);
    if (choice === 'retry') dispatchAt(p, s.round + 1);
    else if (choice === 'stop') return [{ type: 'stop', reason: `Stopped after ${owner} failed to build ${p.key}` }];
  }

  if (state.packages.every(isIn)) {
    actions.push(transition(state, 'check', 0, { settled: 'build', packages: state.packages.length }));
  }
  return actions;
}

/** A package without dependencies starts from the base; one with dependencies from the integration head they were merged into. */
function startOf(state: WorkshopState, p: PackageView): string {
  const start = p.dependsOn.length === 0 ? state.baseCommit : state.integrationHead;
  if (!start) throw new Error(`Package "${p.key}" has no commit to start from`);
  return start;
}
