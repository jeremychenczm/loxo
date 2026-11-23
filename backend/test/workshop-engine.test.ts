import { describe, expect, it } from 'vitest';
import {
  decide,
  elapsedMs,
  memberFailedKey,
  planDisputeKey,
  questionsKey,
  type Action,
  type DispatchView,
  type EngineSettings,
  type PackageView,
  type WorkshopState,
} from '../src/modules/workshop/engine';
import type { WorkPackageStatus } from '../src/db/schema';

/**
 * Table-style tests for the pure decision function. A small in-memory
 * applier plays the role of the advancing transaction, so each test can walk
 * a workshop forward and check that deciding again on the result adds
 * nothing new.
 */
const settings: EngineSettings = { readOnlyTimeoutMs: 600_000, writeTimeoutMs: 3_600_000, questionsTtlMs: 1_800_000 };
const LEAD = 'agent-lead';
const PEER = 'agent-peer';
const THIRD = 'agent-third';

function workshop(overrides: Partial<WorkshopState> = {}): WorkshopState {
  return {
    taskId: 'task-1',
    playbook: 'build',
    phase: 'explore',
    cycle: 0,
    round: 0,
    leadAgentId: LEAD,
    members: [LEAD, PEER, THIRD].map((agentId) => ({ agentId, skipped: false })),
    parallelism: 4,
    snapshotFrozen: true,
    worktrees: 'absent',
    hasRepository: false,
    dispatches: [],
    requests: [],
    plans: [],
    planPinned: false,
    packages: [],
    packageOps: {},
    baseCommit: null,
    integrationHead: null,
    nowMs: 1_000_000,
    ...overrides,
  };
}

let nextId = 0;

/** Applies actions the way the advancing transaction does, without a database. */
function apply(state: WorkshopState, actions: Action[]): WorkshopState {
  const s: WorkshopState = structuredClone(state);
  for (const a of actions) {
    switch (a.type) {
      case 'freeze_snapshot':
        s.snapshotFrozen = true;
        break;
      case 'prepare_worktrees':
        s.worktrees = 'preparing';
        break;
      case 'dispatch':
        s.dispatches.push({
          id: `d${++nextId}`,
          phase: a.phase,
          purpose: a.purpose,
          packageKey: a.packageKey,
          cycle: a.cycle,
          round: a.round,
          agentId: a.agentId,
          status: 'pending',
          report: null,
          startedAtMs: null,
          pausedAtMs: null,
          elapsedMs: 0,
          timeoutMs: a.timeoutMs,
          cancelRequested: false,
          waitingOnPerson: false,
        });
        break;
      case 'cancel_dispatch':
        edit(s, a.dispatchId, { cancelRequested: true });
        break;
      case 'pause_dispatch': {
        const d = s.dispatches.find((x) => x.id === a.dispatchId)!;
        edit(s, a.dispatchId, { elapsedMs: elapsedMs(d, s.nowMs), startedAtMs: null, pausedAtMs: s.nowMs });
        break;
      }
      case 'resume_dispatch':
        edit(s, a.dispatchId, { pausedAtMs: null, startedAtMs: s.nowMs });
        break;
      case 'open_request':
        s.requests.push({
          id: `r${++nextId}`,
          kind: a.kind,
          dedupeKey: a.dedupeKey,
          status: 'open',
          answer: null,
          expiresAtMs: a.ttlMs === undefined ? null : s.nowMs + a.ttlMs,
        });
        break;
      case 'expire_request':
        s.requests = s.requests.map((r) => (r.id === a.requestId && r.status === 'open' ? { ...r, status: 'expired' } : r));
        break;
      case 'record_plan':
        s.plans.push({
          id: `p${++nextId}`,
          cycle: s.cycle,
          version: a.version,
          round: a.round,
          source: a.source,
          dispatchId: a.dispatchId,
        });
        break;
      case 'pin_plan':
        s.planPinned = true;
        break;
      case 'package_op':
        s.packageOps[a.opKey] = 'wanted';
        break;
      case 'skip_member':
        s.members = s.members.map((m) => (m.agentId === a.agentId ? { ...m, skipped: true } : m));
        break;
      case 'cleanup_worktrees':
        s.worktrees = 'cleaning';
        break;
      case 'transition':
        s.phase = a.to;
        s.cycle = a.cycle;
        s.round = a.round;
        break;
      case 'stop':
        s.phase = 'stopped';
        break;
    }
  }
  return s;
}

function edit(s: WorkshopState, id: string, patch: Partial<DispatchView>): void {
  s.dispatches = s.dispatches.map((d) => (d.id === id ? { ...d, ...patch } : d));
}

