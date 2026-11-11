import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import {
  candidates,
  contextDeliveries,
  findings,
  planReviews,
  plans,
  runEvents,
  runs,
  signoffs,
  taskMembers,
  tasks,
  workPackages,
} from '../src/db/schema';
import { createApp } from '../src/http/app';

const app = createApp();
let token = '';
let userId = '';
let agentId = '';
let otherAgentId = '';

/** pg surfaces SQLSTATE on the error; drizzle may wrap it as the cause. */
async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code;
  }
}

const auth = () => ({ Authorization: `Bearer ${token}` });

async function newTask(title: string): Promise<{ id: string; members: Map<string, string> }> {
  const res = await request(app)
    .post('/api/tasks')
    .set(auth())
    .send({ title, memberAgentIds: [agentId, otherAgentId] });
  const id = res.body.task.id as string;
  const rows = await db.select().from(taskMembers).where(eq(taskMembers.taskId, id));
  return { id, members: new Map(rows.map((r) => [r.agentId, r.id])) };
}

async function newCandidate(taskId: string, version = 1) {
  const [row] = await db
    .insert(candidates)
    .values({ taskId, version, fingerprint: 'fp', checksDigest: 'cd', digest: `d${version}` })
    .returning();
  return row!;
}

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  const reg = await request(app).post('/auth/register').send({
    email: 'constraints@example.com',
    username: 'constraintsuser',
    password: 'a-strong-password',
  });
  token = reg.body.token;
  userId = reg.body.user.id;
  for (const name of ['Signer A', 'Signer B']) {
    const res = await request(app).post('/api/agents').set(auth()).send({ name, runtime: 'api' });
    if (name === 'Signer A') agentId = res.body.agent.id;
    else otherAgentId = res.body.agent.id;
  }
});

describe('terminal statuses', () => {
  it('never lets a finished task change status again', async () => {
    const { id } = await newTask('Finished');
    await db.update(tasks).set({ status: 'done' }).where(eq(tasks.id, id));
    expect(await sqlState(db.update(tasks).set({ status: 'todo' }).where(eq(tasks.id, id)))).toBe(
      '23514'
    );
    expect(
      await sqlState(db.update(tasks).set({ status: 'cancelled' }).where(eq(tasks.id, id)))
    ).toBe('23514');
    // Other columns stay writable, and rewriting the same status is not a transition.
    expect(
      await sqlState(db.update(tasks).set({ title: 'Renamed', status: 'done' }).where(eq(tasks.id, id)))
    ).toBeUndefined();
  });

  it('keeps cancelled tasks cancelled', async () => {
    const { id } = await newTask('Dropped');
    await db.update(tasks).set({ status: 'cancelled' }).where(eq(tasks.id, id));
    expect(
      await sqlState(db.update(tasks).set({ status: 'backlog' }).where(eq(tasks.id, id)))
    ).toBe('23514');
  });

  it('freezes candidates once delivered, rejected, invalidated, or superseded', async () => {
    const { id } = await newTask('Candidate lifecycle');
    const terminal = ['delivered', 'rejected', 'invalidated', 'superseded'] as const;
    for (const [i, status] of terminal.entries()) {
      const candidate = await newCandidate(id, i + 1);
      await db.update(candidates).set({ status: 'signed' }).where(eq(candidates.id, candidate.id));
      await db.update(candidates).set({ status }).where(eq(candidates.id, candidate.id));
      expect(
        await sqlState(
          db.update(candidates).set({ status: 'collecting' }).where(eq(candidates.id, candidate.id))
        )
      ).toBe('23514');
    }
  });

  it('numbers candidate versions uniquely per task', async () => {
    const { id } = await newTask('Versions');
    await newCandidate(id, 1);
    expect(await sqlState(newCandidate(id, 1))).toBe('23505');
  });
});

