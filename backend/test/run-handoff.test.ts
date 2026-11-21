import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { RunnerError } from '@swarmdev/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { db, pool } from '../src/db/client';
import { agents, changeSnapshots, runEvents, runs, turns, type Run } from '../src/db/schema';
import { createApp } from '../src/http/app';
import type { AgentHost, AgentSession, OpenSessionInput, TurnInput, TurnOutcome } from '../src/modules/hosts/host.types';
import { HostStartupError } from '../src/modules/hosts/acp-host';
import { armCrashPointForTests } from '../src/modules/ownership/crash-points';
import { HANDOFF_STOP_REASON } from '../src/modules/ownership/handoff';
import { runLeases } from '../src/modules/ownership/lease';
import { reconcileOnce } from '../src/modules/ownership/reconciler';
import { setTaskHostFactoryForTests, CONTEXT_LOST_NOTE } from '../src/modules/runs/task-run';
import { drainRunsForTests, handOffActiveRuns, requestWake } from '../src/modules/runs/wake';
import { initFixtureRepo, makeSandbox, removeSandbox } from './fixtures/git-repo';
import { scriptedHost, type ScriptedAgent } from './support/scripted-host';

/**
 * Graceful shutdown hands each run this instance executes to a follow-up
 * run: the agent is stopped, its changes captured, and the run ends
 * cancelled with stop reason "handoff" in the same fenced transaction that
 * queues the follow-up. Nothing new starts here while draining.
 */
const app = createApp();
const T = 30_000;
let token = '';
let userId = '';
let repositoryId = '';
let sandbox = '';
let counter = 0;
const graceDefault = config.runHandoffGraceMs;

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  const reg = await request(app)
    .post('/auth/register')
    .send({ email: 'handoff@example.com', username: 'handoffuser', password: 'a-strong-password' });
  token = reg.body.token;
  userId = reg.body.user.id;
  sandbox = makeSandbox('run-handoff');
  const repo = await initFixtureRepo(path.join(sandbox, 'repo'), { 'README.md': '# handoff\n' });
  const created = await request(app).post('/api/repositories').set(auth()).send({ rootPath: repo });
  repositoryId = created.body.repository.id;
});

// Each test starts with nothing running or queued: follow-ups a test leaves
// behind would otherwise start under the next test's agent.
afterEach(async () => {
  runLeases.drain();
  await handOffActiveRuns();
  runLeases.undrainForTests();
  await drainRunsForTests();
  await db.update(runs).set({ status: 'cancelled', finishedAt: new Date() }).where(eq(runs.status, 'queued'));
  setTaskHostFactoryForTests(null);
  config.runHandoffGraceMs = graceDefault;
});

afterAll(async () => {
  await runLeases.stop();
  removeSandbox(sandbox);
});

const auth = () => ({ Authorization: `Bearer ${token}` });

async function newWork(options: { repository?: boolean } = {}) {
  counter += 1;
  const agent = await request(app).post('/api/agents').set(auth()).send({ name: `Worker ${counter}`, runtime: 'claude-code' });
  const task = await request(app)
    .post('/api/tasks')
    .set(auth())
    .send({ title: `Task ${counter}`, ...(options.repository ? { repositoryId } : {}) });
  return { agentId: agent.body.agent.id as string, taskId: task.body.task.id as string };
}

async function runRow(id: string): Promise<Run> {
  const [row] = await db.select().from(runs).where(eq(runs.id, id));
  return row!;
}

async function childrenOf(id: string): Promise<Run[]> {
  return db.select().from(runs).where(eq(runs.parentRunId, id));
}

/** Resolves once `predicate` holds, polling every 20 ms. */
async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** An agent that works until it is cancelled; `onStart` runs first, inside the turn. */
function untilCancelled(started: string[], onStart?: (workspace: string) => void): ScriptedAgent {
  return async (turn) => {
    onStart?.(turn.workspace);
    started.push(turn.prompt);
    await new Promise<void>((resolve) => turn.signal.addEventListener('abort', () => resolve(), { once: true }));
    throw new RunnerError('cancelled by the client', 'aborted');
  };
}