/** Decides, applies, and checks that deciding again on the result adds nothing new. */
function step(state: WorkshopState): { actions: Action[]; next: WorkshopState } {
  const actions = decide(state, settings);
  const next = apply(state, actions);
  const again = decide(next, settings).filter((a) => a.type !== 'transition' || next.phase === state.phase);
  const repeated = again.filter((a) => actions.some((b) => JSON.stringify(stripId(a)) === JSON.stringify(stripId(b))));
  expect(repeated).toEqual([]);
  return { actions, next };
}

function stripId(a: Action): unknown {
  return a.type === 'dispatch' ? { ...a } : a;
}

function dispatchOf(s: WorkshopState, agentId: string, phase = s.phase): DispatchView {
  const found = s.dispatches.filter((d) => d.agentId === agentId && d.phase === phase).at(-1);
  if (!found) throw new Error(`no dispatch for ${agentId} in ${phase}`);
  return found;
}

function settle(s: WorkshopState, agentId: string, patch: Partial<DispatchView>): WorkshopState {
  const d = dispatchOf(s, agentId);
  const next = structuredClone(s);
  edit(next, d.id, patch);
  return next;
}

const reported = (report: Record<string, unknown> = { ok: true }) => ({ status: 'reported' as const, report });
const running = (startedAtMs: number) => ({ status: 'running' as const, startedAtMs });
const approve = reported({ verdict: 'approve', comments: '' });
const object = (comments: string) => reported({ verdict: 'object', comments });

function answer(s: WorkshopState, dedupeKey: string, choice: string): WorkshopState {
  const next = structuredClone(s);
  next.requests = next.requests.map((r) =>
    r.dedupeKey === dedupeKey ? { ...r, status: 'answered' as const, answer: { choice } } : r
  );
  return next;
}

const BASE = 'b'.repeat(40);

function pkg(key: string, ownerAgentId: string, dependsOn: string[] = [], status: WorkPackageStatus = 'pending'): PackageView {
  return { key, ownerAgentId, dependsOn, status, attempt: 0 };
}

/** Build on a repository, with the plan pinned and the integration branch still at base. */
function building(packages: PackageView[], overrides: Partial<WorkshopState> = {}): WorkshopState {
  return workshop({
    phase: 'build',
    planPinned: true,
    packages,
    hasRepository: true,
    worktrees: 'ready',
    baseCommit: BASE,
    integrationHead: BASE,
    ...overrides,
  });
}

/** The platform finishes an operation: its package moves on, and a merge moves the integration head. */
function opDone(s: WorkshopState, opKey: string, status: WorkPackageStatus, integrationHead?: string): WorkshopState {
  expect(s.packageOps[opKey]).toBe('wanted');
  const next = structuredClone(s);
  next.packageOps[opKey] = 'done';
  const key = opKey.split(':').at(-1);
  next.packages = next.packages.map((p) => (p.key === key ? { ...p, status } : p));
  if (integrationHead) next.integrationHead = integrationHead;
  return next;
}

function settlePackage(s: WorkshopState, key: string, patch: Partial<DispatchView>): WorkshopState {
  const d = s.dispatches.filter((x) => x.packageKey === key).at(-1);
  if (!d) throw new Error(`no dispatch for package ${key}`);
  const next = structuredClone(s);
  edit(next, d.id, patch);
  return next;
}

const branchOp = (key: string, startCommit: string) => ({
  type: 'package_op',
  kind: 'branch_package',
  packageKey: key,
  opKey: `branch_package:0:0:${key}`,
  startCommit,
});
const checkpointOp = (key: string) => ({ type: 'package_op', kind: 'checkpoint', packageKey: key, opKey: `checkpoint:0:0:${key}` });
const integrateOp = (key: string) => ({ type: 'package_op', kind: 'integrate', packageKey: key, opKey: `integrate:0:0:${key}` });
const buildOf = (agentId: string, key: string, round = 0) =>
  expect.objectContaining({ type: 'dispatch', phase: 'build', purpose: 'build', agentId, packageKey: key, round, readOnly: false });

/** A branched package's build reported, then checkpointed and merged. */
function buildAndMerge(s: WorkshopState, key: string, integrationHead: string): WorkshopState {
  let next = settlePackage(s, key, reported({ summary: `Built ${key}` }));
  next = opDone(step(next).next, `checkpoint:0:0:${key}`, 'built');
  return opDone(step(next).next, `integrate:0:0:${key}`, 'integrated', integrationHead);
}

