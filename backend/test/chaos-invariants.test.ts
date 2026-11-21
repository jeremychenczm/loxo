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

const ALL: InvariantId[] = ['INV-1', 'INV-2', 'INV-3', 'INV-4', 'INV-5', 'INV-6', 'INV-7', 'INV-8', 'INV-9', 'INV-10'];
const LIMITS = { cycleMs: 1_000, maxAttempts: 3 };

// The schema already refuses some breaches outright; these go so a test can build them.
const LOOSEN = [
  'DROP INDEX runs_one_running_per_agent',
  'DROP INDEX runs_one_running_per_task',
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

async function run(taskId: string, agentId: string, fields: Record<string, unknown> = {}): Promise<string> {
  return insert('runs', {
    user_id: userId,
    agent_id: agentId,
    agent_name: 'Agent',
    task_id: taskId,
    trigger: 'manual',
    status: 'succeeded',
    owner_epoch: 1,
    ...fields,
  });
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

async function workspace(taskId: string, status: string): Promise<string> {
  counter += 1;
  return insert('workspaces', {
    user_id: userId,
    task_id: taskId,
    worktree_path: `/tmp/wt-${counter}`,
    branch_name: `loxo/t${counter}`,
    base_ref: 'main',
    base_commit: 'abc',
    kind: 'integration',
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

/** A witnessed execution: a line every 50 ms from `start` to `end`, for the control plane at `via`. */
function witnessed(pid: number, runId: string, epoch: number, start: number, end: number, via = '127.0.0.1:4000'): void {
  const lines: string[] = [];
  for (let t = start; t <= end; t += 50) {
    lines.push(JSON.stringify({ run: runId, epoch, via, pid, t, mark: t === start ? 'start' : 'beat' }));
  }
  fs.appendFileSync(path.join(witnessDir, `${pid}.jsonl`), `${lines.join('\n')}\n`);
}

type Extra = Pick<Parameters<typeof checkInvariants>[0], 'wakeRuns' | 'deaths' | 'handoffs'>;

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

  it('INV-1: names running runs whose lease expired or is missing', async () => {
    const stale = await run(await task(), await agent(), { ...running(), lease_expires_at: ago(60_000) });
    const bare = await run(await task(), await agent(), { status: 'running' });
    await run(await task(), await agent(), running());

    expect(found(await check('INV-1'))).toEqual([`INV-1 ${stale}`, `INV-1 ${bare}`].sort());
  });

  it('INV-2: names an agent running twice and a task held twice', async () => {
    const busy = await agent();
    await run(await task(), busy, running());
    await run(await task(), busy, running());
    const held = await task();
    await run(held, await agent(), running());
    await run(held, await agent(), { status: 'interrupted', recovery_class: 'interrupted' });

    expect(found(await check('INV-2'))).toEqual([`INV-2 ${busy}`, `INV-2 ${held}`].sort());
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

    expect(found(await check('INV-6'))).toEqual(
      [talked, edited, notKnown, submitted, replay, overCap, forked, unasked].map((id) => `INV-6 ${id}`).sort()
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

    const held = [takenOver, left, orphaned, twice, resubmitting, fine].map((runId) => ({ runId, epoch: 1 }));
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

    expect(found(await check('INV-7'))).toEqual([`INV-7 ${stuck}`]);
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

  it('INV-9: names a task or an agent with overlapping executions', async () => {
    const shared = await task();
    const a = await run(shared, await agent());
    const b = await run(shared, await agent());
    const busy = await agent();
    const c = await run(await task(), busy);
    const d = await run(await task(), busy);
    const calm = await task();
    const e = await run(calm, await agent());
    const f = await run(calm, await agent());

    const t0 = Date.now() - 60_000;
    witnessed(201, a, 1, t0, t0 + 1_000);
    witnessed(202, b, 1, t0 + 500, t0 + 1_500);
    witnessed(203, c, 1, t0, t0 + 1_000);
    witnessed(204, d, 2, t0 + 900, t0 + 2_000);
    witnessed(205, e, 1, t0, t0 + 1_000);
    witnessed(206, f, 1, t0 + 1_100, t0 + 2_000);

    expect(found(await check('INV-9'))).toEqual([`INV-9 ${shared}`, `INV-9 ${busy}`].sort());
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

    await event(1, 1);
    await entry(t, r, 'before the takeover');
    await event(2, 2);
    const late = await entry(t, r, 'after the takeover');
    const lateCall = await toolCall(r, 'comment_on_task', 1);
    await entry(t, r, 'new owner', 2);

    const violations = await check('INV-3');
    expect(found(violations)).toEqual([`INV-3 ${r}`, `INV-3 ${r}`]);
    expect(violations.map((v) => v.detail.split(' ').slice(0, 2).join(' ')).sort()).toEqual(
      [`control_plane_requests ${lateCall}`, `turns ${late}`].sort()
    );
  });
});
