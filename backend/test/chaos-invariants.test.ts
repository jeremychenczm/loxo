import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkInvariants, type InvariantId, type Violation } from '../scripts/chaos/invariants';
import { createScratchDatabase, serverReachable, type ScratchDatabase } from './support/scratch-db';

/**
 * The chaos invariant checker against hand-built database states: a world
 * that followed the rules yields nothing, and each kind of breach is named
 * with its invariant and subject.
 */
const ADMIN_URL = 'postgres://postgres:postgres@localhost:5434/postgres';
const CHAOS_ADMIN_URL = 'postgres://postgres:postgres@localhost:5435/postgres';
const chaosServerUp = await serverReachable(CHAOS_ADMIN_URL);

const ALL: InvariantId[] = ['INV-1', 'INV-2', 'INV-3', 'INV-4', 'INV-5', 'INV-6', 'INV-7', 'INV-8', 'INV-9', 'INV-10', 'INV-16'];
const LIMITS = { cycleMs: 1_000, maxAttempts: 3 };

// The schema already refuses some breaches outright; these go so a test can build them.
const LOOSEN = [
  'DROP INDEX runs_one_running_per_agent',
  'DROP INDEX runs_one_running_per_gate',
  'DROP INDEX human_requests_one_retry_per_run',
  'DROP INDEX control_plane_requests_terminal',
  'ALTER TABLE runs DROP CONSTRAINT runs_running_has_lease',
];

let scratch: ScratchDatabase;
let db: pg.Pool;
let witnessDir = '';
let userId = '';
let counter = 0;