describe('workshop engine: build', () => {
  it('branches packages of different owners from base at once, builds them side by side, then checkpoints and merges each', () => {
    let r = step(building([pkg('api', LEAD), pkg('ui', PEER)]));
    expect(r.actions).toEqual([branchOp('api', BASE), branchOp('ui', BASE)]);
    // Nothing more until the branches exist.
    expect(decide(r.next, settings)).toEqual([]);
    let s = opDone(opDone(r.next, 'branch_package:0:0:api', 'branched'), 'branch_package:0:0:ui', 'branched');
    r = step(s);
    expect(r.actions).toEqual([buildOf(LEAD, 'api'), buildOf(PEER, 'ui')]);
    expect(r.actions[0]).toMatchObject({ timeoutMs: 3_600_000 });

    s = settlePackage(r.next, 'api', reported());
    r = step(s);
    expect(r.actions).toEqual([checkpointOp('api')]);
    s = opDone(r.next, 'checkpoint:0:0:api', 'built');
    r = step(s);
    expect(r.actions).toEqual([integrateOp('api')]);
    s = opDone(r.next, 'integrate:0:0:api', 'integrated', 'i1');
    // ui is still being built.
    expect(decide(s, settings)).toEqual([]);

    s = buildAndMerge(s, 'ui', 'i2');
    r = step(s);
    expect(r.actions).toEqual([
      { type: 'transition', from: 'build', to: 'check', cycle: 0, round: 0, cause: { settled: 'build', packages: 2 } },
    ]);
  });

  it('gives an owner one package at a time: the next is branched once the last is checkpointed', () => {
    let r = step(building([pkg('api', LEAD), pkg('docs', LEAD), pkg('ui', PEER)]));
    expect(r.actions).toEqual([branchOp('api', BASE), branchOp('ui', BASE)]);
    let s = opDone(r.next, 'branch_package:0:0:api', 'branched');
    r = step(s);
    expect(r.actions).toEqual([buildOf(LEAD, 'api')]);
    s = settlePackage(r.next, 'api', reported());
    r = step(s);
    expect(r.actions).toEqual([checkpointOp('api')]);
    s = opDone(r.next, 'checkpoint:0:0:api', 'built');
    r = step(s);
    expect(r.actions).toEqual([integrateOp('api'), branchOp('docs', BASE)]);
  });

  it('starts a dependent package from the integration head once its dependencies are merged', () => {
    let r = step(building([pkg('api', LEAD), pkg('ui', PEER, ['api'])]));
    expect(r.actions).toEqual([branchOp('api', BASE)]);
    let s = opDone(r.next, 'branch_package:0:0:api', 'branched');
    s = step(s).next;
    s = settlePackage(s, 'api', reported());
    s = opDone(step(s).next, 'checkpoint:0:0:api', 'built');
    r = step(s);
    // Built but not merged yet: ui still waits.
    expect(r.actions).toEqual([integrateOp('api')]);
    s = opDone(r.next, 'integrate:0:0:api', 'integrated', 'i1');
    r = step(s);
    expect(r.actions).toEqual([branchOp('ui', 'i1')]);
  });

  it('leaves a package whose operation failed to the person asked about it', () => {
    const s = building([pkg('api', LEAD), pkg('docs', LEAD)], { packageOps: { 'branch_package:0:0:api': 'failed' } });
    // api waits on the person; docs waits for its owner's worktree.
    expect(decide(s, settings)).toEqual([]);
    const built = building([pkg('api', LEAD, [], 'built')], { packageOps: { 'integrate:0:0:api': 'failed' } });
    expect(decide(built, settings)).toEqual([]);
  });

  it('without a repository, sends packages to their owners in order and counts one in once reported', () => {
    const s = workshop({ phase: 'build', planPinned: true, packages: [pkg('api', LEAD), pkg('docs', LEAD), pkg('ui', PEER, ['api'])] });
    let r = step(s);
    expect(r.actions).toEqual([buildOf(LEAD, 'api')]);
    r = step(settlePackage(r.next, 'api', reported()));
    expect(r.actions).toEqual([buildOf(LEAD, 'docs'), buildOf(PEER, 'ui')]);
    r = step(settlePackage(settlePackage(r.next, 'docs', reported()), 'ui', reported()));
    expect(r.actions).toEqual([
      { type: 'transition', from: 'build', to: 'check', cycle: 0, round: 0, cause: { settled: 'build', packages: 3 } },
    ]);
  });

  it('keeps builds within the parallelism', () => {
    const s = workshop({ phase: 'build', planPinned: true, parallelism: 1, packages: [pkg('api', LEAD), pkg('ui', PEER)] });
    const r = step(s);
    expect(r.actions).toEqual([buildOf(LEAD, 'api')]);
    expect(step(settlePackage(r.next, 'api', reported())).actions).toEqual([buildOf(PEER, 'ui')]);
  });

  it('asks once more when a build gives no report, then asks a person about that package', () => {
    let r = step(building([pkg('api', LEAD, [], 'branched')]));
    expect(r.actions).toEqual([buildOf(LEAD, 'api')]);
    r = step(settlePackage(r.next, 'api', { status: 'no_report' }));
    expect(r.actions).toEqual([buildOf(LEAD, 'api', 1)]);
    r = step(settlePackage(r.next, 'api', { status: 'no_report' }));
    const key = memberFailedKey('build', 0, 1, LEAD, 'api');
    expect(r.actions).toEqual([
      {
        type: 'open_request',
        kind: 'member_failed',
        dedupeKey: key,
        payload: { phase: 'build', agentId: LEAD, packageKey: 'api', dispatchId: r.next.dispatches[1]!.id, outcome: 'no_report' },
        choices: ['retry', 'stop'],
      },
    ]);
    expect(decide(r.next, settings)).toEqual([]);
    r = step(answer(r.next, key, 'retry'));
    expect(r.actions).toEqual([buildOf(LEAD, 'api', 2)]);
    r = step(settlePackage(r.next, 'api', { status: 'failed' }));
    const again = memberFailedKey('build', 0, 2, LEAD, 'api');
    expect(r.actions).toMatchObject([{ type: 'open_request', dedupeKey: again }]);
    expect(decide(answer(r.next, again, 'stop'), settings)).toEqual([
      { type: 'stop', reason: `Stopped after ${LEAD} failed to build api` },
    ]);
  });

  it('asks about each package of an owner on its own, not reusing an answer about another', () => {
    let r = step(workshop({ phase: 'build', planPinned: true, packages: [pkg('api', LEAD), pkg('docs', LEAD)] }));
    r = step(settlePackage(r.next, 'api', { status: 'failed' }));
    const apiKey = memberFailedKey('build', 0, 0, LEAD, 'api');
    expect(r.actions).toMatchObject([{ type: 'open_request', dedupeKey: apiKey }]);
    r = step(answer(r.next, apiKey, 'retry'));
    r = step(settlePackage(r.next, 'api', reported()));
    expect(r.actions).toEqual([buildOf(LEAD, 'docs')]);
    r = step(settlePackage(r.next, 'docs', { status: 'failed' }));
    expect(r.actions).toMatchObject([{ type: 'open_request', dedupeKey: memberFailedKey('build', 0, 0, LEAD, 'docs') }]);
  });

  it('cancels a build that runs out of time', () => {
    const r = step(building([pkg('api', LEAD, [], 'branched')]));
    const s = { ...settlePackage(r.next, 'api', running(1_000)), nowMs: 1_000 + 3_600_001 };
    expect(decide(s, settings)).toEqual([{ type: 'cancel_dispatch', dispatchId: r.next.dispatches[0]!.id, reason: 'timeout' }]);
  });
});

