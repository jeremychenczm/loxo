import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { db, pool } from '../src/db/client';
import { runEvents, runs, type Run } from '../src/db/schema';
import { Api, sleep, startInstance, writeAgentScript, type Instance } from '../scripts/chaos/infra';

/**
 * A real backend process asked to stop the way a deploy asks (SIGTERM on
 * POSIX, the IPC message on Windows) hands its run off and exits on its own;
 * the next instance continues the run in the agent's restored session.
 */
const T = 120_000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graceful-shutdown-'));
const instances: Instance[] = [];

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
});

afterAll(async () => {
  for (const instance of instances) instance.kill();
  await Promise.all(instances.map((instance) => instance.exit));
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function launch(label: string): Promise<Instance> {
  const instance = await startInstance({
    label,
    databaseUrl: config.databaseUrl,
    storageRoot: path.join(dir, 'storage'),
    agentCommand: path.join(dir, 'agent.mjs'),
    logDir: dir,
    crashLog: path.join(dir, 'crashes.jsonl'),
  });
  instances.push(instance);
  return instance;
}

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await sleep(100);
  }
}

describe('graceful shutdown of a real backend', () => {
  it('hands its run off, exits by itself, and the next instance continues the session', { timeout: T }, async () => {
    fs.mkdirSync(path.join(dir, 'witness'));
    writeAgentScript(
      path.join(dir, 'agent.mjs'),
      { resumeSession: 'ok', turns: [{ steps: [{ say: 'Working. ' }, { sleep: 5_000 }, { say: 'Done.' }] }] },
      path.join(dir, 'witness'),
      { shim: false }
    );
    const a = await launch('a');
    const api = new Api(a.baseUrl);
    const reg = await api.call<{ token: string }>('POST', '/auth/register', {
      email: `shutdown-${crypto.randomUUID().slice(0, 8)}@example.com`,
      username: `shutdown${crypto.randomUUID().slice(0, 8)}`,
      password: 'a-strong-password',
    });
    api.token = reg.token;
    const { agent } = await api.call<{ agent: { id: string } }>('POST', '/api/agents', { name: 'Worker', runtime: 'claude-code' });
    const { task } = await api.call<{ task: { id: string } }>('POST', '/api/tasks', { title: 'Long job', leadAgentId: agent.id });
    await api.call('POST', `/api/tasks/${task.id}/move`, { status: 'todo' });

    // Mid-turn: the agent's session is open and it is sleeping through its turn.
    const first = await waitFor(async () => {
      const [row] = await db.select().from(runs).where(eq(runs.taskId, task.id));
      return row?.status === 'running' && row.sessionRef ? row : undefined;
    }, 60_000);
    await sleep(1_000);

    const askedAt = Date.now();
    a.shutdown();
    const exit = await a.exit;
    expect(exit.code).toBe(0);
    expect(exit.at - askedAt).toBeLessThan(config.shutdownTimeoutMs);

    const [handedOff] = await db.select().from(runs).where(eq(runs.id, first.id));
    expect(handedOff).toMatchObject({ status: 'cancelled', stopReason: 'handoff' });
    const followUps = await db.select().from(runs).where(eq(runs.parentRunId, first.id));
    expect(followUps).toHaveLength(1);
    expect(followUps[0]!.status).toBe('queued');

    await launch('b');
    const continued = await waitFor<Run>(async () => {
      const [row] = await db.select().from(runs).where(eq(runs.id, followUps[0]!.id));
      return row && ['succeeded', 'failed', 'cancelled'].includes(row.status) ? row : undefined;
    }, 60_000);
    expect(continued.status).toBe('succeeded');
    const events = await db.select().from(runEvents).where(eq(runEvents.runId, continued.id));
    expect(events.map((e) => (e.payload as { message?: string }).message)).toContain(
      'Restored the earlier conversation (resume)'
    );
  });
});