async function insert(table: string, row: Record<string, unknown>): Promise<string> {
  const cols = Object.keys(row);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id::text`,
    Object.values(row)
  );
  return rows[0]!.id;
}

const ago = (ms: number) => new Date(Date.now() - ms);
const ahead = (ms: number) => new Date(Date.now() + ms);
// Wide margins: the Docker VM clock drifts from the host's by up to a second or so.
const running = () => ({ status: 'running', owner_instance: 'instance-a', lease_expires_at: ahead(60_000) });

async function agent(): Promise<string> {
  counter += 1;
  return insert('agents', { user_id: userId, name: `Agent ${counter}`, runtime: 'claude-code' });
}

async function task(): Promise<string> {
  counter += 1;
  return insert('tasks', { user_id: userId, number: counter, title: `Task ${counter}` });
}

/** A legacy run by default: gated by its task, as the platform creates one. */
async function run(taskId: string, agentId: string | null, fields: Record<string, unknown> = {}): Promise<string> {
  return insert('runs', {
    user_id: userId,
    agent_id: agentId,
    agent_name: 'Agent',
    task_id: taskId,
    trigger: 'manual',
    status: 'succeeded',
    owner_epoch: 1,
    gate_key: `task:${taskId}`,
    ...fields,
  });
}

async function platformOp(taskId: string, kind = 'prepare_worktree', status = 'running'): Promise<string> {
  counter += 1;
  return insert('platform_ops', { task_id: taskId, op_key: `op-${counter}`, kind, status });
}

/** A platform run: no agent, the gate of the worktree its operation touches. */
async function platformRun(taskId: string, opId: string, fields: Record<string, unknown> = {}): Promise<string> {
  return run(taskId, null, { actor: 'platform', trigger: 'platform', agent_name: 'Loxo platform', op_id: opId, gate_key: null, ...fields });
}

async function toolCall(runId: string, tool: string, epoch = 1): Promise<string> {
  counter += 1;
  return insert('control_plane_requests', { run_id: runId, epoch, seq: counter, tool, args_hash: `h${counter}` });
}

async function entry(taskId: string, runId: string, content: string, epoch = 1): Promise<string> {
  counter += 1;
  return insert('turns', { task_id: taskId, run_id: runId, epoch, seq: counter, kind: 'agent', content });
}

async function retryRequest(taskId: string, runId: string, status: string, choice?: string): Promise<string> {
  return insert('human_requests', {
    task_id: taskId,
    run_id: runId,
    kind: 'retry',
    status,
    ...(choice ? { answer: JSON.stringify({ choice }) } : {}),
  });
}

async function workspace(taskId: string, status: string, kind: 'integration' | 'member' = 'integration'): Promise<string> {
  counter += 1;
  return insert('workspaces', {
    user_id: userId,
    task_id: taskId,
    worktree_path: `/tmp/wt-${counter}`,
    branch_name: kind === 'integration' ? `loxo/t${counter}` : null,
    base_ref: 'main',
    base_commit: 'abc',
    kind,
    status,
  });
}

async function snapshot(runId: string, kind: 'run' | 'recovery', changedFiles: number): Promise<string> {
  return insert('change_snapshots', {
    run_id: runId,
    kind,
    before_head: 'a',
    after_head: 'b',
    change_fingerprint: 'f',
    changed_files: changedFiles,
  });
}

/** A workshop on a repository: its base commit frozen, a pinned plan, and its integration worktree at `head`. */
async function workshopTask(base: string, head: string): Promise<{ taskId: string; planId: string }> {
  counter += 1;
  const taskId = await insert('tasks', {
    user_id: userId,
    number: counter,
    title: `Workshop ${counter}`,
    playbook: 'build',
    snapshot: JSON.stringify({ baseCommit: base }),
  });
  const planId = await insert('plans', { task_id: taskId, cycle: 0, version: 1, round: 0, source: 'lead', content: '{}', hash: `p${counter}` });
  counter += 1;
  await insert('workspaces', {
    user_id: userId,
    task_id: taskId,
    worktree_path: `/tmp/wt-${counter}`,
    branch_name: `loxo/t${counter}/integration`,
    base_ref: 'main',
    base_commit: base,
    kind: 'integration',
    status: 'ready',
    head_commit: head,
  });
  return { taskId, planId };
}

async function workPackage(w: { taskId: string; planId: string }, key: string, dependsOn: string[] = [], startCommit: string | null = null) {
  return insert('work_packages', {
    task_id: w.taskId,
    plan_id: w.planId,
    key,
    title: key,
    area: key,
    depends_on: JSON.stringify(dependsOn),
    start_commit: startCommit,
  });
}

/** One recorded integration of `key` onto `onto`: merged as `merge` (null when it was already in), or conflicted. */
async function integrated(taskId: string, key: string, onto: string, merge: string | null, outcome = 'merged'): Promise<string> {
  const opId = await platformOp(taskId, 'integrate', 'done');
  return insert('integrations', {
    task_id: taskId,
    op_id: opId,
    package_key: key,
    cycle: 0,
    outcome,
    onto_commit: onto,
    package_head: `${key}-head`,
    merge_commit: merge,
  });
}

/** A witnessed execution: a line every 50 ms from `start` to `end`, for the control plane at `via`. */
function witnessed(
  pid: number,
  runId: string,
  epoch: number,
  start: number,
  end: number,
  via = '127.0.0.1:4000',
  dir = witnessDir
): void {
  const lines: string[] = [];
  for (let t = start; t <= end; t += 50) {
    lines.push(JSON.stringify({ run: runId, epoch, via, pid, t, mark: t === start ? 'start' : 'beat' }));
  }
  fs.appendFileSync(path.join(dir, `${pid}.jsonl`), `${lines.join('\n')}\n`);
}

type Extra = Pick<Parameters<typeof checkInvariants>[0], 'wakeRuns' | 'deaths' | 'handoffs' | 'platformWitnessDir'>;

async function check(only: InvariantId, extra: Extra = {}): Promise<Violation[]> {
  return checkInvariants({ db, ...LIMITS, witnessDir, ...extra, skip: ALL.filter((id) => id !== only) });
}

const found = (violations: Violation[]) => violations.map((v) => `${v.invariant} ${v.subject}`).sort();

beforeAll(async () => {
  scratch = await createScratchDatabase(ADMIN_URL, 'swarmdev_invariants_test');
  db = scratch.pool;
  for (const statement of LOOSEN) await db.query(statement);
});

afterAll(async () => {
  await scratch.drop();
});

beforeEach(async () => {
  await db.query('TRUNCATE TABLE users CASCADE');
  userId = await insert('users', { email: 'chaos@example.com', username: 'chaos', password_hash: 'x' });
  witnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loxo-invariants-'));
});

afterEach(() => {
  fs.rmSync(witnessDir, { recursive: true, force: true });
});

describe('chaos invariant checker', () => {
  it('finds nothing in a world that kept the rules', async () => {
    const [t1, t2, t3, t4, t5] = [await task(), await task(), await task(), await task(), await task()];
    const [a1, a2, a3, a4, a5] = [await agent(), await agent(), await agent(), await agent(), await agent()];

    const done = await run(t1, a1);
    await toolCall(done, 'comment_on_task');
    await toolCall(done, 'submit_result');
    await entry(t1, done, 'Halfway there');
    await entry(t1, done, 'Export added');

    await run(t2, a2, running());
    await run(t2, a3, { status: 'queued', created_at: ago(60_000) });

    const cut = await run(t3, a4, { status: 'interrupted', recovery_class: 'interrupted', recovery_step: 'resolved', owner_epoch: 2 });
    await toolCall(cut, 'comment_on_task');
    await entry(t3, cut, 'Started');
    await retryRequest(t3, cut, 'open');
    await workspace(t3, 'quarantined');

    const lost = await run(t4, a5, { status: 'failed', recovery_class: 'retry', recovery_step: 'resolved', owner_epoch: 2 });
    await snapshot(lost, 'recovery', 0);
    const retried = await run(t4, a5, { parent_run_id: lost, attempt: 2 });

    const discarded = await run(t5, a1, { status: 'failed', recovery_class: 'interrupted', recovery_step: 'resolved', owner_epoch: 2 });
    await snapshot(discarded, 'recovery', 2);
    await retryRequest(t5, discarded, 'answered', 'discard');
    await run(t5, a1, { parent_run_id: discarded, attempt: 2 });

    // A graceful shutdown: one run handed off and continued, one that had submitted settled, one that finished.
    const [t6, t7, t8] = [await task(), await task(), await task()];
    const handedOff = await run(t6, a2, { status: 'cancelled', stop_reason: 'handoff' });
    await entry(t6, handedOff, 'Half done');
    await run(t6, a2, { parent_run_id: handedOff });
    const submittedFirst = await run(t7, a3, { stop_reason: 'handoff' });
    await toolCall(submittedFirst, 'submit_result');
    const finishedFirst = await run(t8, a4);

    const t0 = Date.now() - 60_000;
    witnessed(101, lost, 1, t0, t0 + 500);
    witnessed(102, retried, 1, t0 + 4_000, t0 + 4_600);

    const violations = await checkInvariants({
      db,
      ...LIMITS,
      witnessDir,
      wakeRuns: [done, cut, lost, discarded, handedOff, submittedFirst, finishedFirst],
      handoffs: [[handedOff, submittedFirst, finishedFirst].map((runId) => ({ runId, epoch: 1 }))],
      skip: ['INV-3'],
    });
    expect(violations).toEqual([]);
  });

  it('INV-16: names a forked or rewritten integration history and packages merged out of dependency order', async () => {
    // Kept the rules: api, then ui (which needs api) from the head api left, after a conflict on the way;
    // docs found already in; a second workshop whose merge is still in flight.
    const good = await workshopTask('b0', 'm2');
    await workPackage(good, 'api', [], 'b0');
    await workPackage(good, 'ui', ['api'], 'm1');
    await workPackage(good, 'docs', [], 'b0');
    await integrated(good.taskId, 'api', 'b0', 'm1');
    await integrated(good.taskId, 'ui', 'm1', null, 'conflicted');
    await integrated(good.taskId, 'ui', 'm1', 'm2');
    await integrated(good.taskId, 'docs', 'm2', null);
    const busy = await workshopTask('b0', 'b0');
    await integrated(busy.taskId, 'api', 'b0', 'm1');
    await platformOp(busy.taskId, 'integrate', 'running');

    // Two merges onto one head.
    const forked = await workshopTask('b0', 'm1');
    await integrated(forked.taskId, 'api', 'b0', 'm1');
    await integrated(forked.taskId, 'ui', 'b0', 'm9');
    // A merge onto a head the chain from the base never reached.
    const rewritten = await workshopTask('b0', 'm1');
    await integrated(rewritten.taskId, 'api', 'b0', 'm1');
    await integrated(rewritten.taskId, 'ui', 'x1', 'm2');
    // ui merged before api, which it needs.
    const early = await workshopTask('b0', 'm2');
    await workPackage(early, 'api', [], 'b0');
    await workPackage(early, 'ui', ['api'], 'b0');
    await integrated(early.taskId, 'ui', 'b0', 'm1');
    await integrated(early.taskId, 'api', 'm1', 'm2');
    // ui branched from the base while api was merged later; and one branched before its dependency went in at all.
    const stale = await workshopTask('b0', 'm2');
    await workPackage(stale, 'api', [], 'b0');
    await workPackage(stale, 'ui', ['api'], 'b0');
    await integrated(stale.taskId, 'api', 'b0', 'm1');
    await integrated(stale.taskId, 'ui', 'm1', 'm2');
    const ahead = await workshopTask('b0', 'b0');
    await workPackage(ahead, 'api', [], 'b0');
    await workPackage(ahead, 'ui', ['api'], 'b0');
    await integrated(ahead.taskId, 'api', 'b0', null, 'conflicted');
    // A conflict against a head the branch never had.
    const offChain = await workshopTask('b0', 'm1');
    await integrated(offChain.taskId, 'api', 'b0', 'm1');
    await integrated(offChain.taskId, 'ui', 'y1', null, 'conflicted');
    // The worktree is not where the history ends, with nothing in flight.
    const drifted = await workshopTask('b0', 'z9');
    await integrated(drifted.taskId, 'api', 'b0', 'm1');

    const violations = await check('INV-16');
    expect([...new Set(found(violations))]).toEqual(
      [forked, rewritten, early, stale, ahead, offChain, drifted].map((w) => `INV-16 ${w.taskId}`).sort()
    );
    const details = (w: { taskId: string }) => violations.filter((v) => v.subject === w.taskId).map((v) => v.detail);
    expect(details(forked)).toEqual(['api and ui were each merged onto b0']);
    expect(details(rewritten)).toEqual(['the merge of ui onto x1 is not on the history from the base']);
    // Merged first, it also started before api went in.
    expect(details(early).sort()).toEqual([
      'ui starts before the merge of api, which it depends on',
      'ui was merged before api, which it depends on',
    ]);
    expect(details(stale)).toEqual(['ui starts before the merge of api, which it depends on']);
    expect(details(ahead)).toEqual(['ui started before api, which it depends on, was merged']);
    expect(details(offChain)).toEqual(['ui was recorded conflicted against y1, a head the integration branch never had']);
    expect(details(drifted)).toEqual(['the integration worktree is at z9, but its recorded history ends at m1']);
  });

  it('INV-1: names running runs whose lease expired or is missing', async () => {
    const stale = await run(await task(), await agent(), { ...running(), lease_expires_at: ago(60_000) });
    const bare = await run(await task(), await agent(), { status: 'running' });
    await run(await task(), await agent(), running());

    expect(found(await check('INV-1'))).toEqual([`INV-1 ${stale}`, `INV-1 ${bare}`].sort());
  });

  it('INV-2: names an agent running twice and a gate held twice, not two worktrees of one task', async () => {
    const busy = await agent();
    await run(await task(), busy, running());
    await run(await task(), busy, running());
    const held = await task();
    await run(held, await agent(), running());
    await run(held, await agent(), { status: 'interrupted', recovery_class: 'interrupted' });
    const shared = await task();
    await run(shared, await agent(), { ...running(), gate_key: 'ws:one' });
    await run(shared, await agent(), { ...running(), gate_key: 'ws:two' });
    await platformRun(shared, await platformOp(shared), { ...running(), gate_key: 'ws:three' });
    await run(shared, await agent(), { ...running(), gate_key: 'ws:four' });
    await platformRun(shared, await platformOp(shared), { ...running(), gate_key: 'ws:four' });

    expect(found(await check('INV-2'))).toEqual([`INV-2 ${busy}`, `INV-2 task:${held}`, 'INV-2 ws:four'].sort());
  });

  it('INV-4: names a run that submitted twice and one whose effect landed twice', async () => {
    const t = await task();
    const twice = await run(t, await agent());
    await toolCall(twice, 'submit_result');
    await toolCall(twice, 'submit_result');
    const echoed = await run(await task(), await agent());
    await entry(t, echoed, 'Progress: half done');
    await entry(t, echoed, 'Progress: half done');

    expect(found(await check('INV-4'))).toEqual([`INV-4 ${twice}`, `INV-4 ${echoed}`].sort());
  });

  it('INV-5: names interrupted runs left without exactly one open request or an unguarded workspace', async () => {
    const interrupted = { status: 'interrupted', recovery_class: 'interrupted' };
    const t1 = await task();
    const unasked = await run(t1, await agent(), interrupted);
    const t2 = await task();
    const answered = await run(t2, await agent(), interrupted);
    await retryRequest(t2, answered, 'answered', 'stop');
    const t3 = await task();
    const unguarded = await run(t3, await agent(), interrupted);
    await retryRequest(t3, unguarded, 'open');
    await workspace(t3, 'dirty');
    const t4 = await task();
    const settled = await run(t4, await agent(), { status: 'failed' });
    const stray = await retryRequest(t4, settled, 'open');
    // Per worktree: the interrupted run's own worktree is quarantined; another worktree of the task may keep working.
    const t5 = await task();
    await workspace(t5, 'ready');
    const own = await workspace(t5, 'quarantined', 'member');
    const scoped = await run(t5, await agent(), { ...interrupted, workspace_id: own, gate_key: `ws:${own}` });
    await retryRequest(t5, scoped, 'open');

    const violations = await check('INV-5');
    expect(found(violations)).toEqual([`INV-5 ${unasked}`, `INV-5 ${answered}`, `INV-5 ${unguarded}`, `INV-5 ${stray}`].sort());
    expect(violations.find((v) => v.subject === unguarded)?.detail).toContain('dirty, not quarantined');
  });

  it('INV-6: names unsafe automatic retries, misclassed runs, and replays nobody approved', async () => {
    const lost = { status: 'failed', recovery_step: 'resolved', owner_epoch: 2 };
    const talked = await run(await task(), await agent(), { ...lost, recovery_class: 'retry' });
    await toolCall(talked, 'comment_on_task');
    const edited = await run(await task(), await agent(), { ...lost, recovery_class: 'retry' });
    await snapshot(edited, 'recovery', 1);
    const notKnown = await run(await task(), await agent(), { ...lost, recovery_class: 'known' });
    const submitted = await run(await task(), await agent(), { ...lost, recovery_class: 'interrupted' });
    await toolCall(submitted, 'submit_result');

    const tq = await task();
    const aq = await agent();
    const pending = await run(tq, aq, { ...lost, recovery_class: 'interrupted' });
    await retryRequest(tq, pending, 'open');
    const replay = await run(tq, aq, { parent_run_id: pending, attempt: 2 });

    const tc = await task();
    const ac = await agent();
    const capped = await run(tc, ac, { ...lost, recovery_class: 'retry', attempt: 3 });
    const overCap = await run(tc, ac, { parent_run_id: capped, attempt: 4 });

    const tf = await task();
    const af = await agent();
    const forked = await run(tf, af, { ...lost, recovery_class: 'retry' });
    await run(tf, af, { parent_run_id: forked, attempt: 2 });
    await run(tf, af, { parent_run_id: forked, attempt: 2 });

    // Only a cancelled run its owner handed off may be continued unasked.
    const th = await task();
    const ah = await agent();
    const notHandedOff = await run(th, ah, { status: 'failed', stop_reason: 'handoff' });
    const unasked = await run(th, ah, { parent_run_id: notHandedOff });
    const tk = await task();
    const ak = await agent();
    const handedOff = await run(tk, ak, { status: 'cancelled', stop_reason: 'handoff' });
    await run(tk, ak, { parent_run_id: handedOff });

    // A platform operation runs again without anyone's answer, as the same operation and within the cap.
    const tp = await task();
    const op = await platformOp(tp);
    const failedOnce = await platformRun(tp, op, { status: 'failed' });
    await platformRun(tp, op, { parent_run_id: failedOnce, attempt: 2 });
    const otherOp = await platformRun(tp, await platformOp(tp), { parent_run_id: failedOnce, attempt: 2 });
    const tooMany = await platformRun(tp, op, { parent_run_id: failedOnce, attempt: 4 });

    expect(found(await check('INV-6'))).toEqual(
      [talked, edited, notKnown, submitted, replay, overCap, forked, unasked, otherOp, tooMany, failedOnce]
        .map((id) => `INV-6 ${id}`)
        .sort()
    );
  });

  it('INV-10: names runs a gracefully stopped instance held that were not handed off cleanly', async () => {
    const pair = async () => [await task(), await agent()] as const;
    const [ta, aa] = await pair();
    // Taken over and already resolved: final, so only its epoch gives it away.
    const takenOver = await run(ta, aa, { status: 'failed', recovery_class: 'retry', recovery_step: 'resolved', owner_epoch: 2 });
    const [tb, ab] = await pair();
    const left = await run(tb, ab, running());
    const [tc, ac] = await pair();
    const orphaned = await run(tc, ac, { status: 'cancelled', stop_reason: 'handoff' });
    const [td, ad] = await pair();
    const twice = await run(td, ad, { status: 'cancelled', stop_reason: 'handoff' });
    await run(td, ad, { parent_run_id: twice });
    await run(td, ad, { parent_run_id: twice });
    const [te, ae] = await pair();
    const resubmitting = await run(te, ae, { status: 'cancelled', stop_reason: 'handoff' });
    await toolCall(resubmitting, 'submit_result');
    await run(te, ae, { parent_run_id: resubmitting });
    const [tf, af] = await pair();
    const fine = await run(tf, af, { status: 'cancelled', stop_reason: 'handoff' });
    await run(tf, af, { parent_run_id: fine });
    // Released at handoff: an operation no longer wanted, or a dispatch told to stop, gets no follow-up.
    const tg = await task();
    const releasedOp = await platformRun(tg, await platformOp(tg, 'prepare_worktree', 'cancelled'), {
      status: 'cancelled',
      stop_reason: 'handoff',
    });
    const [th, ah] = await pair();
    const dispatch = await insert('dispatches', {
      task_id: th,
      phase: 'explore',
      purpose: 'explore',
      cycle: 0,
      round: 0,
      agent_id: ah,
      timeout_ms: 600000,
      cancel_requested_at: new Date(),
    });
    const releasedDispatch = await run(th, ah, { status: 'cancelled', stop_reason: 'handoff', dispatch_id: dispatch });

    const held = [takenOver, left, orphaned, twice, resubmitting, fine, releasedOp, releasedDispatch].map((runId) => ({
      runId,
      epoch: 1,
    }));
    const violations = await check('INV-10', { handoffs: [held] });
    expect(found(violations)).toEqual([takenOver, left, orphaned, twice, resubmitting, resubmitting].map((id) => `INV-10 ${id}`).sort());
  });

  it('INV-7: names a queued run that could have started a cycle ago', async () => {
    const queued = { status: 'queued', created_at: ago(60_000) };
    const stuck = await run(await task(), await agent(), queued);
    await run(await task(), await agent(), { ...queued, not_before: ahead(60_000) });
    await run(await task(), await agent(), { status: 'queued' });
    const fenced = await task();
    await workspace(fenced, 'quarantined');
    await run(fenced, await agent(), queued);
    // Per worktree: a run on another, free worktree of the same task is stuck; a platform run counts too,
    // and an operation that releases the quarantine may run on the quarantined one.
    const split = await task();
    const locked = await workspace(split, 'quarantined', 'member');
    const open = await workspace(split, 'ready', 'member');
    const freeWorktree = await run(split, await agent(), { ...queued, workspace_id: open, gate_key: `ws:${open}` });
    await run(split, await agent(), { ...queued, workspace_id: locked, gate_key: `ws:${locked}` });
    const stuckOp = await platformRun(split, await platformOp(split), { ...queued, workspace_id: open, gate_key: `ws:${open}x` });
    const release = await platformRun(split, await platformOp(split, 'reconcile_worktree'), {
      ...queued,
      workspace_id: locked,
      gate_key: `ws:${locked}y`,
    });

    expect(found(await check('INV-7'))).toEqual(
      [`INV-7 ${stuck}`, `INV-7 ${freeWorktree}`, `INV-7 ${stuckOp}`, `INV-7 ${release}`].sort()
    );
  });

  it('INV-8: names wakes whose latest attempt is still pending, or that never got a run', async () => {
    const t = await task();
    const a = await agent();
    const first = await run(t, a, { status: 'failed', recovery_class: 'retry', recovery_step: 'resolved', owner_epoch: 2 });
    await run(t, a, { status: 'queued', parent_run_id: first, attempt: 2, not_before: ahead(60_000) });
    const settled = await run(await task(), await agent());
    const missing = '00000000-0000-4000-8000-000000000000';

    const violations = await check('INV-8', { wakeRuns: [first, settled, missing] });
    expect(found(violations)).toEqual([`INV-8 ${first}`, `INV-8 ${missing}`].sort());
    expect(violations.find((v) => v.subject === first)?.detail).toContain('is queued');
  });

  it('INV-9: names a gate or an agent with overlapping executions, not two worktrees of one task', async () => {
    const shared = await task();
    const a = await run(shared, await agent());
    const b = await run(shared, await agent());
    const busy = await agent();
    const c = await run(await task(), busy);
    const d = await run(await task(), busy);
    const calm = await task();
    const e = await run(calm, await agent());
    const f = await run(calm, await agent());
    const workshop = await task();
    const g = await run(workshop, await agent(), { gate_key: 'ws:left' });
    const h = await run(workshop, await agent(), { gate_key: 'ws:right' });
    const op = await platformRun(workshop, await platformOp(workshop), { gate_key: 'ws:left' });

    const t0 = Date.now() - 60_000;
    witnessed(201, a, 1, t0, t0 + 1_000);
    witnessed(202, b, 1, t0 + 500, t0 + 1_500);
    witnessed(203, c, 1, t0, t0 + 1_000);
    witnessed(204, d, 2, t0 + 900, t0 + 2_000);
    witnessed(205, e, 1, t0, t0 + 1_000);
    witnessed(206, f, 1, t0 + 1_100, t0 + 2_000);
    witnessed(207, g, 1, t0, t0 + 1_000);
    witnessed(208, h, 1, t0 + 200, t0 + 1_200);
    // A platform operation on a worktree an agent is still writing, witnessed by its backend.
    const platformWitnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loxo-platform-witness-'));
    witnessed(209, op, 1, t0 + 800, t0 + 1_400, '127.0.0.1:4000', platformWitnessDir);

    try {
      expect(found(await check('INV-9', { platformWitnessDir }))).toEqual(
        [`INV-9 task:${shared}`, `INV-9 ${busy}`, 'INV-9 ws:left'].sort()
      );
    } finally {
      fs.rmSync(platformWitnessDir, { recursive: true, force: true });
    }
  });

  it('INV-9: names an agent that kept running after the backend it worked for died', async () => {
    const orphan = await run(await task(), await agent());
    const stopped = await run(await task(), await agent());
    const elsewhere = await run(await task(), await agent());
    const later = await run(await task(), await agent());

    const t0 = Date.now() - 60_000;
    const dead = '127.0.0.1:4100';
    witnessed(301, orphan, 1, t0, t0 + 3_000, dead);
    witnessed(302, stopped, 1, t0, t0 + 1_200, dead);
    witnessed(303, elsewhere, 1, t0, t0 + 5_000, '127.0.0.1:4200');
    witnessed(304, later, 1, t0 + 2_000, t0 + 5_000, dead);

    const violations = await check('INV-9', { deaths: [{ via: dead, at: t0 + 500 }] });
    expect(found(violations)).toEqual([`INV-9 ${orphan}`]);
    expect(violations[0]!.detail).toContain('kept running 2500 ms');
  });

  it('INV-3: refuses to run without commit timestamps rather than pass', async () => {
    await expect(check('INV-3')).rejects.toThrow('track_commit_timestamp');
  });
});

describe.skipIf(!chaosServerUp)('chaos invariant checker on the chaos server', () => {
  let chaos: ScratchDatabase;
  let outer: pg.Pool;

  beforeAll(async () => {
    chaos = await createScratchDatabase(CHAOS_ADMIN_URL, 'swarmdev_invariants_test');
    outer = db;
    db = chaos.pool;
  });

  afterAll(async () => {
    db = outer;
    await chaos.drop();
  });

  it('INV-3: names writes under an old epoch that committed after the takeover', async () => {
    const t = await task();
    const r = await run(t, await agent(), { ...running(), owner_epoch: 2 });
    const event = (seq: number, epoch: number) =>
      insert('run_events', { run_id: r, epoch, seq, kind: 'status', payload: JSON.stringify({ message: `e${epoch}` }) });

    const dispatch = await insert('dispatches', {
      task_id: t,
      phase: 'explore',
      purpose: 'explore',
      cycle: 0,
      round: 0,
      timeout_ms: 600000,
    });

    await event(1, 1);
    await entry(t, r, 'before the takeover');
    await event(2, 2);
    const late = await entry(t, r, 'after the takeover');
    const lateCall = await toolCall(r, 'comment_on_task', 1);
    const lateReport = await insert('dispatch_reports', {
      dispatch_id: dispatch,
      run_id: r,
      epoch: 1,
      tool: 'submit_exploration',
      report: JSON.stringify({ approach: 'stale' }),
    });
    await entry(t, r, 'new owner', 2);

    const violations = await check('INV-3');
    expect(found(violations)).toEqual([`INV-3 ${r}`, `INV-3 ${r}`, `INV-3 ${r}`]);
    expect(violations.map((v) => v.detail.split(' ').slice(0, 2).join(' ')).sort()).toEqual(
      [`control_plane_requests ${lateCall}`, `turns ${late}`, `dispatch_reports ${lateReport}`].sort()
    );
  });
});