describe('workshop engine: lifecycle', () => {
  it('does nothing before the workshop starts or after it ends', () => {
    expect(decide(workshop({ phase: null }), settings)).toEqual([]);
    expect(decide(workshop({ phase: 'done' }), settings)).toEqual([]);
    expect(decide(workshop({ phase: 'stopped' }), settings)).toEqual([]);
  });

  it('freezes the snapshot, prepares worktrees, then moves a build workshop to explore', () => {
    let s = workshop({ phase: 'brief', snapshotFrozen: false, hasRepository: true });
    let r = step(s);
    expect(r.actions).toEqual([{ type: 'freeze_snapshot' }]);
    r = step(r.next);
    expect(r.actions).toEqual([{ type: 'prepare_worktrees' }]);
    // The operations are running: nothing to do until they settle.
    expect(decide(r.next, settings)).toEqual([]);
    r = step({ ...r.next, worktrees: 'ready' });
    expect(r.actions).toEqual([
      { type: 'transition', from: 'brief', to: 'explore', cycle: 0, round: 0, cause: { brief: 'ready' } },
    ]);
    s = r.next;
    expect(s.phase).toBe('explore');
  });

  it('asks to remove the worktrees once a workshop on a repository ends, and only once', () => {
    const ended = workshop({ phase: 'stopped', hasRepository: true, worktrees: 'ready' });
    expect(decide(ended, settings)).toEqual([{ type: 'cleanup_worktrees' }]);
    expect(decide({ ...ended, worktrees: 'cleaning' }, settings)).toEqual([]);
    expect(decide({ ...ended, phase: 'done', worktrees: 'cleaned' }, settings)).toEqual([]);
  });

  it('sends a solo workshop from brief to build with one package for its member, without a plan phase', () => {
    const s = workshop({ phase: 'brief', playbook: 'solo', members: [{ agentId: LEAD, skipped: false }] });
    let r = step(s);
    expect(r.actions).toEqual([{ type: 'record_plan', version: 1, round: 0, source: 'solo', dispatchId: null }]);
    r = step(r.next);
    expect(r.actions).toMatchObject([
      { type: 'pin_plan', planId: r.next.plans[0]!.id },
      { type: 'transition', from: 'brief', to: 'build', cause: { brief: 'ready', plan: 1, source: 'solo' } },
    ]);
    // Pinning writes the plan's one package.
    const build = step({ ...r.next, packages: [pkg('main', LEAD)] });
    expect(build.actions).toEqual([
      expect.objectContaining({ type: 'dispatch', purpose: 'build', agentId: LEAD, packageKey: 'main', readOnly: false, timeoutMs: 3_600_000 }),
    ]);
  });
});

