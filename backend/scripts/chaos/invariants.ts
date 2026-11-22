import fs from 'node:fs';
import path from 'node:path';
import type pg from 'pg';

/**
 * Invariants a chaos trial must hold at its check time, read straight from
 * the trial database and from logs kept outside it. Deliberately independent
 * of the platform's own recovery code: the queries restate each rule instead
 * of calling the functions under test.
 */
export type InvariantId =
  | 'INV-1'
  | 'INV-2'
  | 'INV-3'
  | 'INV-4'
  | 'INV-5'
  | 'INV-6'
  | 'INV-7'
  | 'INV-8'
  | 'INV-9'
  | 'INV-10';

export interface Violation {
  invariant: InvariantId;
  /** Id of the run, task, agent, or request at fault. */
  subject: string;
  detail: string;
}

export interface InvariantInput {
  db: pg.Pool | pg.ClientBase;
  /** Run each accepted wake created or merged into (INV-8). */
  wakeRuns?: string[];
  /** Fake-agent witness logs (INV-9). */
  witnessDir?: string;
  /** Platform operation witness logs the backends wrote, in the same format (INV-9). */
  platformWitnessDir?: string;
  /** Backend instances that died, by the control-plane host:port their agents saw (INV-9). */
  deaths?: { via: string; at: number }[];
  /** How long an agent may outlive the backend it worked for; default 1 s (INV-9). */
  graceMs?: number;
  /** Reconciler period; a queued run free to start for longer than this is stuck (INV-7). */
  cycleMs: number;
  /** Attempts an automatic retry chain may reach (INV-6). */
  maxAttempts: number;
  /**
   * Runs held, as (run, epoch), by each instance when it was asked to shut
   * down gracefully and finished its handoffs (INV-10).
   */
  handoffs?: { runId: string; epoch: number }[][];
  /** INV-3 needs track_commit_timestamp; nothing else may be skipped in a real trial. */
  skip?: InvariantId[];
}

const TERMINAL_TOOLS = [
  'submit_result',
  'submit_review',
  'submit_exploration',
  'submit_plan',
  'submit_plan_review',
  'submit_verification',
  'submit_triage',
  'submit_sign_off',
];
const FINAL_RUN_STATUSES = ['succeeded', 'failed', 'cancelled'];
const LIVE_WORKSPACE_EXCLUDED = ['merged', 'retained', 'abandoned'];
const EPOCH_TABLES = ['run_events', 'turns', 'change_snapshots', 'control_plane_requests', 'dispatch_reports'] as const;

type Check = (input: InvariantInput) => Promise<Violation[]>;

async function rows<T extends pg.QueryResultRow>(db: InvariantInput['db'], text: string, values: unknown[] = []) {
  return (await db.query<T>(text, values)).rows;
}

/** INV-1: no running run holds an expired or missing lease. */
const expiredLeases: Check = async ({ db }) =>
  (
    await rows<{ id: string; lease: Date | null }>(
      db,
      `SELECT id, lease_expires_at AS lease FROM runs
       WHERE status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())`
    )
  ).map((r) => ({
    invariant: 'INV-1',
    subject: r.id,
    detail: r.lease ? `running with a lease that expired at ${r.lease.toISOString()}` : 'running without a lease',
  }));

/** INV-2: one running run per agent; one running or interrupted run per gate (a worktree, or a legacy task). */
const doubleClaims: Check = async ({ db }) => {
  const byAgent = await rows<{ subject: string; ids: string[] }>(
    db,
    `SELECT agent_id AS subject, array_agg(id ORDER BY id) AS ids FROM runs
     WHERE status = 'running' AND agent_id IS NOT NULL GROUP BY agent_id HAVING count(*) > 1`
  );
  const byGate = await rows<{ subject: string; ids: string[] }>(
    db,
    `SELECT gate_key AS subject, array_agg(id ORDER BY id) AS ids FROM runs
     WHERE status IN ('running', 'interrupted') AND gate_key IS NOT NULL GROUP BY gate_key HAVING count(*) > 1`
  );
  return [
    ...byAgent.map((r) => ({ invariant: 'INV-2' as const, subject: r.subject, detail: `agent runs ${r.ids.join(', ')} at once` })),
    ...byGate.map((r) => ({ invariant: 'INV-2' as const, subject: r.subject, detail: `gate held by runs ${r.ids.join(', ')} at once` })),
  ];
};

