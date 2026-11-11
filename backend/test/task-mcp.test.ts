import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import { turns, workspaces } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { mintTurnToken } from '../src/modules/control-plane/turn-token';
import { addHumanTurn } from '../src/modules/tasks/turns.service';
import { git, initFixtureRepo, makeSandbox, removeSandbox } from './fixtures/git-repo';

const app = createApp();
let token = '';
let userId = '';
let agentId = '';
let otherAgentId = '';
let taskId = '';
let sandbox = '';
let seq = 100;

const auth = () => ({ Authorization: `Bearer ${token}` });

let callId = 0;
function mcp(turnToken: string, method: string, params?: Record<string, unknown>) {
  callId += 1;
  return request(app)
    .post('/mcp/task')
    .set({
      Authorization: `Bearer ${turnToken}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    })
    .send({ jsonrpc: '2.0', id: callId, method, ...(params ? { params } : {}) });
}

async function call(turnToken: string, name: string, args: Record<string, unknown> = {}) {
  const res = await mcp(turnToken, 'tools/call', { name, arguments: args });
  expect(res.status).toBe(200);
  const result = res.body.result as { content: Array<{ text: string }>; isError?: boolean };
  return { text: result.content[0]!.text, isError: result.isError === true };
}

async function newTurn(extra: Partial<typeof turns.$inferInsert> = {}) {
  seq += 1;
  const [turn] = await db
    .insert(turns)
    .values({ taskId, seq, kind: 'agent', agentId, status: 'running', ...extra })
    .returning();
  return { turn: turn!, token: mintTurnToken({ turnId: turn!.id, taskId, agentId: turn!.agentId! }) };
}

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  const reg = await request(app)
    .post('/auth/register')
    .send({ email: 'taskmcp@example.com', username: 'taskmcpuser', password: 'a-strong-password' });
  token = reg.body.token;
  userId = reg.body.user.id;
  for (const name of ['Ada', 'Grace']) {
    const res = await request(app).post('/api/agents').set(auth()).send({ name, runtime: 'claude-code' });
    if (name === 'Ada') agentId = res.body.agent.id;
    else otherAgentId = res.body.agent.id;
  }
  const task = await request(app)
    .post('/api/tasks')
    .set(auth())
    .send({ title: 'Add CSV export', brief: 'Export ledgers as CSV.', leadAgentId: agentId, memberAgentIds: [otherAgentId] });
  taskId = task.body.task.id;
  await addHumanTurn(userId, taskId, 'Please keep the API stable.');
  sandbox = makeSandbox('task-mcp');
});

afterAll(() => removeSandbox(sandbox));

describe('task control plane authentication', () => {
  it('rejects missing, malformed, forged, and finished-turn tokens', async () => {
    const { turn, token: good } = await newTurn();
    expect((await mcp('', 'tools/list')).status).toBe(401);
    expect((await mcp('stt_nope', 'tools/list')).status).toBe(401);

    const forged = mintTurnToken({ turnId: turn.id, taskId, agentId: otherAgentId });
    expect((await mcp(forged, 'tools/list')).status).toBe(401);

    expect((await mcp(good, 'tools/list')).status).toBe(200);
    await db.update(turns).set({ status: 'completed' }).where(eq(turns.id, turn.id));
    const finished = await mcp(good, 'tools/list');
    expect(finished.status).toBe(401);
    expect(finished.body.error.message).toMatch(/not running/);
  });
});

describe('task control plane tools', () => {
  it('trims the toolset by phase', async () => {
    const general = await newTurn();
    const listed = await mcp(general.token, 'tools/list');
    expect(listed.body.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(
      ['get_checks', 'get_diff', 'get_task', 'list_files', 'read_file', 'report_progress', 'request_human'].sort()
    );
    const brief = await newTurn({ phase: 'brief' });
    const trimmed = await mcp(brief.token, 'tools/list');
    expect(trimmed.body.result.tools.map((t: { name: string }) => t.name)).toEqual(['get_task']);
  });

  it('describes the task, its members, and the timeline', async () => {
    const { token: t } = await newTurn({ phase: 'build' });
    const result = await call(t, 'get_task');
    expect(JSON.parse(result.text)).toMatchObject({
      title: 'Add CSV export',
      brief: 'Export ledgers as CSV.',
      phase: 'build',
      you: 'Ada',
      lead: 'Ada',
      members: ['Ada', 'Grace'],
      hasWorkspace: false,
      timeline: [expect.objectContaining({ kind: 'human', author: 'human', content: 'Please keep the API stable.' })],
    });
  });

  it('appends progress notes to the turn report', async () => {
    const { turn, token: t } = await newTurn({ report: { type: 'work' } });
    await call(t, 'report_progress', { summary: 'Parser done' });
    await call(t, 'report_progress', { summary: 'Writer done' });
    const [row] = await db.select().from(turns).where(eq(turns.id, turn.id));
    expect(row!.report).toMatchObject({
      type: 'work',
      progress: [expect.objectContaining({ summary: 'Parser done' }), expect.objectContaining({ summary: 'Writer done' })],
    });
  });

  it('queues a question for a person without blocking', async () => {
    const { token: t } = await newTurn();
    const result = await call(t, 'request_human', { question: 'Should totals include tax?' });
    expect(result.text).toMatch(/waiting for a person/);
    const open = await request(app).get('/api/human-requests?status=open').set(auth());
    const question = open.body.requests.find((r: { kind: string }) => r.kind === 'input');
    expect(question).toMatchObject({ choices: [], payload: { question: 'Should totals include tax?', agentId } });
    const answer = await request(app)
      .post(`/api/human-requests/${question.id}/answer`)
      .set(auth())
      .send({ choice: 'Yes, show tax as its own column.' });
    expect(answer.status).toBe(200);
  });

  it('reads the turn worktree and refuses when there is none', async () => {
    const none = await newTurn();
    const refused = await call(none.token, 'get_diff');
    expect(refused).toMatchObject({ isError: true });
    expect(refused.text).toMatch(/^no_workspace/);

    const repo = await initFixtureRepo(path.join(sandbox, 'wt'), { 'ledger.ts': 'export const v = 1;\n' });
    const base = await git(repo, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'ledger.ts'), 'export const v = 2;\n');
    const [workspace] = await db
      .insert(workspaces)
      .values({
        userId,
        taskId,
        kind: 'member',
        agentId,
        worktreePath: repo,
        branchName: 'loxo/t1/ada',
        baseRef: 'main',
        baseCommit: base,
        status: 'dirty',
      })
      .returning();
    const withTree = await newTurn({ workspaceId: workspace!.id });
    expect((await call(withTree.token, 'get_diff')).text).toContain('+export const v = 2;');
    expect((await call(withTree.token, 'read_file', { path: 'ledger.ts' })).text).toContain('1| export const v = 2;');
    const escape = await call(withTree.token, 'read_file', { path: '../outside' });
    expect(escape.isError).toBe(true);
  });
});
