import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/client';
import { createApp } from '../src/http/app';
import { setIssueTurnExecutorForTests } from '../src/modules/runs/issue-run';
import { drainRunsForTests } from '../src/modules/runs/wake';

const app = createApp();
let token = '';
let agentId = '';

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  setIssueTurnExecutorForTests(async () => ({ text: 'stub report', durationMs: 5 }));

  const reg = await request(app).post('/auth/register').send({
    email: 'reviews@example.com',
    username: 'reviewsuser',
    password: 'a-strong-password',
  });
  token = reg.body.token;

  const agent = await request(app)
    .post('/api/agents')
    .set({ Authorization: `Bearer ${token}` })
    .send({ name: 'Review worker', runtime: 'claude-code' });
  agentId = agent.body.agent.id;
});

afterAll(() => {
  setIssueTurnExecutorForTests(null);
});

const auth = () => ({ Authorization: `Bearer ${token}` });

async function createIssue(title: string) {
  const res = await request(app).post('/api/issues').set(auth()).send({ title });
  return res.body.issue as { id: string; issueNumber: number; projectId: string };
}

async function moveTo(issueId: string, status: string) {
  const res = await request(app).post(`/api/issues/${issueId}/move`).set(auth()).send({ status });
  expect(res.status).toBe(200);
}

/** backlog -> todo -> in_progress -> in_review, without waking anyone. */
async function walkToReview(issueId: string) {
  await moveTo(issueId, 'todo');
  await moveTo(issueId, 'in_progress');
  await moveTo(issueId, 'in_review');
}

function review(issueId: string, decision: string, body: string) {
  return request(app)
    .post(`/api/issues/${issueId}/reviews`)
    .set(auth())
    .send({ decision, body });
}

describe('issue reviews', () => {
  it('rejects a review unless the issue is in review', async () => {
    const issue = await createIssue('Not ready');
    const res = await review(issue.id, 'approved', 'nice');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('not_in_review');
  });

  it('requires a decision and a non-empty comment', async () => {
    const issue = await createIssue('Strict input');
    await walkToReview(issue.id);
    expect((await review(issue.id, 'approved', '   ')).status).toBe(400);
    expect(
      (
        await request(app)
          .post(`/api/issues/${issue.id}/reviews`)
          .set(auth())
          .send({ decision: 'maybe', body: 'x' })
      ).status
    ).toBe(400);
  });

  it('approve closes the issue and stamps the timeline', async () => {
    const issue = await createIssue('Ship it');
    await walkToReview(issue.id);

    const res = await review(issue.id, 'approved', 'Looks good, verified locally.');
    expect(res.status).toBe(201);
    expect(res.body.review.decision).toBe('approved');
    expect(res.body.review.reviewerType).toBe('human');

    const detail = await request(app).get(`/api/issues/${issue.id}`).set(auth());
    expect(detail.body.issue.status).toBe('done');
    expect(detail.body.issue.closedAt).not.toBeNull();

    const comments = await request(app).get(`/api/issues/${issue.id}/comments`).set(auth());
    const bodies = comments.body.comments.map((c: { body: string }) => c.body);
    expect(bodies).toContain('[APPROVED] Looks good, verified locally.');

    const listed = await request(app).get(`/api/issues/${issue.id}/reviews`).set(auth());
    expect(listed.body.reviews).toHaveLength(1);
  });

  it('request changes reopens work and re-wakes the assignee', async () => {
    const issue = await createIssue('Needs rework');
    await request(app)
      .patch(`/api/issues/${issue.id}`)
      .set(auth())
      .send({ assignee: { agentId } });
    await moveTo(issue.id, 'todo');
    await drainRunsForTests(); // assignment wake settles

    await moveTo(issue.id, 'in_progress');
    await moveTo(issue.id, 'in_review');

    const res = await review(issue.id, 'changes_requested', 'The button is still misaligned on mobile.');
    expect(res.status).toBe(201);
    await drainRunsForTests();

    const detail = await request(app).get(`/api/issues/${issue.id}`).set(auth());
    expect(detail.body.issue.status).toBe('in_progress');

    const comments = await request(app).get(`/api/issues/${issue.id}/comments`).set(auth());
    const bodies = comments.body.comments.map((c: { body: string }) => c.body);
    expect(bodies).toContain('[CHANGES REQUESTED] The button is still misaligned on mobile.');

    // The rework wake produced a second run.
    const runs = await request(app).get(`/api/runs?issueId=${issue.id}`).set(auth());
    expect(runs.body.runs.length).toBe(2);
    expect(runs.body.runs.every((r: { status: string }) => r.status === 'succeeded')).toBe(true);
  });

  it('scopes reviews to the owning user', async () => {
    const other = await request(app).post('/auth/register').send({
      email: 'reviews-other@example.com',
      username: 'reviewsother',
      password: 'a-strong-password',
    });
    const issue = await createIssue('Private');
    await walkToReview(issue.id);
    const res = await request(app)
      .post(`/api/issues/${issue.id}/reviews`)
      .set({ Authorization: `Bearer ${other.body.token}` })
      .send({ decision: 'approved', body: 'sneaky' });
    expect(res.status).toBe(404);
  });
});
