import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { TurnPermission } from '@swarmdev/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client';
import { runs } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { setTaskHostFactoryForTests } from '../src/modules/runs/task-run';
import { drainRunsForTests } from '../src/modules/runs/wake';
import { scriptedHost } from './support/scripted-host';

/** Workshop dispatches started for real, through admission and the task runner. */
const app = createApp();
let token = '';
const seen: { agent: string; permission: TurnPermission }[] = [];

const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  await pool.query('TRUNCATE TABLE users CASCADE');
  setTaskHostFactoryForTests(
    scriptedHost(async (turn) => {
      seen.push({ agent: turn.prompt.includes('Explorer B') ? 'B' : 'A', permission: turn.permission });
      return { text: 'Looked around.' };
    })
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
  it('runs explore dispatches read-only even for agents allowed to write', async () => {
    const ids: string[] = [];
    for (const name of ['Explorer A', 'Explorer B']) {
      const res = await request(app)
        .post('/api/agents')
        .set(auth())
        .send({ name, runtime: 'claude-code', permissionLevel: 'full' });
      ids.push((res.body.agent ?? res.body).id);
    }
    const task = await request(app)
      .post('/api/tasks')
      .set(auth())
      .send({ title: 'Look first', playbook: 'build', leadAgentId: ids[0], memberAgentIds: ids });
    await request(app).post(`/api/tasks/${task.body.task.id}/start`).set(auth());
    await drainRunsForTests();

    const done = await db.select().from(runs).where(eq(runs.taskId, task.body.task.id));
    expect(done.map((r) => r.status)).toEqual(['succeeded', 'succeeded']);
    expect(seen).toHaveLength(2);
    for (const turn of seen) expect(turn.permission).toBe('read_only');
  });
});
