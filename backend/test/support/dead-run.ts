import { eq, sql } from 'drizzle-orm';
import type { Express } from 'express';
import request from 'supertest';
import { db } from '../../src/db/client';
import { agents, runs, tasks } from '../../src/db/schema';
import { prepareTaskWorkspace, snapshotBeforeRun } from '../../src/modules/code-workspaces/workspace.service';
import type { RunToolContext } from '../../src/modules/control-plane/tools';
import { admitRun } from '../../src/modules/runs/runs.service';

export const DEAD_INSTANCE = 'dead-instance';

export interface DeadRunEnv {
  app: Express;
  token: string;
  userId: string;
  repositoryId: string;
}

export interface DeadRunOptions {
  trigger?: 'manual' | 'review';
  repository?: boolean;
  /** Record a before-state as a real run would before starting its agent. */
  pinBefore?: boolean;
  /** Worktree state the run starts from, set up before the before-state is pinned. */
  beforePin?: (worktree: string) => Promise<void> | void;
  /** The launcher the run's session recorded, as task-run does when it opens. */
  launcher?: { pid: number; tag: string; host: string };
}

export interface DeadRun {
  ctx: RunToolContext;
  worktree: string | null;
}

let counter = 0;

/**
 * A run admitted by an instance that is about to die: running under epoch 1,
 * with a before-state when the task has a repository. `act` plays what the
 * run did before its owner died; then the lease runs out.
 */
export async function deadRun(
  env: DeadRunEnv,
  options: DeadRunOptions = {},
  act: (run: DeadRun) => Promise<void> = async () => {}
): Promise<DeadRun> {
  counter += 1;
  const auth = { Authorization: `Bearer ${env.token}` };
  const agentRes = await request(env.app)
    .post('/api/agents')
    .set(auth)
    .send({ name: `Worker ${counter}`, runtime: 'claude-code' });
  const taskRes = await request(env.app)
    .post('/api/tasks')
    .set(auth)
    .send({ title: `Task ${counter}`, ...(options.repository ? { repositoryId: env.repositoryId } : {}) });
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskRes.body.task.id));
  await db.update(tasks).set({ status: 'in_progress' }).where(eq(tasks.id, task!.id));
  const workspace = options.repository ? await prepareTaskWorkspace(env.userId, task!) : null;
  if (workspace && options.beforePin) await options.beforePin(workspace.worktreePath);
  const [queued] = await db
    .insert(runs)
    .values({
      userId: env.userId,
      agentId: agentRes.body.agent.id,
      agentName: `Worker ${counter}`,
      taskId: task!.id,
      trigger: options.trigger ?? 'manual',
      gateKey: `task:${task!.id}`,
      reason: `Work on task ${counter}`,
    })
    .returning();
  const admission = await admitRun(queued!.id, { instance: DEAD_INSTANCE });
  const run = admission!.run;
  if (workspace && options.pinBefore !== false) {
    await snapshotBeforeRun({ runId: run.id, epoch: run.ownerEpoch, instance: DEAD_INSTANCE }, workspace);
  }
  if (options.launcher) {
    await db
      .update(runs)
      .set({ launcherPid: options.launcher.pid, launcherTag: options.launcher.tag, launcherHost: options.launcher.host })
      .where(eq(runs.id, run.id));
  }
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentRes.body.agent.id));
  const dead: DeadRun = {
    ctx: { run, epoch: run.ownerEpoch, agent: agent!, task: task! },
    worktree: workspace?.worktreePath ?? null,
  };
  await act(dead);
  await db.update(runs).set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(runs.id, run.id));
  return dead;
}
