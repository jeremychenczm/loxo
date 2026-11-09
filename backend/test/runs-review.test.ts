import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import { issueReviews } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { setIssueTurnExecutorForTests } from '../src/modules/runs/issue-run';
import { issueRunToken } from '../src/modules/runs/run-token';
import { drainRunsForTests, requestWake } from '../src/modules/runs/wake';
import type { TurnRequest, TurnResult } from '../src/modules/runner/runner';

const app = createApp();
let token = '';
let userId = '';
let workerId = '';
let inspectorId = '';

const REVIEWER_MARK = 'acting as the REVIEWER';

type Executor = (req: TurnRequest) => Promise<TurnResult>;
const quick: Executor = async () => ({ text: 'stub output', durationMs: 5 });
let executorImpl: Executor = quick;
let lastPrompt = '';
let lastPermission: TurnRequest['permission'];
const pendingReleases: Array<() => void> = [];

/** Parks the first REVIEW run (identified by its prompt) until release. */
function gateReviewRun() {
  let entered!: () => void;
  const invoked = new Promise<void>((resolve) => (entered = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let first = true;
  executorImpl = async (req) => {
    if (first && req.prompt.includes(REVIEWER_MARK)) {
      first = false;
      entered();
      await gate;
    }
    return quick(req);
  };
  pendingReleases.push(release);
  return { invoked, release };
}

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  setIssueTurnExecutorForTests((req) => {
    lastPrompt = req.prompt;
    lastPermission = req.permission;
    return executorImpl(req);
  });

  const reg = await request(app).post('/auth/register').send({
    email: 'revrun@example.com',
    username: 'revrunuser',
    password: 'a-strong-password',
  });
  token = reg.body.token;
  userId = reg.body.user.id;

  for (const name of ['Worker', 'Inspector']) {
    const agent = await request(app)
      .post('/api/agents')
      .set({ Authorization: `Bearer ${token}` })
      .send({ name, runtime: 'claude-code' });
    if (name === 'Worker') workerId = agent.body.agent.id;
    else inspectorId = agent.body.agent.id;
  }
});

afterAll(() => {
  setIssueTurnExecutorForTests(null);
});

afterEach(async () => {
  for (const release of pendingReleases) release();
  pendingReleases.length = 0;
  await drainRunsForTests();
  executorImpl = quick;
});

const auth = () => ({ Authorization: `Bearer ${token}` });

async function createIssue(title: string) {
  const res = await request(app).post('/api/issues').set(auth()).send({ title });
  return res.body.issue as { id: string; issueNumber: number };
}

async function moveTo(issueId: string, status: string) {
  const res = await request(app).post(`/api/issues/${issueId}/move`).set(auth()).send({ status });
  expect(res.status).toBe(200);
}

async function setPrincipals(issueId: string, assignee?: string, reviewer?: string) {
  const res = await request(app)
    .patch(`/api/issues/${issueId}`)
    .set(auth())
    .send({
      ...(assignee ? { assignee: { agentId: assignee } } : {}),
      ...(reviewer ? { reviewer: { agentId: reviewer } } : {}),
    });
  expect(res.status).toBe(200);
}

async function runsFor(issueId: string) {
  const res = await request(app).get(`/api/runs?issueId=${issueId}`).set(auth());
  return res.body.runs as Array<{ id: string; status: string; trigger: string; agentId: string }>;
}