/**
 * INV-3: nothing written under epoch e commits after the takeover to e+1.
 * The takeover writes a run event under e+1 in its own transaction, so the
 * earliest commit among e+1 events is the takeover's commit.
 */
const staleWrites: Check = async ({ db }) => {
  const [setting] = await rows<{ track_commit_timestamp: string }>(db, 'SHOW track_commit_timestamp');
  if (setting?.track_commit_timestamp !== 'on') {
    throw new Error('INV-3 needs track_commit_timestamp = on in the trial database server');
  }
  const writes = EPOCH_TABLES.map(
    (table) =>
      `SELECT '${table}' AS source, id::text AS id, run_id, epoch, pg_xact_commit_timestamp(xmin) AS at
       FROM ${table} WHERE run_id IS NOT NULL AND epoch IS NOT NULL`
  ).join(' UNION ALL ');
  return (
    await rows<{ source: string; id: string; run_id: string; epoch: number; at: Date; taken_at: Date }>(
      db,
      `WITH takeovers AS (
         SELECT run_id, epoch, min(pg_xact_commit_timestamp(xmin)) AS at
         FROM run_events WHERE epoch IS NOT NULL GROUP BY run_id, epoch
       ), writes AS (${writes})
       SELECT w.source, w.id, w.run_id, w.epoch, w.at, t.at AS taken_at
       FROM writes w JOIN takeovers t ON t.run_id = w.run_id AND t.epoch = w.epoch + 1
       WHERE w.epoch >= 1 AND w.at > t.at`
    )
  ).map((r) => ({
    invariant: 'INV-3',
    subject: r.run_id,
    detail: `${r.source} ${r.id} written under epoch ${r.epoch} committed at ${r.at.toISOString()}, after the takeover to epoch ${r.epoch + 1} at ${r.taken_at.toISOString()}`,
  }));
};

/** INV-4: a run's terminal tool takes effect once, and no effect lands twice. */
const repeatedEffects: Check = async ({ db }) => {
  const terminal = await rows<{ run_id: string; n: number }>(
    db,
    `SELECT run_id, count(*)::int AS n FROM control_plane_requests
     WHERE tool = ANY($1) GROUP BY run_id HAVING count(*) > 1`,
    [TERMINAL_TOOLS]
  );
  const repeated = await rows<{ run_id: string; n: number; content: string }>(
    db,
    `SELECT run_id, count(*)::int AS n, left(content, 80) AS content FROM turns
     WHERE run_id IS NOT NULL GROUP BY run_id, content HAVING count(*) > 1`
  );
  return [
    ...terminal.map((r) => ({ invariant: 'INV-4' as const, subject: r.run_id, detail: `${r.n} terminal tool calls recorded` })),
    ...repeated.map((r) => ({
      invariant: 'INV-4' as const,
      subject: r.run_id,
      detail: `the same timeline entry landed ${r.n} times: "${r.content}"`,
    })),
  ];
};

