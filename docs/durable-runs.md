# Crash-safe runs

A Loxo run is one agent working one task: a CLI agent in its own process, editing a git worktree and calling back into the platform through MCP tools. The backend can die at any point in that run — `kill -9`, an out-of-memory kill, a host reboot, or a second backend process started by mistake against the same database. It is also stopped on purpose, by every deploy.

This document describes how Loxo keeps that from corrupting state, how it recovers, how a planned stop hands runs off, and how the claims are tested.

**Guarantees.** When a backend process dies, or two run against one database:

- No accepted wake is lost: every run ends in a final state or in a question to a person.
- A run that may have changed something is never replayed silently. Only a run that provably did nothing is retried automatically.
- A process that lost ownership of a run, including the agent processes it started, cannot change platform state, and its agent processes are ended.
- No task and no agent executes two runs at once.

**When a backend is asked to stop**, its runs continue on the next instance in the same agent session, without a person.

## Ownership

**Leases on the database clock.** A running run carries `owner_instance`, `owner_epoch`, and `lease_expires_at`.

- Each backend process has a random instance id.
- Leases are 30 seconds by default (`RUN_LEASE_TTL_MS`) and measured on the database clock (`clock_timestamp()`), never on a backend's clock.
- One statement per instance renews all of its leases every third of the lease. It runs on a dedicated connection, so a busy pool cannot starve it, and skips rows that are locked.

**The epoch is the fencing token.** Admission sets the epoch; every takeover increments it. Anything an owner writes is conditioned on the epoch it holds. Once a run has been taken over, the old owner's writes match nothing.

**Admission is one statement.** A queued run becomes running in a single `UPDATE`. Two partial unique indexes guard it:

- one running run per agent;
- one running or interrupted run per task.

A gate that is already held surfaces as a unique violation, and the run stays queued. A `CHECK` constraint requires every running row to have an owner and a lease.

**Self-fencing.** An owner computes a local deadline from the lease the database reported. The deadline is the lease minus a kill budget (`RUN_KILL_BUDGET_MS`, 3 s by default) and one second of timer jitter, tracked on both the monotonic and the wall clock. Reaching the deadline without a renewal (an event-loop stall, a laptop sleep, a lost database connection) makes the instance stop acting for the run and kill its agent before the lease can expire in the database.

## Fenced writes

Every write an owner makes for a run — settling it, recording its events, capturing its worktree changes, adding timeline entries, and every control-plane tool call — runs in a transaction that first does two things:

- locks the run row `FOR KEY SHARE`;
- checks status, instance, and epoch.

A takeover locks the same row `FOR UPDATE`, so it waits for in-flight owner writes to commit, and every later write under the old epoch fails. Renewals take `FOR NO KEY UPDATE`, which never waits on an owner write. Every transaction locks the run row before any other row, so these paths cannot deadlock. Refused writes are logged as `fence_rejected`.

**Run tokens carry the epoch.** An agent's MCP token is `srt_<run>_<epoch>_<hmac>`. A takeover invalidates every token minted before it without storing or revoking anything.

**Control-plane calls are atomic and idempotent.**

- Each tool call is one transaction.
- Terminal tools (`submit_result`, `submit_review`) take effect at most once per run, and an immediately repeated identical call returns the recorded result.
- Wakes a call causes are queued as runs inside the same transaction (an outbox) and started after commit. If the process dies in between, the reconciler promotes them.

## Recovery

A reconciler runs on every instance at start-up and then every half lease, plus jitter. Each pass does three things:

1. Takes over runs whose lease expired, one transaction each.
2. Stops interrupted runs whose decision expired.
3. Promotes queued runs whose agent and task are free, oldest first.

Passes can overlap and run on several instances; every step is a conditional statement or a single transaction.

A takeover keeps the run `running` under the new epoch and records a run event under that epoch, then drives recovery through `taken_over → assessed → resolved`. Each step can be redone after a crash, so a recoverer that dies is simply taken over again.

**Assess** first ends whatever is left of the agent (see below), then reads what the run committed:

