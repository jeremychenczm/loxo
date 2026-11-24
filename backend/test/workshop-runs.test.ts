import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import type { TurnPermission } from '@swarmdev/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import { agents, dispatches, runs, tasks, type Agent } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { submitDispatchReport, submitResult } from '../src/modules/control-plane/tools';
import { setTaskHostFactoryForTests } from '../src/modules/runs/task-run';
import { drainRunsForTests } from '../src/modules/runs/wake';
import { agentPhase } from '../src/modules/workshop/phases';
import { sampleReport } from './support/reports';
import { scriptedHost } from './support/scripted-host';

/**
 * A workshop driven end to end through admission, the task runner and the
 * control plane: each scripted member answers with its phase's report tool,
 * and the engine moves the workshop on as each run settles.
 */
const app = createApp();
let token = '';
const seen: { phase: string; agent: string; permission: TurnPermission }[] = [];

const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  setTaskHostFactoryForTests((req) =>
    scriptedHost(async (turn) => {
      const [run] = await db
        .select()
        .from(runs)
        .where(and(eq(runs.status, 'running'), eq(runs.agentId, req.agent.id)));
      const [dispatch] = await db.select().from(dispatches).where(eq(dispatches.id, run!.dispatchId!));
      const [agent] = await db.select().from(agents).where(eq(agents.id, run!.agentId!));
      const [task] = await db.select().from(tasks).where(eq(tasks.id, run!.taskId!));
      seen.push({ phase: dispatch!.phase, agent: agent!.name, permission: turn.permission });
      const ctx = { run: run!, epoch: run!.ownerEpoch, agent: agent as Agent, task: task! };
      const tool = agentPhase(dispatch!.phase)!.reportTool;
      if (tool === 'submit_result') await submitResult(ctx, 'Built it.');
      else await submitDispatchReport(ctx, tool, sampleReport(tool, ctx, `${agent!.name} in ${dispatch!.phase}`));
      return { text: 'Done.' };
    })(req)
  );
  const reg = await request(app).post('/auth/register').send({
    email: 'workshop-runs@example.com',
    username: 'workshopruns',
    password: 'a-strong-password',
  });
  token = reg.body.token;
});

afterAll(async () => {
  await drainRunsForTests();
  setTaskHostFactoryForTests(null);
});

describe('workshop runs', () => {
  it('walks explore, plan, plan review and build to check, read-only until build', async () => {
    const ids: string[] = [];
    for (const name of ['Explorer A', 'Explorer B']) {
      const res = await request(app)
        .post('/api/agents')
        .set(auth())
        .send({ name, runtime: 'claude-code' });
      ids.push((res.body.agent ?? res.body).id);
    }
    const created = await request(app)
      .post('/api/tasks')
      .set(auth())
      .send({ title: 'Look first', playbook: 'build', leadAgentId: ids[0], memberAgentIds: ids });
    const taskId = created.body.task.id;
    await request(app).post(`/api/tasks/${taskId}/start`).set(auth());
    await drainRunsForTests();

    expect(seen.map((s) => `${s.phase}:${s.agent}`)).toEqual([
      'explore:Explorer A',
      'explore:Explorer B',
      'plan:Explorer A',
      'plan_review:Explorer B',
      'build:Explorer A',
    ]);
    for (const turn of seen.filter((s) => s.phase !== 'build')) expect(turn.permission).toBe('read_only');
    // Build runs at the agent's own level.
    const [lead] = await db.select().from(agents).where(eq(agents.id, ids[0]!));
    expect(seen.find((s) => s.phase === 'build')!.permission).toBe(lead!.permissionLevel);
    expect(lead!.permissionLevel).not.toBe('read_only');

    const statuses = await db.select({ phase: dispatches.phase, status: dispatches.status }).from(dispatches).where(eq(dispatches.taskId, taskId));
    expect(statuses.every((d) => d.status === 'reported')).toBe(true);
    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(task).toMatchObject({ phase: 'check', status: 'in_progress' });
  });
});