/** INV-5: an interrupted run has exactly one retry request, still open, and its live worktree stays quarantined. */
const unattendedInterruptions: Check = async ({ db }) => {
  const interrupted = await rows<{ id: string; requests: number; open: number; unguarded: string | null }>(
    db,
    `SELECT r.id,
       (SELECT count(*)::int FROM human_requests h WHERE h.run_id = r.id AND h.kind = 'retry') AS requests,
       (SELECT count(*)::int FROM human_requests h WHERE h.run_id = r.id AND h.kind = 'retry' AND h.status = 'open') AS open,
       (SELECT w.status FROM workspaces w
        WHERE (w.id = r.workspace_id OR (r.workspace_id IS NULL AND w.task_id = r.task_id))
          AND w.status <> ALL($1) AND w.status <> 'quarantined' LIMIT 1) AS unguarded
     FROM runs r WHERE r.status = 'interrupted'`,
    [LIVE_WORKSPACE_EXCLUDED]
  );
  const strayRequests = await rows<{ id: string; run_id: string; status: string }>(
    db,
    `SELECT h.id, h.run_id, r.status FROM human_requests h JOIN runs r ON r.id = h.run_id
     WHERE h.kind = 'retry' AND h.status = 'open' AND r.status <> 'interrupted'`
  );
  const out: Violation[] = [];
  for (const r of interrupted) {
    if (r.requests !== 1 || r.open !== 1) {
      out.push({ invariant: 'INV-5', subject: r.id, detail: `interrupted with ${r.requests} retry request(s), ${r.open} open` });
    }
    if (r.unguarded) {
      out.push({ invariant: 'INV-5', subject: r.id, detail: `interrupted while its workspace is ${r.unguarded}, not quarantined` });
    }
  }
  for (const h of strayRequests) {
    out.push({ invariant: 'INV-5', subject: h.id, detail: `open retry request on run ${h.run_id}, which is ${h.status}` });
  }
  return out;
};

/**
 * INV-6: only runs that committed nothing and left the worktree as it was
 * are retried automatically, within the attempt cap; a run that may have
 * written is never run again without a person's answer, unless its live
 * owner handed it off (stopped it, captured it, and queued the follow-up in
 * one fenced transaction). "As it was" reads the recovery snapshot, so
 * trials start from a clean worktree.
 */
