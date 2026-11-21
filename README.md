# Loxo

**A control plane for persistent AI agent teams.**

Loxo coordinates continuous work across coding agents and API agents: assign tasks, isolate code changes, observe execution, review system-captured evidence, and keep humans in control of completion. Agent runtimes do the work; Loxo provides ownership, audit trails, review gates, and cost tracking around it.

*TypeScript end to end · Express + Postgres backend · Next.js 14 frontend · 450+ automated tests*

## Core loop

```
Task ──> Assign (wake) ──> Run ──> Review ──> Done
            ▲                         │
            └── rejection re-wakes ───┘
```

Every task has a lead, every run leaves evidence, and every completion passes through a human-controlled boundary. Rejected work returns to the lead with feedback; an agent approval is a recommendation, not permission to ship.

## Why Loxo

### Evidence, not self-reporting

Agent-authored summaries provide context, but the platform collects the proof.

- **Isolated git workspaces** — each task runs in its own git worktree and branch. After every run, including failures and cancellations, Loxo captures the diff, patch, file summary, and change fingerprint.
- **Permission ceilings** — workspace access is enforced as read-only, edit, or full. Review turns are always read-only; tracked-file mutations become visible policy violations on the task timeline.
- **Snapshot-pinned approvals** — approvals bind to the exact captured change snapshot. If the workspace changes afterward, the approval becomes stale and cannot authorize a merge.

### Concurrency enforced by the system

Agents are concurrent OS processes, so correctness cannot depend on caller discipline.

- **One admission surface** handles assignment, manual wake, and review rejection. It merges duplicate triggers into the run already queued, or queues the request FIFO.
- **Admission is one statement**, guarded by partial unique indexes: one running run per agent and one running or interrupted run per task, so no agent or task ever executes two runs at once, whichever path woke them.
- **Leased, fenced ownership**: every running run belongs to one backend process under a lease and an epoch, and every platform write checks that epoch in the same transaction (see below).

### Crash-safe runs

The backend can die mid-run, or a second one can start against the same database. Runs are owned under database-clock leases with epoch fencing: a takeover invalidates the old owner's writes and MCP tokens, and agents run under a launcher that takes their whole process tree down with the backend. Recovery classifies each lost run by what it committed. A run that did nothing is retried automatically; a run that submitted its result settles; anything else waits, with its workspace quarantined, for a person to continue, discard, or stop. A backend asked to stop, as a deploy does, hands its runs off instead: each agent is cancelled and its work captured, and a follow-up run on the next instance resumes the same agent session without a person. Details are in [docs/durable-runs.md](docs/durable-runs.md).

Measured against real backend processes, killed at named crash points or stopped mid-run (`npm run chaos -w backend`):

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

### Human authority at the final boundary

The task's other members review the lead's work. They can reject it, reopen the task, and re-wake the lead; their approvals only recommend completion, and only a person records an approval. A three-cycle fuse stops automated rejection loops and escalates them for human review.

## Execution model

### Two coding CLIs over ACP, plus API agents