describe('workshop engine: an agent phase', () => {
  it('asks every member to explore at once, read-only', () => {
    const r = step(workshop());
    expect(r.actions).toEqual(
      [LEAD, PEER, THIRD].map((agentId) =>
        expect.objectContaining({ type: 'dispatch', phase: 'explore', purpose: 'explore', agentId, round: 0, readOnly: true })
      )
    );
  });

  it('keeps unfinished dispatches within the parallelism bound', () => {
    let r = step(workshop({ parallelism: 2 }));
    expect(r.actions.map((a) => a.type === 'dispatch' && a.agentId)).toEqual([LEAD, PEER]);
    let s = settle(r.next, LEAD, reported());
    r = step(s);
    expect(r.actions).toEqual([expect.objectContaining({ type: 'dispatch', agentId: THIRD })]);
    s = r.next;
  });

  it('moves on only when every member has reported or been skipped', () => {
    let s = step(workshop()).next;
    s = settle(s, LEAD, reported());
    s = settle(s, PEER, reported());
    expect(decide(s, settings)).toEqual([]);
    s = settle(s, THIRD, { status: 'skipped' });
    const r = step(s);
    expect(r.actions).toEqual([
      { type: 'transition', from: 'explore', to: 'plan', cycle: 0, round: 0, cause: { settled: 'explore' } },
    ]);
  });

  it('runs plan with the lead, plan review with the others, then build', () => {
    let s = workshop({ phase: 'plan' });
    let r = step(s);
    expect(r.actions).toEqual([expect.objectContaining({ type: 'dispatch', purpose: 'plan', agentId: LEAD })]);
    s = settle(r.next, LEAD, reported({ plan: 'x' }));
    r = step(s);
    expect(r.actions).toMatchObject([{ type: 'record_plan', version: 1, source: 'lead' }]);
    r = step(r.next);
    expect(r.actions).toMatchObject([{ type: 'transition', to: 'plan_review' }]);
    r = step(r.next);
    expect(r.actions.map((a) => a.type === 'dispatch' && a.agentId)).toEqual([PEER, THIRD]);
    s = settle(settle(r.next, PEER, approve), THIRD, approve);
    expect(step(s).actions).toMatchObject([{ type: 'pin_plan' }, { type: 'transition', to: 'build' }]);
  });

  it('skips plan review when every other member has been skipped', () => {
    const members = [
      { agentId: LEAD, skipped: false },
      { agentId: PEER, skipped: true },
    ];
    let s = step(workshop({ phase: 'plan', members })).next;
    s = settle(s, LEAD, reported());
    s = step(s).next; // records the plan
    expect(step(s).actions).toMatchObject([{ type: 'pin_plan' }, { type: 'transition', to: 'build' }]);
  });

  it('leaves skipped members out of later phases', () => {
    const members = [
      { agentId: LEAD, skipped: false },
      { agentId: PEER, skipped: true },
      { agentId: THIRD, skipped: false },
    ];
    const r = step(workshop({ phase: 'plan_review', members }));
    expect(r.actions.map((a) => a.type === 'dispatch' && a.agentId)).toEqual([THIRD]);
  });
});