- control-plane requests;
- a captured change snapshot;
- run-tagged timeline entries.

It then compares the worktree with the state pinned when the run started. Before the agent starts, the platform writes the worktree's full state, untracked files included, to `refs/loxo/runs/<id>/before` and records its head and tree on the run.

**Resolve** acts on the class:

| Class | When | Outcome |
|---|---|---|
| `known` | The run already submitted its result | Settled as succeeded. A workspace it could write to is quarantined until reconciled. |
| `retry` | Nothing committed, worktree unchanged, its processes verified gone | Failed, and retried as a new run (`parent_run_id`, `attempt + 1`) after an exponential back-off: 5 s, then 10 s, at most 3 attempts. |
| `interrupted` | Anything else | Held as `interrupted`. Its workspace is quarantined, and a person gets one retry request. |

The person answers the retry request with:

- **continue:** queue a follow-up run on the worktree as it is;
- **discard:** restore the worktree to the pinned state, proven by comparing trees, then queue a follow-up run;
- **stop:** end the run.

A request unanswered for 24 hours counts as stop. The task page shows the open request with exactly these choices.

A follow-up run of the same agent tries to reattach the earlier session (`session/resume`, then `session/load`). If neither works, it starts a new session with a note that the earlier context was lost.

## Graceful shutdown

Without a handoff, a planned stop is a crash: runs wait for their leases to expire, and every run that wrote a file goes to a person. A deploy would do that to every run in flight.

`SIGTERM`, `SIGINT`, or a `{ "type": "shutdown" }` message from the parent process starts the stop. Windows cannot deliver `SIGTERM` to a Node process, so a supervisor there sends the message.

1. **Drain.** The reconciler stops and the instance admits no more runs; new wakes stay queued for another instance or the next start. HTTP stays open, because the instance's agents reach the control plane through it.
2. **Hand off.** Each run in flight is cancelled. An agent still working after `RUN_HANDOFF_GRACE_MS` (5 s) has its session closed and its process tree ended, and a run still starting never launches its agent. The worktree is captured as usual. One fenced transaction then settles the run as `cancelled` with `stop_reason = handoff` and queues one follow-up run of the same agent, with the same attempt number. A run whose turn had already ended settles normally, and a run that had already submitted its result settles as succeeded with no follow-up.
3. **Exit.** WebSocket, HTTP, the lease connection, and the database pool close only after the handoffs. `SHUTDOWN_TIMEOUT_MS` (25 s, under the default 30 s Kubernetes grace period) bounds the whole stop. Past it the process exits anyway, and any run not yet handed off is still leased and recovers as after a crash.

Another instance's reconciler promotes the follow-up run, or the restarted instance's first pass does. It reattaches the agent's session like any follow-up run.

The follow-up needs no person because, unlike after a crash, nothing about the run is unknown. The owner was alive throughout: it cancelled the agent, captured the worktree, and committed or rolled back every control-plane write before giving the run up. A person's continue would do the same thing.

A crash during the handoff is covered by two crash points: before the handoff commits, the run falls back to crash recovery; after it commits, the handoff stands.

## Orphaned agent processes

Killing a backend does not kill what it started. On Windows, a CLI behind a `.cmd` shim leaves descendants that no longer have a live parent, and `taskkill /T` cannot find them. On POSIX, the whole process group survives.

Agents therefore start under a small launcher tied to the backend process:

- **Windows:** a C# launcher, compiled on first use with the .NET Framework compiler that ships with Windows and self-tested before use. It puts itself in a Job Object with kill-on-close, starts the agent inside it, and waits on the backend's process handle. When either one exits, the job closes and every descendant goes with it, including those whose own parent already exited.
- **POSIX:** a Node launcher that leads its own process group, checks every 250 ms that its parent is still alive, and kills the group when the parent is gone.

Each launch records the launcher's pid, a random tag passed on its command line, and the host. Recovery ends a launcher only when it is on the same host, the pid is alive, and its command line carries the tag, so a reused pid is never killed. It then confirms the launcher is gone. A run whose processes cannot be verified gone is never retried automatically. That covers no launcher, another host, or an unreadable command line.

