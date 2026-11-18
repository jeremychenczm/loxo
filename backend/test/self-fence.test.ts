import path from 'node:path';
import { fakeAgentCommand, type Scenario } from '@swarmdev/fake-agent';
import { count, eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import { changeSnapshots, runEvents, runs, turns } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { liveAgentProcessesForTests } from '../src/modules/hosts/acp-host';
import { setAcpLaunchForTests } from '../src/modules/hosts/runtime-catalog';
import { mintRunToken } from '../src/modules/control-plane/run-token';
import { resolveRunContext } from '../src/modules/control-plane/tools';
import { armCrashPointForTests } from '../src/modules/ownership/crash-points';
import { instanceId } from '../src/modules/ownership/instance';
import { runLeases } from '../src/modules/ownership/lease';
import { drainRunsForTests, requestWake } from '../src/modules/runs/wake';
import { initFixtureRepo, makeSandbox, removeSandbox } from './fixtures/git-repo';

/**
 * A run that loses its lease stops at once, wherever it is: the agent process
 * dies without a cancel-and-wait, and the instance writes nothing more for the
 * run (no events, capture, report, or settlement). Uses the fake ACP agent, so
 * the processes are real.
 */
const app = createApp();
const T = 60_000;
let token = '';
let userId = '';
let repositoryId = '';
let sandbox = '';
let counter = 0;

const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  const reg = await request(app)
    .post('/auth/register')
    .send({ email: 'fence@example.com', username: 'fenceuser', password: 'a-strong-password' });
  token = reg.body.token;
  userId = reg.body.user.id;
  sandbox = makeSandbox('self-fence');
  const repo = await initFixtureRepo(path.join(sandbox, 'repo'), { 'README.md': '# fence\n' });
  const created = await request(app).post('/api/repositories').set(auth()).send({ rootPath: repo });
  repositoryId = created.body.repository.id;
});

afterEach(() => setAcpLaunchForTests('claude-code', undefined));

afterAll(() => removeSandbox(sandbox));

async function waitFor(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Starts a run of `scenario` on a fresh agent and task; returns the run id. */
async function start(scenario: Scenario, withRepository: boolean): Promise<{ runId: string; taskId: string }> {
  counter += 1;
  setAcpLaunchForTests('claude-code', fakeAgentCommand(scenario));
  const agent = await request(app).post('/api/agents').set(auth()).send({ name: `Fenced ${counter}`, runtime: 'claude-code' });
  const task = await request(app)
    .post('/api/tasks')
    .set(auth())
    .send({ title: `Fenced ${counter}`, ...(withRepository ? { repositoryId } : {}) });
  const decision = await requestWake(userId, { agentId: agent.body.agent.id, taskId: task.body.task.id, trigger: 'manual' });
  expect(decision.admitted).toBe('started');
  return { runId: decision.run.id, taskId: task.body.task.id };
}

/** Another instance takes the run over; this instance learns on its next renewal. */
async function takeOver(runId: string): Promise<void> {
  await db
    .update(runs)
    .set({ ownerInstance: 'other-instance', ownerEpoch: sql`${runs.ownerEpoch} + 1` })
    .where(eq(runs.id, runId));
  await runLeases.renewNow();
}

async function rowCount(table: typeof turns | typeof runEvents | typeof changeSnapshots, column: 'taskId' | 'runId', id: string) {
  const col = column === 'taskId' ? (table as typeof turns).taskId : (table as typeof runEvents).runId;
  const [row] = await db.select({ n: count() }).from(table).where(eq(col, id));
  return row!.n;
}

async function expectUntouchedAfterTakeover(runId: string): Promise<void> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  // Still exactly as the taking-over instance left it: not settled by the old owner.
  expect(run).toMatchObject({ status: 'running', ownerInstance: 'other-instance', finishedAt: null, output: '' });
}

describe('self-fencing on a lost lease', () => {
  it('abandons agent startup and kills the process', { timeout: T }, async () => {
    const { runId, taskId } = await start({ startup: 'hang', turns: [{ steps: [{ say: 'never' }] }] }, false);
    await waitFor(() => liveAgentProcessesForTests() === 1, 'the agent process to start');

    await takeOver(runId);
    await drainRunsForTests();

    expect(liveAgentProcessesForTests()).toBe(0);
    await expectUntouchedAfterTakeover(runId);
    expect(await rowCount(turns, 'taskId', taskId)).toBe(0);
    expect(runLeases.isLost(runId)).toBe(true);
    await expect(resolveRunContext(mintRunToken(runId))).rejects.toMatchObject({ status: 401 });
  });

  it('kills the agent mid-turn without waiting and records nothing more', { timeout: T }, async () => {
    const { runId, taskId } = await start(
      {
        turns: [
          {
            steps: [
              { say: 'Working on it. ' },
              { tool: { id: 't1', title: 'Long build', kind: 'execute' } },
              { hang: { ignoreCancel: true } },
            ],
          },
        ],
      },
      false
    );
    await waitFor(async () => (await rowCount(runEvents, 'runId', runId)) >= 2, 'the turn to stream events');
    const eventsBefore = await rowCount(runEvents, 'runId', runId);

    const fencedAt = performance.now();
    await takeOver(runId);
    await drainRunsForTests();
    // A cancel-and-wait would take the watchdog's 10 s grace; a kill takes well under it.
    expect(performance.now() - fencedAt).toBeLessThan(5_000);

    expect(liveAgentProcessesForTests()).toBe(0);
    await expectUntouchedAfterTakeover(runId);
    expect(await rowCount(runEvents, 'runId', runId)).toBe(eventsBefore);
    // No fallback report: the old owner no longer speaks for the run.
    expect(await rowCount(turns, 'taskId', taskId)).toBe(0);
  });

  it('skips change capture when the lease is lost after the turn', { timeout: T }, async () => {
    let target = '';
    const disarm = armCrashPointForTests('run.before_capture', () => {
      runLeases.get(target)?.lose('lost just before capture (test)');
    });
    try {
      const started = await start(
        { turns: [{ steps: [{ writeFile: { path: 'notes.txt', content: 'unsaved\n' } }, { say: 'Done.' }] }] },
        true
      );
      target = started.runId;
      await drainRunsForTests();

      expect(liveAgentProcessesForTests()).toBe(0);
      expect(await rowCount(changeSnapshots, 'runId', target)).toBe(0);
      expect(await rowCount(turns, 'taskId', started.taskId)).toBe(0);
      const [run] = await db.select().from(runs).where(eq(runs.id, target));
      // Lost locally before anyone took over: the row still names this instance, unsettled.
      expect(run).toMatchObject({ status: 'running', ownerInstance: instanceId, finishedAt: null });
    } finally {
      disarm();
    }
  });
});
