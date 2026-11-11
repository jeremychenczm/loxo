import fs from 'node:fs';
import path from 'node:path';
import { fakeAgentCommand, type Scenario } from '@swarmdev/fake-agent';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import { runs } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { setAcpLaunchForTests } from '../src/modules/hosts/runtime-catalog';
import { drainRunsForTests, requestWake } from '../src/modules/runs/wake';
import { initFixtureRepo, makeSandbox, removeSandbox } from './fixtures/git-repo';

const app = createApp();
const T = 60_000;
let token = '';
let userId = '';
let agentId = '';
let repositoryId = '';
let sandbox = '';

const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  const reg = await request(app)
    .post('/auth/register')
    .send({ email: 'acpruns@example.com', username: 'acprunsuser', password: 'a-strong-password' });
  token = reg.body.token;
  userId = reg.body.user.id;
  const agent = await request(app).post('/api/agents').set(auth()).send({ name: 'Live Claude', runtime: 'claude-code' });
  agentId = agent.body.agent.id;
  sandbox = makeSandbox('acp-runs');
  const repo = await initFixtureRepo(path.join(sandbox, 'repo'), { 'README.md': '# ledger\n' });
  const created = await request(app).post('/api/repositories').set(auth()).send({ rootPath: repo });
  repositoryId = created.body.repository.id;
});

afterEach(() => setAcpLaunchForTests('claude-code', undefined));

afterAll(() => removeSandbox(sandbox));

async function runScenario(scenario: Scenario, title: string) {
  setAcpLaunchForTests('claude-code', fakeAgentCommand(scenario));
  const task = await request(app)
    .post('/api/tasks')
    .set(auth())
    .send({ title, repositoryId, leadAgentId: agentId });
  await requestWake(userId, { agentId, taskId: task.body.task.id, trigger: 'manual' });
  return task.body.task.id as string;
}

async function answerNextRequest(choice: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const res = await request(app).get('/api/human-requests?status=open').set(auth());
    const open = res.body.requests[0];
    if (open) {
      await request(app).post(`/api/human-requests/${open.id}/answer`).set(auth()).send({ choice });
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('no human request appeared');
}

describe('single-agent runs over ACP', () => {
  it('records a live session end to end', { timeout: T }, async () => {
    const taskId = await runScenario(
      {
        turns: [
          {
            steps: [
              { tool: { id: 'w1', title: 'Write export.ts', kind: 'edit', paths: ['export.ts'] } },
              { writeFile: { path: 'export.ts', content: 'export const csv = true;\n' } },
              { toolDone: { id: 'w1' } },
              {
                permission: {
                  toolCallId: 'p1',
                  title: 'git push origin HEAD',
                  kind: 'execute',
                  onAllow: [{ say: 'Pushed. ' }],
                  onReject: [{ say: 'Kept it local. ' }],
                },
              },
              { say: 'Export added.' },
              { contextUsage: { used: 4000, size: 200_000, costUsd: 0.07 } },
            ],
            usage: { inputTokens: 3000, outputTokens: 400 },
          },
        ],
      },
      'Add CSV export'
    );
    await answerNextRequest('deny');
    await drainRunsForTests();

    const [run] = await db.select().from(runs).where(eq(runs.taskId, taskId));
    expect(run).toMatchObject({
      status: 'succeeded',
      transport: 'acp',
      stopReason: 'end_turn',
      tokensIn: 3000,
      tokensOut: 400,
      output: 'Kept it local. Export added.',
    });
    expect(run!.costUsd).toBeCloseTo(0.07);
    expect(run!.sessionRef).toMatch(/^fake-/);

    const events = await request(app).get(`/api/runs/${run!.id}/events`).set(auth());
    const kinds = events.body.events.map((e: { kind: string }) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['tool_call', 'tool_update', 'permission', 'message_delta', 'usage']));
    const permission = events.body.events.find((e: { kind: string }) => e.kind === 'permission');
    expect(permission.payload.decision).toMatchObject({ outcome: 'deny' });

    const turns = await request(app).get(`/api/tasks/${taskId}/turns`).set(auth());
    const contents = turns.body.turns.map((t: { content: string }) => t.content);
    expect(contents).toContain('Kept it local. Export added.');
    expect(contents.some((c: string) => c.startsWith('Code changes captured: 1 file(s)'))).toBe(true);

    const workspace = await request(app).get(`/api/tasks/${taskId}/workspace`).set(auth());
    expect(fs.readFileSync(path.join(workspace.body.workspace.worktreePath, 'export.ts'), 'utf8')).toContain('csv');
  });

  it('fails the run when the agent crashes, keeping what it said', { timeout: T }, async () => {
    const taskId = await runScenario(
      { turns: [{ steps: [{ say: 'Starting. ' }, { stderr: 'fatal: out of memory' }, { crash: 3 }] }] },
      'Crashing agent'
    );
    await drainRunsForTests();
    const [run] = await db.select().from(runs).where(eq(runs.taskId, taskId));
    expect(run).toMatchObject({ status: 'failed', transport: 'acp', stopReason: 'crashed', output: 'Starting. ' });
    expect(run!.error).toContain('fatal: out of memory');
  });
});