Agents and the git processes the platform runs also get an allowlisted environment, so `DATABASE_URL`, `SECRETS_KEY`, and `JWT_SECRET` never reach them.

## Invariants

The chaos invariant checker (`backend/scripts/chaos/invariants.ts`) reads these from the database and from logs kept outside it. It restates each rule as a query rather than calling the recovery code it checks.

| | Invariant |
|---|---|
| INV-1 | No run is running with an expired or missing lease. |
| INV-2 | At most one running run per agent; at most one running or interrupted run per task. |
| INV-3 | No write under epoch *e* commits after the takeover to *e + 1*. Uses commit timestamps of run events, timeline entries, change snapshots, and control-plane requests. |
| INV-4 | A run's terminal tool takes effect at most once, and no effect lands twice. |
| INV-5 | An interrupted run has exactly one retry request, still open, and its workspace stays quarantined. |
| INV-6 | Only runs that committed nothing and left the worktree unchanged are retried automatically, within the attempt cap. Recovery's class agrees with what the run committed. No run is replayed without a person choosing continue or discard, except the one follow-up of a handoff. |
| INV-7 | No queued run sits with both gates free for longer than a reconciler cycle. |
| INV-8 | Every wake ends, through its retries, in a final state or an open request to a person. |
| INV-9 | No task or agent executes two runs at once, and no agent keeps working more than a second after the backend it worked for died. |
| INV-10 | A backend stopped gracefully gives up every run it held under the epoch it held: settled by itself or handed off, never taken over, interrupted, or left running. A handed-off run has exactly one follow-up, or none if it had already submitted its result, in which case it succeeded. |

INV-9 comes from the agents themselves. During a prompt, the scripted test agent writes a heartbeat every 50 ms to a file outside the database, tagged with the run and epoch from its token and the control plane it talks to.

## Chaos testing

**Crash points.** Fourteen named points in a run's life — from the wake's commit, through admission, process start, tool calls, capture, and settlement, to each recovery step, a person's decision, and a handoff — can end the process on demand:

- `LOXO_CRASH_AT=<point>[@<n>]` logs the hit and sends the process `SIGKILL` on its n-th pass. No `finally` block or exit hook runs, as with an outside `kill -9`.
- `LOXO_STALL_AT=<point>[@<n>]=<ms>` blocks the event loop instead, like a long GC pause.

**Trials.** Each trial runs against real backend processes, started as production starts them:

1. Clone a fresh database from a migrated template.
2. Start a backend with a fault armed; drive it through the HTTP API to wake a scripted agent.
3. Let the backend die at the point, kill it from outside at a random moment, or ask it to stop at a random moment.
4. Start a fresh instance to recover.
5. At a fixed check time (crash + lease + two reconciler cycles + longest back-off + one run), run the checker.

Second crashes are supported, both during recovery and while a person's discard is being carried out.

**The crash matrix** crosses five run kinds with every crash point each one passes outside a handoff, plus random kills, second crashes in each recovery step, and crashes while a person's continue or discard is carried out: 51 cells over twelve points. The run kinds are:

- read-only;
- posts a comment;
- submits a result;
- may edit but changes nothing;
- writes a file.

**Graceful cells** give each run kind a stop requested at a random moment mid-run, and the same stop with the process killed just before or just after its handoff commits: 15 cells.

**Controls** repeat random kills with the launcher turned off, to show what the checker catches when orphans survive.

**Two instances** race on one database: 50 tasks on 10 agents, all woken at once through both instances. Mid-run, one instance is killed and restarted, frozen past its leases, or stopped gracefully as in a rolling restart. A frozen instance's writes after waking must be refused by the fence.

Run it locally:

```bash
docker compose --profile chaos up -d --wait          # Postgres with commit timestamps, on 5435
npm run chaos -w backend -- --trials 3 --controls 2 --two 3
npm run chaos -w backend -- --kind edit-dirty --first run.before_settle --second decision.before_commit --answer discard
npm run chaos -w backend -- --kind edit-dirty --first graceful
```