describe('graceful handoff', () => {
  it('stops the agent, captures its changes, and queues the run that continues it', { timeout: T }, async () => {
    const started: string[] = [];
    setTaskHostFactoryForTests(
      scriptedHost(
        untilCancelled(started, (workspace) => fs.writeFileSync(path.join(workspace, 'half.txt'), 'half done\n')),
        'fresh'
      )
    );
    const { agentId, taskId } = await newWork({ repository: true });
    const { run } = await requestWake(userId, { agentId, taskId, trigger: 'manual', reason: 'Build the thing.' });
    await until(() => started.length === 1);

    runLeases.drain();
    await handOffActiveRuns();

    const ended = await runRow(run.id);
    expect(ended).toMatchObject({
      status: 'cancelled',
      stopReason: HANDOFF_STOP_REASON,
      error: 'Handed off: its backend shut down',
      leaseExpiresAt: null,
    });
    expect(ended.sessionRef).toMatch(/^runtime-/);
    const [snapshot] = await db.select().from(changeSnapshots).where(eq(changeSnapshots.runId, run.id));
    expect(snapshot).toMatchObject({ kind: 'run', changedFiles: 1 });

    const followUps = await childrenOf(run.id);
    expect(followUps).toHaveLength(1);
    expect(followUps[0]).toMatchObject({ status: 'queued', attempt: run.attempt, trigger: 'manual', agentId, taskId });
    expect(followUps[0]!.reason).toMatch(/^Your previous turn on this task was stopped because the platform restarted/);
    expect(followUps[0]!.reason).toMatch(/Build the thing\.$/);

    const notes = await db.select().from(turns).where(and(eq(turns.taskId, taskId), eq(turns.runId, run.id)));
    expect(notes.map((t) => t.content)).toContain(
      `Run by Worker ${counter} was handed off because its backend shut down; it continues in a new run.`
    );
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent!.status).toBe('idle');
  });

  it('starts nothing while draining; the follow-up restores the session once an instance admits it', { timeout: T }, async () => {
    const prompts: { prompt: string; resume: string | null }[] = [];
    let cancelFirst = true;
    setTaskHostFactoryForTests(
      scriptedHost(async (turn) => {
        prompts.push({ prompt: turn.prompt, resume: turn.resumeSessionId });
        if (cancelFirst) {
          cancelFirst = false;
          await new Promise<void>((resolve) => turn.signal.addEventListener('abort', () => resolve(), { once: true }));
          throw new RunnerError('cancelled by the client', 'aborted');
        }
        return { text: 'Finished after the restart.' };
      }, 'restorable')
    );
    const { agentId, taskId } = await newWork();
    const { run } = await requestWake(userId, { agentId, taskId, trigger: 'manual' });
    await until(() => prompts.length === 1);

    runLeases.drain();
    await handOffActiveRuns();
    const [followUp] = await childrenOf(run.id);

    // A new wake for another agent queues but does not start here.
    const other = await newWork();
    const queued = await requestWake(userId, { agentId: other.agentId, taskId: other.taskId, trigger: 'manual' });
    expect(queued.admitted).toBe('queued');
    expect((await reconcileOnce(runLeases)).promoted).toEqual([]);

    // The restarted instance picks both up.
    runLeases.undrainForTests();
    const promoted = (await reconcileOnce(runLeases)).promoted;
    expect(promoted).toEqual(expect.arrayContaining([followUp!.id, queued.run.id]));
    await drainRunsForTests();

    const continued = await runRow(followUp!.id);
    expect(continued.status).toBe('succeeded');
    const resumed = prompts.find((p) => p.resume !== null)!;
    expect(resumed.resume).toBe((await runRow(run.id)).sessionRef);
    expect(resumed.prompt).not.toContain(CONTEXT_LOST_NOTE);
    const events = await db.select().from(runEvents).where(eq(runEvents.runId, followUp!.id));
    expect(events.map((e) => (e.payload as { message?: string }).message)).toContain(
      'Restored the earlier conversation (resume)'
    );
  });

  it('kills an agent that ignores the cancel once the grace runs out, and still hands off', { timeout: T }, async () => {
    config.runHandoffGraceMs = 300;
    const killed: number[] = [];
    let opened = 0;
    setTaskHostFactoryForTests(() => stubbornHost(() => opened++, () => killed.push(Date.now())));
    const { agentId, taskId } = await newWork();
    const { run } = await requestWake(userId, { agentId, taskId, trigger: 'manual' });
    await until(() => opened === 1);

    const t0 = Date.now();
    runLeases.drain();
    await handOffActiveRuns();
    // Killed by the grace timer; the turn's own cleanup closes the session again.
    expect(killed.length).toBeGreaterThanOrEqual(1);
    expect(killed[0]! - t0).toBeGreaterThanOrEqual(250);
    expect(await runRow(run.id)).toMatchObject({ status: 'cancelled', stopReason: HANDOFF_STOP_REASON });
    expect(await childrenOf(run.id)).toHaveLength(1);
  });

  it('settles a turn that finishes before the handoff stops it, with no follow-up', { timeout: T }, async () => {
    let release: () => void = () => {};
    let opened = 0;
    setTaskHostFactoryForTests(() => ({
      transport: 'acp',
      openSession: async () => {
        opened += 1;
        // Ignores the cancel but finishes on its own well within the grace.
        return stubSession(() => new Promise((resolve) => (release = () => resolve(done('All done.')))));
      },
    }));
    const { agentId, taskId } = await newWork();
    const { run } = await requestWake(userId, { agentId, taskId, trigger: 'manual' });
    await until(() => opened === 1);

    runLeases.drain();
    const handing = handOffActiveRuns();
    setTimeout(() => release(), 50);
    await handing;
    expect(await runRow(run.id)).toMatchObject({ status: 'succeeded', stopReason: 'end_turn' });
    expect(await childrenOf(run.id)).toHaveLength(0);
  });

  it('abandons a startup in progress and hands the run off', { timeout: T }, async () => {
    let starting = 0;
    setTaskHostFactoryForTests(() => ({
      transport: 'acp',
      openSession: (input: OpenSessionInput) => {
        starting += 1;
        return new Promise<AgentSession>((_, reject) => {
          input.signal?.addEventListener('abort', () => reject(new HostStartupError('cancelled', 'Agent startup was abandoned')), {
            once: true,
          });
        });
      },
    }));
    const { agentId, taskId } = await newWork();
    const { run } = await requestWake(userId, { agentId, taskId, trigger: 'manual' });
    await until(() => starting === 1);

    runLeases.drain();
    await handOffActiveRuns();
    expect(await runRow(run.id)).toMatchObject({ status: 'cancelled', stopReason: HANDOFF_STOP_REASON });
    expect(await childrenOf(run.id)).toHaveLength(1);
  });

  it('writes nothing for a run another instance took over meanwhile', { timeout: T }, async () => {
    const started: string[] = [];
    setTaskHostFactoryForTests(scriptedHost(untilCancelled(started)));
    const { agentId, taskId } = await newWork();
    const { run } = await requestWake(userId, { agentId, taskId, trigger: 'manual' });
    await until(() => started.length === 1);
    // What a takeover leaves behind, before this instance's renewal notices it.
    await db
      .update(runs)
      .set({ ownerInstance: 'other-instance', ownerEpoch: run.ownerEpoch + 1 })
      .where(eq(runs.id, run.id));

    runLeases.drain();
    await handOffActiveRuns();
    expect(await runRow(run.id)).toMatchObject({ status: 'running', ownerInstance: 'other-instance' });
    expect(await childrenOf(run.id)).toHaveLength(0);
    await db.update(runs).set({ status: 'failed', leaseExpiresAt: null, finishedAt: new Date() }).where(eq(runs.id, run.id));
  });

  it('hands on, before its agent starts, a run admitted after the drain began', { timeout: T }, async () => {
    let turns = 0;
    setTaskHostFactoryForTests(scriptedHost(async () => ({ text: `turn ${(turns += 1)}` })));
    const { agentId, taskId } = await newWork();
    // Inside the admitting transaction, after the claim: the drain lands between admit's check and its return.
    const disarm = armCrashPointForTests('admission.after_claim', () => runLeases.drain());
    try {
      const { run, admitted } = await requestWake(userId, { agentId, taskId, trigger: 'manual' });
      expect(admitted).toBe('started');
      await drainRunsForTests();
      expect(await runRow(run.id)).toMatchObject({ status: 'cancelled', stopReason: HANDOFF_STOP_REASON });
      expect(await childrenOf(run.id)).toHaveLength(1);
      expect(turns).toBe(0);
    } finally {
      disarm();
    }
  });

  it('waits for an admission still in flight when the handoff begins', { timeout: T }, async () => {
    const started: string[] = [];
    setTaskHostFactoryForTests(scriptedHost(untilCancelled(started)));
    const { agentId, taskId } = await newWork();
    let handing: Promise<void> | undefined;
    const disarm = armCrashPointForTests('admission.after_claim', () => {
      runLeases.drain();
      handing = handOffActiveRuns();
    });
    try {
      const waking = requestWake(userId, { agentId, taskId, trigger: 'manual' });
      await until(() => handing !== undefined);
      await handing;
      const { run } = await waking;
      expect(await runRow(run.id)).toMatchObject({ status: 'cancelled', stopReason: HANDOFF_STOP_REASON });
    } finally {
      disarm();
    }
  });

  it('notes the restart once, however many times a run is handed off', { timeout: T }, async () => {
    const started: string[] = [];
    setTaskHostFactoryForTests(scriptedHost(untilCancelled(started)));
    const { agentId, taskId } = await newWork();
    const { run } = await requestWake(userId, { agentId, taskId, trigger: 'manual', reason: 'Original ask.' });
    await until(() => started.length === 1);
    runLeases.drain();
    await handOffActiveRuns();
    const [first] = await childrenOf(run.id);

    runLeases.undrainForTests();
    expect((await reconcileOnce(runLeases)).promoted).toContain(first!.id);
    await until(() => started.length === 2);
    runLeases.drain();
    await handOffActiveRuns();
    const [second] = await childrenOf(first!.id);
    expect(second!.reason.match(/platform restarted/g)).toHaveLength(1);
    expect(second!.reason).toMatch(/Original ask\.$/);
  });
});

function done(text: string): TurnOutcome {
  return { stopReason: 'end_turn', text, error: null, usage: { inputTokens: null, outputTokens: null, costUsd: null } };
}

/** A session whose turn is `turn()`; cancel is ignored, close is recorded by `onClose`. */
function stubSession(turn: () => Promise<TurnOutcome>, onClose: () => void = () => {}): AgentSession {
  return {
    sessionId: 'stub',
    runtimeSessionId: null,
    resumed: false,
    prompt: (_input: TurnInput) => turn(),
    cancel: async () => {},
    close: async () => onClose(),
  } as unknown as AgentSession;
}

/** A host whose agent ignores cancellation and only stops when its session is closed. */
function stubbornHost(onOpen: () => void, onKill: () => void): AgentHost {
  return {
    transport: 'acp',
    openSession: async () => {
      onOpen();
      let stop: (outcome: TurnOutcome) => void = () => {};
      const pending = new Promise<TurnOutcome>((resolve) => (stop = resolve));
      return stubSession(
        () => pending,
        () => {
          onKill();
          stop({ stopReason: 'error', text: '', error: 'killed', usage: { inputTokens: null, outputTokens: null, costUsd: null } });
        }
      );
    },
  };
}
