import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fakeAgentCommand } from '@swarmdev/fake-agent';
import { asc, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import { controlPlaneRequests, runEvents, runs, tasks, turns } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { setAcpLaunchForTests } from '../src/modules/hosts/runtime-catalog';
import { drainRunsForTests, requestWake } from '../src/modules/runs/wake';

/**
 * The fake agent driving the real control plane over HTTP, the way a CLI
 * agent calls its MCP tools, and witnessing its prompt outside the database.
 */
const app = createApp();
const T = 60_000;
let server: Server;
let token = '';
let userId = '';
let agentId = '';
let witnessDir = '';
const previousMcpUrl = process.env.MCP_PUBLIC_URL;

const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.MCP_PUBLIC_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  witnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loxo-witness-'));

  await pool.query('TRUNCATE TABLE users CASCADE');
  const reg = await request(app)
    .post('/auth/register')
    .send({ email: 'fakecp@example.com', username: 'fakecpuser', password: 'a-strong-password' });
  token = reg.body.token;
  userId = reg.body.user.id;
  const agent = await request(app).post('/api/agents').set(auth()).send({ name: 'Scripted', runtime: 'claude-code' });
  agentId = agent.body.agent.id;
});

afterAll(async () => {
  setAcpLaunchForTests('claude-code', undefined);
  if (previousMcpUrl === undefined) delete process.env.MCP_PUBLIC_URL;
  else process.env.MCP_PUBLIC_URL = previousMcpUrl;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(witnessDir, { recursive: true, force: true });
});

interface WitnessLine {
  run: string | null;
  epoch: number | null;
  via: string | null;
  pid: number;
  t: number;
  mark: 'start' | 'beat' | 'end';
}

function readWitness(): WitnessLine[] {
  return fs
    .readdirSync(witnessDir)
    .flatMap((file) => fs.readFileSync(path.join(witnessDir, file), 'utf8').split('\n').filter(Boolean))
    .map((line) => JSON.parse(line) as WitnessLine);
}

describe('fake agent on the control plane', () => {
  it('commits tool calls through the run token and witnesses the prompt', { timeout: T }, async () => {
    setAcpLaunchForTests(
      'claude-code',
      fakeAgentCommand(
        {
          turns: [
            {
              steps: [
                { mcp: { tool: 'comment_on_task', args: { body: 'Halfway there' } } },
                { sleep: 300 },
                { mcp: { tool: 'submit_result', args: { summary: 'Export added' } } },
                { mcp: { tool: 'no_such_tool' } },
                { say: 'Done.' },
              ],
            },
          ],
        },
        { witnessDir }
      )
    );
    const task = await request(app).post('/api/tasks').set(auth()).send({ title: 'Add export', leadAgentId: agentId });
    const taskId = task.body.task.id as string;
    await db.update(tasks).set({ status: 'in_progress' }).where(eq(tasks.id, taskId));
    await requestWake(userId, { agentId, taskId, trigger: 'manual' });
    await drainRunsForTests();

    const [run] = await db.select().from(runs).where(eq(runs.taskId, taskId));
    expect(run).toMatchObject({ status: 'succeeded' });
    const [taskRow] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(taskRow!.status).toBe('in_review');

    const requests = await db
      .select()
      .from(controlPlaneRequests)
      .where(eq(controlPlaneRequests.runId, run!.id))
      .orderBy(asc(controlPlaneRequests.seq));
    expect(requests.map((r) => [r.tool, r.epoch])).toEqual([
      ['comment_on_task', run!.ownerEpoch],
      ['submit_result', run!.ownerEpoch],
    ]);
    const timeline = await db.select().from(turns).where(eq(turns.runId, run!.id));
    expect(timeline.map((t) => t.content)).toEqual(expect.arrayContaining(['Halfway there', 'Export added']));

    const events = await db.select().from(runEvents).where(eq(runEvents.runId, run!.id)).orderBy(asc(runEvents.seq));
    const updates = events
      .filter((e) => e.kind === 'tool_update')
      .map((e) => (e.payload as { status?: string }).status);
    expect(updates).toEqual(['completed', 'completed', 'failed']);

    const lines = readWitness().filter((line) => line.run === run!.id);
    expect(lines.length).toBeGreaterThanOrEqual(5);
    const via = new URL(process.env.MCP_PUBLIC_URL!).host;
    expect(lines.every((line) => line.epoch === run!.ownerEpoch && line.pid === lines[0]!.pid && line.via === via)).toBe(true);
    expect(lines[0]!.mark).toBe('start');
    expect(lines.at(-1)!.mark).toBe('end');
    expect(lines.filter((line) => line.mark === 'beat').length).toBeGreaterThanOrEqual(3);
    const times = lines.map((line) => line.t);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});
