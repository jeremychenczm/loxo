import { describe, expect, it } from 'vitest';
import {
  decide,
  elapsedMs,
  memberFailedKey,
  questionsKey,
  type Action,
  type DispatchView,
  type EngineSettings,
  type WorkshopState,
} from '../src/modules/workshop/engine';

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

function answer(s: WorkshopState, dedupeKey: string, choice: string): WorkshopState {
  const next = structuredClone(s);
  next.requests = next.requests.map((r) =>
    r.dedupeKey === dedupeKey ? { ...r, status: 'answered' as const, answer: { choice } } : r
  );
  return next;
}

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

  it('sends a solo workshop straight from brief to build', () => {
    const s = workshop({ phase: 'brief', playbook: 'solo', members: [{ agentId: LEAD, skipped: false }] });
    const r = step(s);
    expect(r.actions).toMatchObject([{ type: 'transition', to: 'build' }]);
    const build = step(r.next);
    expect(build.actions).toEqual([
      expect.objectContaining({ type: 'dispatch', purpose: 'build', agentId: LEAD, readOnly: false, timeoutMs: 3_600_000 }),
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
    expect(r.actions).toMatchObject([{ type: 'transition', to: 'plan_review' }]);
    r = step(r.next);
    expect(r.actions.map((a) => a.type === 'dispatch' && a.agentId)).toEqual([PEER, THIRD]);
    s = settle(settle(r.next, PEER, reported()), THIRD, reported());
    expect(step(s).actions).toMatchObject([{ type: 'transition', to: 'build' }]);
  });

  it('skips plan review when every other member has been skipped', () => {
    const members = [
      { agentId: LEAD, skipped: false },
      { agentId: PEER, skipped: true },
    ];
    let s = step(workshop({ phase: 'plan', members })).next;
    s = settle(s, LEAD, reported());
    expect(step(s).actions).toMatchObject([{ type: 'transition', to: 'build' }]);
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