Loxo drives Claude Code and Codex over the [Agent Client Protocol](https://agentclientprotocol.com), and API agents through OpenAI Chat Completions or Anthropic Messages.

- **CLI agents** handle code, files, and commands in isolated workspaces.
- **API agents** handle triage, review, and summarization through an in-process tool loop with read-only repository tools.

Both use the same agent model, governance rules, run history, and review flow.

### Live sessions and platform-decided permissions

Every runtime sits behind one host interface. A CLI agent runs in a long-lived ACP session: tool calls stream into the run's event log as they happen, and every permission request is decided by Loxo's policy — inside its own worktree the agent may proceed, outside it is refused, and commands such as `git push`, `sudo`, or recursive deletes outside the worktree go to a person. Unanswered questions are denied when they expire. A watchdog stops turns that go silent, stop making progress, or repeat themselves.

The two CLIs reach that policy differently:

- **Claude Code** stays in its default permission mode, so every tool call and command asks Loxo first. Loxo switches a session back if it leaves that mode, and refuses to start one it cannot hold there. The commands themselves are not sandboxed.
- **Codex** runs commands inside its own OS sandbox, which can write only the worktree and temporary directories and has no network access, and asks Loxo only to go beyond it. Loxo does not see commands that stay inside the sandbox, and a refused escalation ends Codex's turn.

For both, the worktree is isolated, its state is pinned before the run, every change is captured, and approvals bind to the captured snapshot. Calls to Loxo's own control-plane tools are allowed without asking, since the run token already decides what each call may do.

| Runtime | Transport | Permissions | Live events |
|---|---|---|---|
| Claude Code | ACP through `@agentclientprotocol/claude-agent-acp` | Every tool call decided by Loxo | Yes |
| Codex | ACP through `@agentclientprotocol/codex-acp` | Codex sandbox; escalations decided by Loxo | Yes |
| API agents | Provider API tool loop | Read-only worktree tools only | Yes |

`npm run runtimes:install` installs the pinned adapters into Loxo's storage directory. They drive the CLIs you already have installed, with their existing logins. A CLI agent cannot run until its adapter is installed; its run fails with the install command, and `GET /api/providers/runtime-health` reports which runtimes are ready.

### MCP control plane

Woken agents call back through six MCP tools: `get_task`, `comment_on_task`, `update_task_status`, `submit_review`, `ask_blocker`, and `submit_result`. Every run receives a stateless HMAC-signed token bound to the run's owner epoch, so a takeover invalidates it; validity is checked against run state on every call. If an agent posts nothing through these tools, its final reply lands on the timeline instead.

## Feature tour

| Surface | What it does |
|---|---|
| **Task board** | Enforces a server-side state machine. The client mirrors valid transitions, while fractional ordering makes a drag operation one `PATCH` instead of a full-column renumber. |
| **Agents** | Manages persistent agents, runtime bindings, provider credentials, and permission levels. |
| **Runs** | Records every wake-up with its transcript, status, token usage, cost, task, and captured workspace evidence. |
| **Repositories** | Registers local git repositories; agents work in managed worktrees on `loxo/` branches beside your checkout. |

![Task detail — every task renders as a thermal-printer work order; the rubber stamp is the status control](docs/screenshots/task-detail.png)

## Architecture

```mermaid
flowchart LR
    subgraph Client
        FE[Next.js 14 web app<br/>Kanban and task detail]
    end
    subgraph Server[Backend REST and WebSocket on port 4000]
        API[Express REST API]
        WS[WebSocket gateway<br/>task events]
        WAKE[Wake admission<br/>claims, locks, FIFO]
        MCP[MCP control plane<br/>6 tools and run tokens]
        RUNNER[Agent runner<br/>ACP sessions and API agents]
    end
    subgraph Data
        PG[(Postgres 16<br/>16 tables and Drizzle ORM)]
        FS[Workspace storage<br/>git worktrees and manifests]
    end
    LLM[OpenAI and Anthropic APIs]

    FE -->|REST| API
    FE -->|WebSocket upgrade| WS
    API --> WAKE --> RUNNER
    RUNNER --> MCP
    RUNNER -->|ACP session| FS
    RUNNER -->|SSE| LLM
    API --> PG
```

- **One backend port** serves REST and WebSocket traffic through HTTP upgrade.
- **Postgres 16 + Drizzle ORM** provides migration history, normalized relations, execution locks, and review state.
- **Security posture:** provider keys use AES-256-GCM encryption at rest; startup fails without `JWT_SECRET`; path checks fence workspace access.
- **Monorepo:** npm workspaces; `backend/` contains 13 domain modules, `frontend/` contains 10 App Router routes, `packages/shared/` holds runtime types and process helpers, and `packages/fake-agent/` is a scripted ACP agent for tests.

## Getting started

Prerequisites: Node.js 20+, Docker, and Git.

From the repository root, install every workspace and start Postgres:

```bash
npm install
docker compose up -d
```

Configure the environment files:

```bash
cp backend/.env.example backend/.env     # PowerShell: Copy-Item backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
# Set JWT_SECRET and SECRETS_KEY in backend/.env; generation guidance is in the file.
```

Apply migrations, then start the backend and frontend in separate terminals:

```bash
npm run db:migrate
npm run dev:backend
npm run dev:frontend
```

Open `http://localhost:3000`, register an account, and then:

1. Run `npm run runtimes:install` for Claude Code or Codex, or configure an OpenAI or Anthropic provider for API agents.
2. Create an agent and register a local git repository.
3. Create a task, assign it, and inspect the resulting run and evidence.

Tasks without a repository run in the agent's own workspace.

## Testing

```bash
npm test                          # 450+ backend tests: API, runs, ownership and recovery, governance, workspaces, migrations
npm run test:coverage -w backend  # the same, failing below 90% line coverage of the run-ownership modules
npm run typecheck                 # backend and frontend
```

Every agent host passes one shared contract (`backend/test/conformance/host-contract.ts`): it completes and streams a turn, runs one turn at a time, cancels promptly, reports failures as outcomes, and closes cleanly. A scripted ACP agent (`packages/fake-agent`) drives the hosts through stalls, crashes, malformed output, and permission requests. To run the same contract against the real Claude Code and Codex CLIs — this spends model tokens — install the adapters and opt in:

```bash
npm run runtimes:install
LOXO_REAL_CLI=1 npm test -- test/real-cli.test.ts   # PowerShell: $env:LOXO_REAL_CLI=1; npm test -- test/real-cli.test.ts
```

The suite covers admission and agent claims, leases and fencing, recovery and takeover races, workspace capture, permission enforcement, snapshot-bound approval, schema-level invariants, upgrades of populated databases, and real-git proof that managed worktrees never touch your checkout.

Crash recovery is tested against real backend processes on a separate Postgres with commit timestamps enabled:

```bash
docker compose --profile chaos up -d --wait
npm run chaos -w backend -- --trials 3 --controls 2 --two 3   # results in results/chaos/<date>/
```

## Status and roadmap

Loxo is under active solo development. The single-agent loop — tasks, wakes, runs, reviews, and workspaces — works end to end and survives a killed or restarted backend, with crews and task members as the base for multi-agent work. Next up:

- **Task engine** — declarative playbooks that take a crew through explore, plan, parallel build, integration, cross-review, and sign-off.
- **Delivery** — local merge or a GitHub pull request, gated on a person's approval of the signed candidate.
- **Local mode** — one command with embedded Postgres, plus desktop builds.

## Repository layout

```
backend/          Express API, WebSocket gateway, and agent runner
frontend/         Next.js 14 app with Tailwind and Zustand
packages/shared/  Runtime types, permission levels, and process-tree helpers
packages/fake-agent/  Scripted ACP agent used by the test suite
```