describe('sign-off', () => {
  it('accepts one sign-off per member per candidate', async () => {
    const { id, members } = await newTask('Sign once');
    const candidate = await newCandidate(id);
    const member = members.get(agentId)!;
    await db.insert(signoffs).values({ candidateId: candidate.id, taskMemberId: member, decision: 'signed' });
    expect(
      await sqlState(
        db.insert(signoffs).values({ candidateId: candidate.id, taskMemberId: member, decision: 'signed' })
      )
    ).toBe('23505');
    // The other member still signs, and a new candidate version starts fresh.
    await db
      .insert(signoffs)
      .values({ candidateId: candidate.id, taskMemberId: members.get(otherAgentId)!, decision: 'signed' });
    const next = await newCandidate(id, 2);
    await db.insert(signoffs).values({ candidateId: next.id, taskMemberId: member, decision: 'signed' });
  });

  it('requires a refusal to cite a finding, and protects the cited finding', async () => {
    const { id, members } = await newTask('Refuse with reason');
    const candidate = await newCandidate(id);
    const member = members.get(agentId)!;
    expect(
      await sqlState(
        db.insert(signoffs).values({ candidateId: candidate.id, taskMemberId: member, decision: 'refused' })
      )
    ).toBe('23514');

    const [finding] = await db
      .insert(findings)
      .values({ taskId: id, source: 'agent', reporterAgentId: agentId, severity: 'blocker', body: 'Off by one' })
      .returning();
    await db.insert(signoffs).values({
      candidateId: candidate.id,
      taskMemberId: member,
      decision: 'refused',
      findingId: finding!.id,
    });
    expect(await sqlState(db.delete(findings).where(eq(findings.id, finding!.id)))).toBe('23503');
  });
});

describe('plans and packages', () => {
  it('versions plans, takes one review per member, and requires a reason to object', async () => {
    const { id, members } = await newTask('Planned');
    const [plan] = await db
      .insert(plans)
      .values({ taskId: id, version: 1, hash: 'h1', authorAgentId: agentId, body: { packages: [] } })
      .returning();
    expect(
      await sqlState(db.insert(plans).values({ taskId: id, version: 1, hash: 'h1b', body: {} }))
    ).toBe('23505');

    const member = members.get(otherAgentId)!;
    expect(
      await sqlState(
        db.insert(planReviews).values({ planId: plan!.id, taskMemberId: member, decision: 'object' })
      )
    ).toBe('23514');
    await db
      .insert(planReviews)
      .values({ planId: plan!.id, taskMemberId: member, decision: 'object', reason: 'Split the API package' });
    expect(
      await sqlState(
        db.insert(planReviews).values({ planId: plan!.id, taskMemberId: member, decision: 'approve' })
      )
    ).toBe('23505');

    await db.insert(workPackages).values({ taskId: id, planId: plan!.id, key: 'api', title: 'API' });
    expect(
      await sqlState(
        db.insert(workPackages).values({ taskId: id, planId: plan!.id, key: 'api', title: 'Again' })
      )
    ).toBe('23505');
  });
});

describe('streams and watermarks', () => {
  it('orders run events by a unique per-run sequence', async () => {
    const { id } = await newTask('Streaming');
    const [run] = await db
      .insert(runs)
      .values({ userId, agentId, agentName: 'Signer A', taskId: id, trigger: 'manual' })
      .returning();
    await db.insert(runEvents).values({ runId: run!.id, seq: 1, kind: 'message_delta', payload: { text: 'hi' } });
    expect(
      await sqlState(db.insert(runEvents).values({ runId: run!.id, seq: 1, kind: 'usage' }))
    ).toBe('23505');
  });

  it('keeps one context watermark per member session epoch', async () => {
    const { members } = await newTask('Watermarks');
    const member = members.get(agentId)!;
    await db.insert(contextDeliveries).values({ taskMemberId: member, sessionEpoch: 0, deliveredThroughSeq: 4 });
    expect(
      await sqlState(db.insert(contextDeliveries).values({ taskMemberId: member, sessionEpoch: 0 }))
    ).toBe('23505');
    await db.insert(contextDeliveries).values({ taskMemberId: member, sessionEpoch: 1 });
  });
});