const unsafeRetries: Check = async ({ db, maxAttempts }) => {
  const out: Violation[] = [];
  const dirtyRetries = await rows<{ id: string; reason: string }>(
    db,
    `SELECT r.id, CASE
         WHEN EXISTS (SELECT 1 FROM control_plane_requests c WHERE c.run_id = r.id) THEN 'committed control-plane writes'
         WHEN EXISTS (SELECT 1 FROM turns t WHERE t.run_id = r.id) THEN 'has timeline entries'
         WHEN EXISTS (SELECT 1 FROM change_snapshots s WHERE s.run_id = r.id AND s.kind = 'run') THEN 'had its changes captured'
         ELSE 'its worktree changed' END AS reason
     FROM runs r WHERE r.recovery_class = 'retry' AND (
       EXISTS (SELECT 1 FROM control_plane_requests c WHERE c.run_id = r.id)
       OR EXISTS (SELECT 1 FROM turns t WHERE t.run_id = r.id)
       OR EXISTS (SELECT 1 FROM change_snapshots s WHERE s.run_id = r.id AND s.kind = 'run')
       OR EXISTS (SELECT 1 FROM change_snapshots s WHERE s.run_id = r.id AND s.kind = 'recovery' AND s.changed_files > 0))`
  );
  for (const r of dirtyRetries) out.push({ invariant: 'INV-6', subject: r.id, detail: `classed retry but ${r.reason}` });

  const misclassed = await rows<{ id: string; recovery_class: string; terminal: boolean }>(
    db,
    `SELECT r.id, r.recovery_class,
       EXISTS (SELECT 1 FROM control_plane_requests c WHERE c.run_id = r.id AND c.tool = ANY($1)) AS terminal
     FROM runs r WHERE r.recovery_class IS NOT NULL`,
    [TERMINAL_TOOLS]
  );
  for (const r of misclassed) {
    if (r.terminal !== (r.recovery_class === 'known')) {
      out.push({
        invariant: 'INV-6',
        subject: r.id,
        detail: r.terminal ? `submitted its result but classed ${r.recovery_class}` : 'classed known without a terminal tool call',
      });
    }
  }

  const children = await rows<{
    id: string;
    parent: string;
    attempt: number;
    parent_class: string | null;
    handed_off: boolean;
    answer: string | null;
    child_op: string | null;
    parent_op: string | null;
  }>(
    db,
    `SELECT c.id, p.id AS parent, c.attempt, p.recovery_class AS parent_class,
       c.op_id AS child_op, p.op_id AS parent_op,
       (p.status = 'cancelled' AND p.stop_reason = 'handoff') AS handed_off,
       (SELECT h.answer->>'choice' FROM human_requests h
        WHERE h.run_id = p.id AND h.kind = 'retry' AND h.status = 'answered') AS answer
     FROM runs c JOIN runs p ON p.id = c.parent_run_id`
  );
  const perParent = new Map<string, number>();
  for (const c of children) {
    perParent.set(c.parent, (perParent.get(c.parent) ?? 0) + 1);
    // A platform operation is redone from what Git shows, so running it again needs nobody's answer;
    // it must stay the same operation, within the attempt cap.
    if (c.parent_op !== null || c.child_op !== null) {
      if (c.parent_op !== c.child_op) {
        out.push({
          invariant: 'INV-6',
          subject: c.id,
          detail: `follows ${c.parent} for operation ${c.child_op ?? 'none'}, not ${c.parent_op ?? 'none'}`,
        });
      }
      if (c.attempt > maxAttempts) {
        out.push({ invariant: 'INV-6', subject: c.id, detail: `operation retried at attempt ${c.attempt}, over the cap of ${maxAttempts}` });
      }
      continue;
    }
    if (c.parent_class === 'retry' && c.attempt > maxAttempts) {
      out.push({ invariant: 'INV-6', subject: c.id, detail: `automatic retry at attempt ${c.attempt}, over the cap of ${maxAttempts}` });
    }
    if (c.parent_class !== 'retry' && !c.handed_off && c.answer !== 'continue' && c.answer !== 'discard') {
      out.push({
        invariant: 'INV-6',
        subject: c.id,
        detail: `runs again after ${c.parent}, classed ${c.parent_class ?? 'nothing'}, without a person choosing continue or discard`,
      });
    }
  }
  for (const [parent, n] of perParent) {
    if (n > 1) out.push({ invariant: 'INV-6', subject: parent, detail: `${n} follow-up runs` });
  }
  return out;
};

/**
 * INV-7: no queued run sits free to start for longer than a reconciler cycle:
 * its agent (when it has one) and its gate (when it has one) free, and its
 * own worktree not quarantined, unless it is one of the operations that
 * release a quarantine. Platform runs, which have no agent, count too.
 */
const stuckQueue: Check = async ({ db, cycleMs }) =>
  (
    await rows<{ id: string }>(
      db,
      `SELECT q.id FROM runs q
       WHERE q.status = 'queued' AND (q.agent_id IS NOT NULL OR q.actor = 'platform')
         AND q.created_at <= clock_timestamp() - $1 * interval '1 millisecond'
         AND (q.not_before IS NULL OR q.not_before <= clock_timestamp() - $1 * interval '1 millisecond')
         AND (q.agent_id IS NULL OR NOT EXISTS (SELECT 1 FROM runs r WHERE r.status = 'running' AND r.agent_id = q.agent_id))
         AND (q.gate_key IS NULL OR NOT EXISTS (
           SELECT 1 FROM runs r WHERE r.status IN ('running', 'interrupted') AND r.gate_key = q.gate_key))
         AND (EXISTS (SELECT 1 FROM platform_ops o WHERE o.id = q.op_id AND o.kind IN ('reset_to_before', 'reconcile_worktree'))
           OR NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.status = 'quarantined'
             AND (w.id = q.workspace_id OR (q.workspace_id IS NULL AND w.task_id = q.task_id))))`,
      [cycleMs]
    )
  ).map((r) => ({ invariant: 'INV-7', subject: r.id, detail: `queued and free to start for over ${cycleMs} ms` }));