describe('workshop engine: plan and plan review', () => {
  /** Plan with the lead's first plan recorded and sent to review, reviewers dispatched. */
  function inReview(): WorkshopState {
    let s = step(workshop({ phase: 'plan' })).next;
    s = step(settle(s, LEAD, reported({ summary: 'v1' }))).next; // record v1
    s = step(s).next; // to plan review
    return step(s).next; // reviewers dispatched
  }
  const usedRounds = (s: WorkshopState) => s.dispatches.map((d) => d.round);

  it('gives objections one revision in a fresh round, and reviews the revised plan again', () => {
    let s = settle(settle(inReview(), PEER, object('Split the API out.')), THIRD, approve);
    let r = step(s);
    const revision = r.actions[0] as Extract<Action, { type: 'transition' }>;
    expect(revision).toMatchObject({ type: 'transition', from: 'plan_review', to: 'plan', cause: { objections: 1, plan: 1 } });
    expect(revision.round).toBeGreaterThan(Math.max(...usedRounds(s)));

    r = step(r.next);
    expect(r.actions).toEqual([expect.objectContaining({ type: 'dispatch', purpose: 'plan', agentId: LEAD, round: revision.round })]);
    r = step(settle(r.next, LEAD, reported({ summary: 'v2' })));
    expect(r.actions).toEqual([{ type: 'record_plan', version: 2, round: revision.round, source: 'lead', dispatchId: expect.any(String) }]);
    r = step(r.next);
    const secondReview = r.actions[0] as Extract<Action, { type: 'transition' }>;
    expect(secondReview).toMatchObject({ to: 'plan_review', cause: { plan: 2 } });
    expect(secondReview.round).toBeGreaterThan(revision.round);

    r = step(r.next);
    expect(r.actions.map((a) => a.type === 'dispatch' && [a.agentId, a.round])).toEqual([
      [PEER, secondReview.round],
      [THIRD, secondReview.round],
    ]);
    s = settle(settle(r.next, PEER, approve), THIRD, approve);
    const v2 = s.plans.find((p) => p.version === 2)!;
    expect(step(s).actions).toEqual([
      { type: 'pin_plan', planId: v2.id },
      { type: 'transition', from: 'plan_review', to: 'build', cycle: 0, round: 0, cause: { settled: 'plan_review', plan: 2 } },
    ]);
  });

  it('starts the revision above every round used, even after the lead was asked again in the first round', () => {
    let s = step(workshop({ phase: 'plan' })).next;
    s = step(settle(s, LEAD, { status: 'no_report' })).next; // asked again at round 1
    s = step(settle(s, LEAD, reported({ summary: 'v1' }))).next; // record v1
    s = step(s).next; // to plan review
    s = step(s).next; // reviewers dispatched
    expect(Math.max(...s.dispatches.map((d) => d.round))).toBe(1);
    let r = step(settle(settle(s, PEER, object('No.')), THIRD, approve));
    const revision = r.actions[0] as Extract<Action, { type: 'transition' }>;
    expect(revision.round).toBe(2);
    r = step(r.next);
    // A plan dispatch at round 1 already exists; the revision's must not reuse its key.
    expect(r.actions).toEqual([expect.objectContaining({ type: 'dispatch', purpose: 'plan', round: 2 })]);
  });

  /** The revised plan, objected to again. */
  function disputed(): WorkshopState {
    let s = step(settle(settle(inReview(), PEER, object('Split the API out.')), THIRD, approve)).next; // to plan
    s = step(s).next; // lead dispatched
    s = step(settle(s, LEAD, reported({ summary: 'v2' }))).next; // record v2
    s = step(s).next; // to plan review
    s = step(s).next; // reviewers dispatched
    return settle(settle(s, PEER, approve), THIRD, object('Still too big.'));
  }

  it('puts a plan still objected to after its revision to a person', () => {
    const r = step(disputed());
    const v2 = r.next.plans.find((p) => p.version === 2)!;
    expect(r.actions).toEqual([
      {
        type: 'open_request',
        kind: 'plan_dispute',
        dedupeKey: planDisputeKey(0),
        payload: { cycle: 0, planId: v2.id, version: 2 },
        choices: ['proceed', 'stop'],
      },
    ]);
    expect(decide(r.next, settings)).toEqual([]);

    const proceed = step(answer(r.next, planDisputeKey(0), 'proceed'));
    expect(proceed.actions).toMatchObject([
      { type: 'pin_plan', planId: v2.id },
      { type: 'transition', to: 'build', cause: { dispute: r.next.requests[0]!.id, plan: 2 } },
    ]);
    expect(step(answer(r.next, planDisputeKey(0), 'stop')).actions).toEqual([
      { type: 'stop', reason: 'Stopped over a disputed plan' },
    ]);
  });

  it('asks a lead with no acceptable plan once more, then degrades the plan to one package', () => {
    let s = step(workshop({ phase: 'plan' })).next;
    let r = step(settle(s, LEAD, { status: 'no_report' }));
    expect(r.actions).toEqual([expect.objectContaining({ type: 'dispatch', purpose: 'plan', agentId: LEAD, round: 1 })]);
    s = settle(r.next, LEAD, { status: 'no_report' });
    r = step(s);
    expect(r.actions).toEqual([{ type: 'record_plan', version: 1, round: 0, source: 'degraded', dispatchId: null }]);
    expect(r.actions.some((a) => a.type === 'open_request')).toBe(false);
    // The degraded plan is reviewed like any other.
    expect(step(r.next).actions).toMatchObject([{ type: 'transition', to: 'plan_review', cause: { source: 'degraded' } }]);
  });

  it('puts the plan to a person when the lead gives no revision', () => {
    let s = step(settle(settle(inReview(), PEER, object('Split the API out.')), THIRD, approve)).next; // to plan
    s = step(s).next; // lead dispatched
    s = step(settle(s, LEAD, { status: 'no_report' })).next; // asked again
    const r = step(settle(s, LEAD, { status: 'no_report' }));
    const v1 = r.next.plans.find((p) => p.version === 1)!;
    expect(r.actions).toEqual([
      expect.objectContaining({ type: 'open_request', kind: 'plan_dispute', payload: { cycle: 0, planId: v1.id, version: 1 } }),
    ]);
    expect(step(answer(r.next, planDisputeKey(0), 'proceed')).actions).toMatchObject([
      { type: 'pin_plan', planId: v1.id },
      { type: 'transition', from: 'plan', to: 'build' },
    ]);
  });

  it('treats a lead whose plan run failed as a failed member', () => {
    const s = step(workshop({ phase: 'plan' })).next;
    expect(step(settle(s, LEAD, { status: 'failed' })).actions).toEqual([
      expect.objectContaining({ type: 'open_request', kind: 'member_failed', choices: ['retry', 'stop'] }),
    ]);
  });

  it('does not pin twice', () => {
    const s = { ...settle(settle(inReview(), PEER, approve), THIRD, approve), planPinned: true };
    expect(decide(s, settings)).toEqual([expect.objectContaining({ type: 'transition', to: 'build' })]);
  });
});