Results go to `results/chaos/<date>/`, and `--out <dir>` adds a later invocation to an existing directory:

- one line per trial in `trials.jsonl`, `controls.jsonl`, and `two-instances.jsonl`;
- one line per driver invocation in `invocations.jsonl`, with its commit and a dirty flag;
- `summary.json`, rebuilt from every line in the directory after each invocation.

## Results

These numbers are rendered from the summary named in the marker; `npm run chaos:results -w backend -- --check` fails in CI if they drift from it. The unreached graceful trial never started: its first backend instance printed nothing and did not answer within 60 seconds, before any stop was requested.

<!-- chaos-results:begin source=results/chaos/2026-11-21/summary.json -->
| | Result |
|---|---|
| **Crash matrix** | 153 trials: 12 crash points across 5 run kinds, 3 per cell, the backend process killed outright each time. **0 invariant violations**, 0 errors, 0 unreached |
| **Recovery** | From the crash until every run the dead instance owned was resolved: p50 **4.3 s**, p99 **7.0 s** (4.0 s lease) |
| **Graceful shutdown** | 45 trials across 5 run kinds: the backend asked to stop mid-run, as a deploy does (15), or crashing partway through handing its runs off (30). **0 invariant violations**, 0 errors, 1 unreached; after a clean shutdown 0 runs waited on a person. The instance exits in p50 **0.5 s**, and the work resumes on the next instance p50 **2.1 s**, p99 **2.7 s** after the request |
| **Orphaned agents** | Longest an agent kept working after its backend died: **0 ms** with the launcher; up to **5.0 s** without it, caught in 10 of 10 control trials |
| **Two instances, one database** | 9 races of 50 concurrent wakes, one instance killed, frozen past its lease, or shut down gracefully mid-run: **0 invariant violations** (no run executed twice), 22 takeovers, 1 stale write refused by the fence, up to 10 runs at once |

Commit `0fdfb39`, Windows, Node v24.22.1, 2026-11-21.
<!-- chaos-results:end -->

## Known limitations

- Recovery takes about one lease plus one reconciler cycle; the chaos runs use a 4 s lease to keep trials short, against a 30 s default.
- A handoff interrupts the agent's current step, as pressing Esc in the CLI would. The follow-up resumes the conversation, not the step: a command cut off midway may have left partial output, and the agent runs it again.
- Handoffs do not count toward the retry cap, so a backend restarted in a loop hands the same run off every time.
- On Windows, an outside `SIGTERM` kills a Node process outright; that stop is recovered as a crash. Only the parent process's message or Ctrl+C gives a graceful stop there.
- The fence stops an honest owner that is out of date, not a malicious agent.
- File writes by an agent after its owner died are bounded by the launcher, the quarantine, and snapshot-pinned approvals, but not proven to be zero.
- Recovery steps do not renew their own lease. A git assessment longer than the lease is redone by the next instance; the old recoverer's writes are refused, so it only costs time.
- If two people answer the same retry request at once, a discard's worktree restore can run while the other answer's transaction wins.
- Discard restores file contents but not which changes were staged before the run.
- The POSIX launcher cannot reach descendants that start their own session with `setsid`.
- A launcher can only be verified on its own host, so in a multi-host deployment write runs lose automatic retry.
- The pinned state does not include ignored files; a run that only touched ignored files counts as unchanged.
- A run that crashed after its worktree was pinned but before its agent's identity was recorded is indistinguishable from one whose agent did start. It goes to a person instead of being retried.
- A stale merge lock is recognized by its lease. A holder cut off from the database for longer than the lease may see another instance begin recovery while git is still merging; recovery proves the git state before touching it.
- The published chaos results come from one Windows machine. CI runs the test suite on Linux, including the launcher and orphan tests, but not the chaos matrix.
- The chaos agents are scripted, not real CLIs. The witness relies on their cooperation, and their heartbeat bounds timing precision to 50 ms. Claude Code and Codex were each put through one crash and one graceful stop by hand mid-task, and both resumed their session and finished; those drills are not automated.