/** INV-8: every accepted wake ends, through its retries, in a final state or a person's decision. */
const unsettledWakes: Check = async ({ db, wakeRuns = [] }) => {
  const out: Violation[] = [];
  for (const runId of new Set(wakeRuns)) {
    const [last] = await rows<{ id: string; status: string; open_request: boolean }>(
      db,
      `WITH RECURSIVE chain AS (
         SELECT id, 0 AS depth FROM runs WHERE id = $1
         UNION ALL SELECT r.id, c.depth + 1 FROM runs r JOIN chain c ON r.parent_run_id = c.id
       )
       SELECT r.id, r.status, EXISTS (
         SELECT 1 FROM human_requests h WHERE h.run_id = r.id AND h.kind = 'retry' AND h.status = 'open'
       ) AS open_request
       FROM chain JOIN runs r ON r.id = chain.id ORDER BY chain.depth DESC LIMIT 1`,
      [runId]
    );
    if (!last) {
      out.push({ invariant: 'INV-8', subject: runId, detail: 'accepted wake has no run' });
    } else if (!FINAL_RUN_STATUSES.includes(last.status) && !(last.status === 'interrupted' && last.open_request)) {
      out.push({
        invariant: 'INV-8',
        subject: runId,
        detail: `wake still unsettled: its latest run ${last.id} is ${last.status}${last.status === 'interrupted' ? ' with no open request' : ''}`,
      });
    }
  }
  return out;
};

export interface Execution {
  key: string;
  run: string;
  epoch: number;
  via: string | null;
  start: number;
  end: number;
}

/** Witnessed executions, one per (pid, run, epoch), from first to last line. */
export function readExecutions(dir: string): Execution[] {
  const byKey = new Map<string, Execution>();
  for (const file of fs.readdirSync(dir)) {
    for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const w = JSON.parse(line) as { run: string | null; epoch: number | null; via?: string | null; pid: number; t: number };
      if (!w.run || w.epoch === null) continue;
      const key = `${w.pid}/${w.run}/${w.epoch}`;
      const seen = byKey.get(key);
      if (seen) {
        seen.start = Math.min(seen.start, w.t);
        seen.end = Math.max(seen.end, w.t);
      } else {
        byKey.set(key, { key, run: w.run, epoch: w.epoch, via: w.via ?? null, start: w.t, end: w.t });
      }
    }
  }
  return [...byKey.values()];
}

/**
 * INV-9: no double execution. Executions on the same gate (a worktree, or a
 * legacy task), or by the same agent, never overlap; platform operations
 * are witnessed like agents. An orphaned agent still beating next to the next
 * attempt shows up here, which a per-run check would miss. An agent also
 * stops within the grace period once the backend it worked for dies, so an
 * orphan is caught even when it happens to finish before the next attempt.
 */
const doubleExecutions: Check = async ({ db, witnessDir, platformWitnessDir, deaths = [], graceMs = 1_000 }) => {
  const executions = [witnessDir, platformWitnessDir]
    .filter((dir): dir is string => dir !== undefined && fs.existsSync(dir))
    .flatMap((dir) => readExecutions(dir));
  if (executions.length === 0) return [];
  const owners = new Map(
    (
      await rows<{ id: string; gate_key: string | null; agent_id: string | null }>(
        db,
        'SELECT id, gate_key, agent_id FROM runs WHERE id = ANY($1::uuid[])',
        [[...new Set(executions.map((e) => e.run))]]
      )
    ).map((r) => [r.id, r])
  );
  const out: Violation[] = [];
  for (const scope of ['gate_key', 'agent_id'] as const) {
    const groups = new Map<string, Execution[]>();
    for (const e of executions) {
      const owner = owners.get(e.run)?.[scope];
      if (!owner) continue;
      groups.set(owner, [...(groups.get(owner) ?? []), e]);
    }
    for (const [owner, list] of groups) {
      list.sort((a, b) => a.start - b.start);
      for (let i = 1; i < list.length; i += 1) {
        const earlier = list.slice(0, i).find((prev) => prev.end > list[i]!.start);
        if (earlier) {
          out.push({
            invariant: 'INV-9',
            subject: owner,
            detail: `${scope === 'gate_key' ? 'gate' : 'agent'} executed ${earlier.key} and ${list[i]!.key} at once (${list[i]!.start} < ${earlier.end})`,
          });
        }
      }
    }
  }
  for (const death of deaths) {
    for (const e of executions) {
      if (e.via === death.via && e.start <= death.at && e.end > death.at + graceMs) {
        out.push({
          invariant: 'INV-9',
          subject: e.run,
          detail: `agent ${e.key} kept running ${e.end - death.at} ms after the backend at ${death.via} died`,
        });
      }
    }
  }
  return out;
};