describe('workshop engine: explore questions', () => {
  /** Explore with every member settled: the lead and peer asked, the third did not, or was skipped. */
  function explored(): WorkshopState {
    let s = step(workshop()).next;
    s = settle(s, LEAD, reported({ summary: 'a', questions: ['Which store?'] }));
    s = settle(s, PEER, reported({ summary: 'b', questions: ['Keep the old API?', 'Add a dependency?'] }));
    return settle(s, THIRD, { status: 'skipped' });
  }

  it('puts every question to a person in one request, and waits for it', () => {
    const r = step(explored());
    expect(r.actions).toEqual([
      {
        type: 'open_request',
        kind: 'input',
        dedupeKey: questionsKey(0),
        payload: {
          phase: 'explore',
          cycle: 0,
          questions: [
            { agentId: LEAD, question: 'Which store?' },
            { agentId: PEER, question: 'Keep the old API?' },
            { agentId: PEER, question: 'Add a dependency?' },
          ],
        },
        choices: [],
        ttlMs: settings.questionsTtlMs,
      },
    ]);
    // Still explore, nothing new to do until a person answers or the request runs out.
    expect(r.next.phase).toBe('explore');
    expect(decide(r.next, settings)).toEqual([]);
  });

  it('goes on to plan once the questions are answered', () => {
    const s = answer(step(explored()).next, questionsKey(0), 'Use Redis; keep the old API.');
    const request = s.requests[0]!;
    expect(step(s).actions).toEqual([
      {
        type: 'transition',
        from: 'explore',
        to: 'plan',
        cycle: 0,
        round: 0,
        cause: { settled: 'explore', questions: request.id, answered: true },
      },
    ]);
  });

  it('expires the request once its time is up, then plans without answers', () => {
    let s = step(explored()).next;
    s = { ...s, nowMs: s.nowMs + settings.questionsTtlMs - 1 };
    expect(decide(s, settings)).toEqual([]);
    s = { ...s, nowMs: s.nowMs + 1 };
    const request = s.requests[0]!;
    let r = step(s);
    expect(r.actions).toEqual([{ type: 'expire_request', requestId: request.id }]);
    r = step(r.next);
    expect(r.actions).toEqual([
      {
        type: 'transition',
        from: 'explore',
        to: 'plan',
        cycle: 0,
        round: 0,
        cause: { settled: 'explore', questions: request.id, answered: false },
      },
    ]);
  });

  it("asks nothing when no report has questions, and ignores a skipped member's questions", () => {
    let s = step(workshop()).next;
    s = settle(s, LEAD, reported({ summary: 'a', questions: [] }));
    s = settle(s, PEER, reported({ summary: 'b' }));
    // THIRD's dispatch failed with a report (as after a read-only violation); once skipped, its questions are not asked.
    s = settle(s, THIRD, { status: 'failed', report: { summary: 'c', questions: ['Ignored?'] } });
    s = step(s).next; // member_failed for THIRD
    s = step(answer(s, memberFailedKey('explore', 0, 0, THIRD), 'skip')).next;
    expect(s.members.find((m) => m.agentId === THIRD)!.skipped).toBe(true);
    expect(step(s).actions).toEqual([
      { type: 'transition', from: 'explore', to: 'plan', cycle: 0, round: 0, cause: { settled: 'explore' } },
    ]);
  });
});