let callId = 0;
function mcpCall(runToken: string, method: string, params?: Record<string, unknown>) {
  callId += 1;
  return request(app)
    .post('/mcp')
    .set({
      Authorization: `Bearer ${runToken}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    })
    .send({ jsonrpc: '2.0', id: callId, method, ...(params ? { params } : {}) });
}

async function seedRejections(issueId: string, count: number) {
  for (let i = 0; i < count; i += 1) {
    await db.insert(issueReviews).values({
      userId,
      issueId,
      reviewerType: 'agent',
      reviewerAgentId: inspectorId,
      decision: 'changes_requested',
      body: `seeded rejection ${i + 1}`,
    });
  }
}

describe('reviewer routing', () => {
  it('wakes the reviewer with a review-flavored run when the issue enters review', async () => {
    const issue = await createIssue('Review wake');
    await setPrincipals(issue.id, undefined, inspectorId);
    await moveTo(issue.id, 'todo');
    await moveTo(issue.id, 'in_progress');
    await moveTo(issue.id, 'in_review');
    await drainRunsForTests();

    const runs = await runsFor(issue.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.trigger).toBe('review');
    expect(runs[0]!.agentId).toBe(inspectorId);
    expect(runs[0]!.status).toBe('succeeded');
    expect(lastPrompt).toContain(REVIEWER_MARK);
    expect(lastPrompt).toContain('do NOT modify any files');
    // Review turns are forced below the agent's own permission ceiling.
    expect(lastPermission).toBe('read_only');
  });

  it('skips the reviewer wake when reviewer and assignee are the same agent', async () => {
    const issue = await createIssue('Self review');
    await setPrincipals(issue.id, workerId, workerId);
    await moveTo(issue.id, 'todo');
    await drainRunsForTests();
    await moveTo(issue.id, 'in_progress');
    await moveTo(issue.id, 'in_review');
    await drainRunsForTests();

    const runs = await runsFor(issue.id);
    expect(runs.filter((r) => r.trigger === 'review')).toHaveLength(0);
  });

  it('serves the reviewer toolset and records approval without closing', async () => {
    const gated = gateReviewRun();
    const issue = await createIssue('Approve recommendation');
    await setPrincipals(issue.id, undefined, inspectorId);
    await moveTo(issue.id, 'todo');
    await moveTo(issue.id, 'in_progress');
    await moveTo(issue.id, 'in_review');
    await gated.invoked;

    const reviewRun = (await runsFor(issue.id)).find((r) => r.trigger === 'review')!;
    const runToken = issueRunToken(reviewRun.id);

    const list = await mcpCall(runToken, 'tools/list');
    const names = list.body.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(['comment_on_issue', 'get_issue', 'submit_review']);

    const res = await mcpCall(runToken, 'tools/call', {
      name: 'submit_review',
      arguments: { decision: 'approved', feedback: 'Verified the output; recommend closing.' },
    });
    const outcome = JSON.parse(res.body.result.content[0].text);
    expect(outcome.halted).toBe(false);
    expect(outcome.status).toBe('in_review');

    const detail = await request(app).get(`/api/issues/${issue.id}`).set(auth());
    expect(detail.body.issue.status).toBe('in_review');

    const reviews = await request(app).get(`/api/issues/${issue.id}/reviews`).set(auth());
    expect(reviews.body.reviews).toHaveLength(1);
    expect(reviews.body.reviews[0].decision).toBe('approved');
    expect(reviews.body.reviews[0].reviewerType).toBe('agent');

    gated.release();
  });

  it('agent rejection reopens work and re-wakes the assignee', async () => {
    const gated = gateReviewRun();
    const issue = await createIssue('Reject and rework');
    await setPrincipals(issue.id, workerId, inspectorId);
    await moveTo(issue.id, 'todo');
    await moveTo(issue.id, 'in_progress');
    await moveTo(issue.id, 'in_review');
    await gated.invoked;

    const reviewRun = (await runsFor(issue.id)).find((r) => r.trigger === 'review')!;
    const res = await mcpCall(issueRunToken(reviewRun.id), 'tools/call', {
      name: 'submit_review',
      arguments: { decision: 'changes_requested', feedback: 'Tests are missing for the edge case.' },
    });
    expect(JSON.parse(res.body.result.content[0].text).halted).toBe(false);

    gated.release();
    await drainRunsForTests();

    const detail = await request(app).get(`/api/issues/${issue.id}`).set(auth());
    expect(detail.body.issue.status).toBe('in_progress');

    const comments = await request(app).get(`/api/issues/${issue.id}/comments`).set(auth());
    const bodies = comments.body.comments.map((c: { body: string }) => c.body);
    expect(bodies).toContain('[CHANGES REQUESTED] Tests are missing for the edge case.');

    const workerRuns = (await runsFor(issue.id)).filter((r) => r.agentId === workerId);
    expect(workerRuns.length).toBeGreaterThanOrEqual(2); // initial + rework
  });

  it('stops waking the reviewer once the automated-cycle fuse blows', async () => {
    const issue = await createIssue('Fuse blown');
    await setPrincipals(issue.id, undefined, inspectorId);
    await seedRejections(issue.id, 3);
    await moveTo(issue.id, 'todo');
    await moveTo(issue.id, 'in_progress');
    await moveTo(issue.id, 'in_review');
    await drainRunsForTests();

    expect((await runsFor(issue.id)).filter((r) => r.trigger === 'review')).toHaveLength(0);
  });

  it('halts a beyond-cap rejection instead of reopening work', async () => {
    const gated = gateReviewRun();
    const issue = await createIssue('Halted verdict');
    await setPrincipals(issue.id, undefined, inspectorId);
    await seedRejections(issue.id, 3);
    await moveTo(issue.id, 'todo');
    await moveTo(issue.id, 'in_progress');
    await moveTo(issue.id, 'in_review');
    // The hook refuses to wake; wake the reviewer explicitly to exercise the
    // tool-level guard.
    await requestWake(userId, {
      agentId: inspectorId,
      issueId: issue.id,
      trigger: 'review',
      reason: 'manual reviewer wake',
    });
    await gated.invoked;

    const reviewRun = (await runsFor(issue.id)).find((r) => r.trigger === 'review')!;
    const res = await mcpCall(issueRunToken(reviewRun.id), 'tools/call', {
      name: 'submit_review',
      arguments: { decision: 'changes_requested', feedback: 'Still wrong.' },
    });
    const outcome = JSON.parse(res.body.result.content[0].text);
    expect(outcome.halted).toBe(true);
    expect(outcome.status).toBe('in_review');

    const detail = await request(app).get(`/api/issues/${issue.id}`).set(auth());
    expect(detail.body.issue.status).toBe('in_review');

    const comments = await request(app).get(`/api/issues/${issue.id}/comments`).set(auth());
    const bodies = comments.body.comments.map((c: { body: string }) => c.body);
    expect(bodies.some((b: string) => b.startsWith('[REVIEW HALTED]'))).toBe(true);

    gated.release();
  });
});