/**
 * INV-10: an instance shut down gracefully hands off every run it held: each
 * one ends under the epoch it held, either settled by the owner or handed
 * off. A run handed off after submitting its result succeeded with no
 * follow-up, as does one whose workshop dispatch was told to stop or whose
 * platform operation was no longer wanted; any other has exactly one. None
 * is taken over, interrupted, or left running.
 */
const lostHandoffs: Check = async ({ db, handoffs = [] }) => {
  const out: Violation[] = [];
  for (const { runId, epoch } of handoffs.flat()) {
    const [run] = await rows<{
      status: string;
      owner_epoch: number;
      stop_reason: string | null;
      children: number;
      terminal: boolean;
      released: boolean;
    }>(
      db,
      `SELECT r.status, r.owner_epoch, r.stop_reason,
         (SELECT count(*)::int FROM runs c WHERE c.parent_run_id = r.id) AS children,
         EXISTS (SELECT 1 FROM control_plane_requests q WHERE q.run_id = r.id AND q.tool = ANY($2)) AS terminal,
         (EXISTS (SELECT 1 FROM dispatches d WHERE d.id = r.dispatch_id AND d.cancel_requested_at IS NOT NULL)
           OR EXISTS (SELECT 1 FROM platform_ops o WHERE o.id = r.op_id AND o.status IN ('cancelled', 'failed'))) AS released
       FROM runs r WHERE r.id = $1`,
      [runId, TERMINAL_TOOLS]
    );
    const fail = (detail: string) => out.push({ invariant: 'INV-10', subject: runId, detail });
    if (!run) fail('run is gone');
    else if (run.owner_epoch !== epoch) fail(`taken over at epoch ${run.owner_epoch} instead of handed off at ${epoch}`);
    else if (!FINAL_RUN_STATUSES.includes(run.status)) fail(`${run.status} after its owner shut down`);
    else if (run.stop_reason === 'handoff') {
      const expected = run.terminal || run.released ? 0 : 1;
      if (run.terminal && run.status !== 'succeeded') fail(`submitted its result but handed off as ${run.status}`);
      if (run.children !== expected) fail(`handed off with ${run.children} follow-up runs, expected ${expected}`);
    }
  }
  return out;
};

const CHECKS: [InvariantId, Check][] = [
  ['INV-1', expiredLeases],
  ['INV-2', doubleClaims],
  ['INV-3', staleWrites],
  ['INV-4', repeatedEffects],
  ['INV-5', unattendedInterruptions],
  ['INV-6', unsafeRetries],
  ['INV-7', stuckQueue],
  ['INV-8', unsettledWakes],
  ['INV-9', doubleExecutions],
  ['INV-10', lostHandoffs],
];

/** Runs every invariant not skipped; throws when the setup cannot support one. */
export async function checkInvariants(input: InvariantInput): Promise<Violation[]> {
  const out: Violation[] = [];
  for (const [id, check] of CHECKS) {
    if (input.skip?.includes(id)) continue;
    out.push(...(await check(input)));
  }
  return out;
}