describe('workshop engine: clocks', () => {
  const now = 10_000_000;

  it('asks once to cancel a running dispatch past its time budget', () => {
    let s = step(workshop({ nowMs: now })).next;
    s = settle(s, PEER, running(now - 600_001));
    const r = step(s);
    const cancel = r.actions.filter((a) => a.type === 'cancel_dispatch');
    expect(cancel).toEqual([{ type: 'cancel_dispatch', dispatchId: dispatchOf(s, PEER).id, reason: 'timeout' }]);
  });

  it('counts banked time from earlier spans toward the budget', () => {
    let s = step(workshop({ nowMs: now })).next;
    s = settle(s, PEER, { ...running(now - 100_000), elapsedMs: 550_000 });
    expect(decide(s, settings).filter((a) => a.type === 'cancel_dispatch')).toHaveLength(1);
    s = settle(s, PEER, { ...running(now - 10_000), elapsedMs: 550_000 });
    expect(decide(s, settings).filter((a) => a.type === 'cancel_dispatch')).toHaveLength(0);
  });

  it('stops the clock while a dispatch waits on a person and restarts it afterwards', () => {
    let s = step(workshop({ nowMs: now })).next;
    s = settle(s, PEER, { ...running(now - 60_000), waitingOnPerson: true });
    let r = step(s);
    expect(r.actions).toEqual([{ type: 'pause_dispatch', dispatchId: dispatchOf(s, PEER).id }]);
    s = r.next;
    expect(dispatchOf(s, PEER)).toMatchObject({ elapsedMs: 60_000, startedAtMs: null, pausedAtMs: now });

    // A day later the person answers; the paused span never counted.
    s = { ...s, nowMs: now + 86_400_000 };
    expect(decide(s, settings).filter((a) => a.type === 'cancel_dispatch')).toEqual([]);
    s = settle(s, PEER, { waitingOnPerson: false });
    r = step(s);
    expect(r.actions).toEqual([{ type: 'resume_dispatch', dispatchId: dispatchOf(s, PEER).id }]);
    expect(elapsedMs(dispatchOf(r.next, PEER), r.next.nowMs)).toBe(60_000);
  });
});

describe('workshop engine: missing reports and failures', () => {
  it('re-asks once after a run ends without a report, then asks a person', () => {
    let s = step(workshop()).next;
    s = settle(s, PEER, { status: 'no_report' });
    let r = step(s);
    expect(r.actions).toEqual([expect.objectContaining({ type: 'dispatch', agentId: PEER, round: 1 })]);
    s = settle(r.next, PEER, { status: 'no_report' });
    r = step(s);
    const key = memberFailedKey('explore', 0, 1, PEER);
    expect(r.actions).toEqual([
      {
        type: 'open_request',
        kind: 'member_failed',
        dedupeKey: key,
        payload: { phase: 'explore', agentId: PEER, dispatchId: dispatchOf(s, PEER).id, outcome: 'no_report' },
        choices: ['retry', 'skip', 'stop'],
      },
    ]);
    // Open request: nothing more until a person answers.
    expect(decide(r.next, settings)).toEqual([]);
  });

  it('asks a person at once when a run fails', () => {
    let s = step(workshop()).next;
    s = settle(s, PEER, { status: 'failed' });
    expect(step(s).actions).toMatchObject([{ type: 'open_request', kind: 'member_failed', choices: ['retry', 'skip', 'stop'] }]);
  });

  it('does not offer to skip the lead', () => {
    let s = step(workshop()).next;
    s = settle(s, LEAD, { status: 'failed' });
    expect(step(s).actions).toMatchObject([{ type: 'open_request', choices: ['retry', 'stop'] }]);
  });

  it('follows the answer: retry dispatches again, skip drops the member, stop ends the workshop', () => {
    let s = step(workshop()).next;
    s = settle(s, PEER, { status: 'failed' });
    s = step(s).next;
    const key = memberFailedKey('explore', 0, 0, PEER);

    const retried = step(answer(s, key, 'retry'));
    expect(retried.actions).toEqual([expect.objectContaining({ type: 'dispatch', agentId: PEER, round: 1 })]);

    const skipped = step(answer(s, key, 'skip'));
    expect(skipped.actions).toEqual([{ type: 'skip_member', agentId: PEER }]);
    let after = settle(settle(skipped.next, LEAD, reported()), THIRD, reported());
    expect(step(after).actions).toMatchObject([{ type: 'transition', to: 'plan' }]);
    after = step(after).next;
    expect(step(after).actions.map((a) => a.type === 'dispatch' && a.agentId)).toEqual([LEAD]);

    const stopped = step(answer(s, key, 'stop'));
    expect(stopped.actions).toEqual([{ type: 'stop', reason: `Stopped after ${PEER} failed in explore` }]);
    expect(decide(stopped.next, settings)).toEqual([]);
  });

  it('ignores a skip answer for the lead', () => {
    let s = step(workshop()).next;
    s = settle(s, LEAD, { status: 'failed' });
    s = step(s).next;
    expect(decide(answer(s, memberFailedKey('explore', 0, 0, LEAD), 'skip'), settings)).toEqual([]);
  });

  it('keeps a member settled once a later round reports, whatever earlier rounds did', () => {
    let s = step(workshop()).next;
    s = settle(s, PEER, { status: 'no_report' });
    s = step(s).next;
    s = settle(s, PEER, reported());
    s = settle(settle(s, LEAD, reported()), THIRD, reported());
    expect(step(s).actions).toMatchObject([{ type: 'transition', to: 'plan' }]);
  });
});
