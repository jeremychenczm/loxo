import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { db, pool } from '../src/db/client';
import { runs } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { redactText, redactValue } from '../src/modules/runs/redact';
import { RunEventRecorder } from '../src/modules/runs/run-events.service';
import { finishRun } from '../src/modules/runs/runs.service';
import { attachWsGateway, type WsGateway } from '../src/ws/gateway';

const app = createApp();
let server: Server;
let gateway: WsGateway;
let port = 0;
let token = '';
let otherToken = '';
let userId = '';
let agentId = '';
let taskId = '';

const auth = (t = token) => ({ Authorization: `Bearer ${t}` });

async function newRun(): Promise<{ id: string; userId: string; taskId: string | null }> {
  const [run] = await db
    .insert(runs)
    .values({ userId, agentId, agentName: 'Streamer', taskId, trigger: 'manual', status: 'running' })
    .returning();
  return { id: run!.id, userId, taskId };
}

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  const reg = await request(app)
    .post('/auth/register')
    .send({ email: 'events@example.com', username: 'eventsuser', password: 'a-strong-password' });
  token = reg.body.token;
  userId = reg.body.user.id;
  const other = await request(app)
    .post('/auth/register')
    .send({ email: 'events-other@example.com', username: 'eventsother', password: 'a-strong-password' });
  otherToken = other.body.token;
  const agent = await request(app).post('/api/agents').set(auth()).send({ name: 'Streamer', runtime: 'api' });
  agentId = agent.body.agent.id;
  const task = await request(app).post('/api/tasks').set(auth()).send({ title: 'Live task' });
  taskId = task.body.task.id;

  server = createServer(app);
  gateway = attachWsGateway(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await gateway.shutdown();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('redaction', () => {
  it('scrubs common credential shapes', () => {
    const text = [
      'key sk-ant-api03-abcdefghijklmnopqrstuvwx',
      'gh ghp_abcdefghijklmnopqrstuvwxyz0123',
      'Authorization: Bearer abc.def.ghijklmnop',
      'password=hunter2hunter2',
      'aws AKIAABCDEFGHIJKLMNOP',
    ].join('\n');
    const clean = redactText(text);
    expect(clean).not.toMatch(/sk-ant-api03|ghp_abcd|abc\.def|hunter2|AKIAABCD/);
    expect(clean).toContain('Authorization: Bearer [redacted]');
    expect(clean).toContain('password=[redacted]');
  });

  it('redacts keyed fields and bounds nested values', () => {
    const value = redactValue(
      { input: { command: 'ls', apiKey: 'plain-secret-value' }, items: Array.from({ length: 5 }, (_, i) => i), long: 'x'.repeat(30) },
      { maxStringChars: 10, maxArrayItems: 3, maxDepth: 4 }
    ) as Record<string, unknown>;
    expect(value).toEqual({
      input: { command: 'ls', apiKey: '[redacted]' },
      items: [0, 1, 2, '[2 more items]'],
      long: 'xxxxxxxxxx… [20 more chars]',
    });
  });
});

describe('run event recorder', () => {
  it('coalesces text bursts and keeps seq gapless in commit order', async () => {
    const run = await newRun();
    const recorder = new RunEventRecorder(run, { flushMs: 10_000 });
    recorder.record({ kind: 'thought_delta', text: 'plan ' });
    recorder.record({ kind: 'thought_delta', text: 'it' });
    recorder.record({ kind: 'message_delta', text: 'Hel' });
    recorder.record({ kind: 'message_delta', text: 'lo' });
    recorder.record({ kind: 'tool_call', toolCallId: 't', title: 'ls', toolKind: 'execute', status: 'in_progress', paths: [] });
    recorder.record({ kind: 'message_delta', text: 'done' });
    await recorder.flush();

    const res = await request(app).get(`/api/runs/${run.id}/events`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.events.map((e: { seq: number; kind: string; payload: unknown }) => [e.seq, e.kind, e.payload])).toEqual([
      [1, 'message_delta', { stream: 'thought', text: 'plan it' }],
      [2, 'message_delta', { stream: 'message', text: 'Hello' }],
      [3, 'tool_call', { toolCallId: 't', title: 'ls', toolKind: 'execute', status: 'in_progress', paths: [] }],
      [4, 'message_delta', { stream: 'message', text: 'done' }],
    ]);

    const after = await request(app).get(`/api/runs/${run.id}/events?after=2`).set(auth());
    expect(after.body.events.map((e: { seq: number }) => e.seq)).toEqual([3, 4]);
  });

  it('flushes long bursts early and redacts what it stores', async () => {
    const run = await newRun();
    const recorder = new RunEventRecorder(run, { flushChars: 10, flushMs: 10_000 });
    recorder.record({ kind: 'message_delta', text: 'export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstu' });
    recorder.record({ kind: 'error', message: 'token: ghp_abcdefghijklmnopqrstuvwxyz0123 rejected' });
    await recorder.flush();
    const res = await request(app).get(`/api/runs/${run.id}/events`).set(auth());
    const stored = JSON.stringify(res.body.events);
    expect(stored).not.toMatch(/sk-proj-abcdef|ghp_abcdef/);
    expect(res.body.events).toHaveLength(2);
  });

  it('stops recording at the event cap with one notice', async () => {
    const run = await newRun();
    const recorder = new RunEventRecorder(run, { maxEvents: 3 });
    for (let i = 0; i < 6; i += 1) {
      recorder.record({ kind: 'tool_update', toolCallId: `t${i}`, status: 'completed', output: null });
    }
    await recorder.flush();
    const res = await request(app).get(`/api/runs/${run.id}/events`).set(auth());
    expect(res.body.events.map((e: { kind: string }) => e.kind)).toEqual(['tool_update', 'tool_update', 'status']);
    expect(res.body.events[2].payload.message).toMatch(/Event limit of 3 reached/);
  });

  it('hides another user’s run history', async () => {
    const run = await newRun();
    const res = await request(app).get(`/api/runs/${run.id}/events`).set(auth(otherToken));
    expect(res.status).toBe(404);
  });

  it('records transport, stop reason, and usage when a run finishes', async () => {
    const run = await newRun();
    const finished = await finishRun(run.id, {
      status: 'succeeded',
      transport: 'acp',
      stopReason: 'end_turn',
      tokensIn: 1200,
      tokensOut: 300,
      costUsd: 0.042,
    });
    expect(finished).toMatchObject({ transport: 'acp', stopReason: 'end_turn', tokensIn: 1200, tokensOut: 300, costUsd: 0.042 });
  });
});

describe('live task stream', () => {
  function connect(t: string): Promise<{ ws: WebSocket; frames: Array<{ type: string; payload: Record<string, unknown> }> }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${t}`);
      const frames: Array<{ type: string; payload: Record<string, unknown> }> = [];
      ws.on('message', (raw) => frames.push(JSON.parse(raw.toString())));
      ws.once('open', () => resolve({ ws, frames }));
      ws.once('error', reject);
    });
  }

  async function until(check: () => boolean): Promise<void> {
    for (let i = 0; i < 100 && !check(); i += 1) await new Promise((r) => setTimeout(r, 30));
  }

  it('pushes committed events to subscribers of the task only', async () => {
    const mine = await connect(token);
    const theirs = await connect(otherToken);
    mine.ws.send(JSON.stringify({ type: 'task.subscribe', payload: { taskId } }));
    theirs.ws.send(JSON.stringify({ type: 'task.subscribe', payload: { taskId } }));
    await until(() => mine.frames.some((f) => f.type === 'task.subscribed') && theirs.frames.length > 0);
    expect(theirs.frames[0]).toMatchObject({ type: 'task.error', payload: { code: 'not_found' } });

    const run = await newRun();
    const recorder = new RunEventRecorder(run);
    recorder.record({ kind: 'status', message: 'session opened' });
    recorder.record({ kind: 'tool_call', toolCallId: 'a', title: 'Read', toolKind: 'read', status: 'pending', paths: [] });
    await recorder.flush();
    await until(() => mine.frames.filter((f) => f.type === 'task.run_event').length === 2);

    const events = mine.frames.filter((f) => f.type === 'task.run_event');
    expect(events.map((f) => [f.payload.seq, f.payload.kind, f.payload.runId])).toEqual([
      [1, 'status', run.id],
      [2, 'tool_call', run.id],
    ]);
    expect(events[0]!.payload).not.toHaveProperty('userId');
    expect(theirs.frames.some((f) => f.type === 'task.run_event')).toBe(false);

    mine.ws.send(JSON.stringify({ type: 'task.unsubscribe', payload: { taskId } }));
    await new Promise((r) => setTimeout(r, 100));
    const quiet = new RunEventRecorder(await newRun());
    quiet.record({ kind: 'status', message: 'after unsubscribe' });
    await quiet.flush();
    await new Promise((r) => setTimeout(r, 150));
    expect(mine.frames.filter((f) => f.type === 'task.run_event')).toHaveLength(2);

    mine.ws.close();
    theirs.ws.close();
  });
});
