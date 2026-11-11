import { Router } from 'express';
import { z } from 'zod';
import { badRequest } from '../../http/errors';
import { requireAuth, type AuthedRequest } from '../../http/middleware/auth';
import { requestWake } from '../runs/wake';
import {
  abandonTaskWorkspace,
  finalizeTaskWorkspace,
  getTaskChanges,
  getTaskWorkspace,
  prepareTaskWorkspace,
  reconcileTaskWorkspace,
} from '../code-workspaces/workspace.service';
import { listApprovals, recordApproval } from './approvals.service';
import {
  createTask,
  deleteTask,
  getBoard,
  getTask,
  listTasks,
  MAX_TASK_MEMBERS,
  moveTask,
  toTaskView,
  toTaskViews,
  updateTask,
} from './tasks.service';
import { addHumanTurn, listTurns } from './turns.service';

export const tasksRouter = Router();
tasksRouter.use(requireAuth);

// Code workspace state and evidence. Preparation normally happens at run
// admission; the manual endpoints exist for diagnosis and recovery.
tasksRouter.get('/:id/workspace', async (req: AuthedRequest, res, next) => {
  try {
    await getTask(req.auth!.userId, String(req.params.id)); // ownership
    res.json({ workspace: await getTaskWorkspace(req.auth!.userId, String(req.params.id)) });
  } catch (error) {
    next(error);
  }
});

tasksRouter.post('/:id/workspace/prepare', async (req: AuthedRequest, res, next) => {
  try {
    const task = await getTask(req.auth!.userId, String(req.params.id));
    res.json({ workspace: await prepareTaskWorkspace(req.auth!.userId, task) });
  } catch (error) {
    next(error);
  }
});

tasksRouter.post('/:id/workspace/reconcile', async (req: AuthedRequest, res, next) => {
  try {
    await getTask(req.auth!.userId, String(req.params.id)); // ownership
    res.json({ workspace: await reconcileTaskWorkspace(req.auth!.userId, String(req.params.id)) });
  } catch (error) {
    next(error);
  }
});

tasksRouter.get('/:id/changes', async (req: AuthedRequest, res, next) => {
  try {
    await getTask(req.auth!.userId, String(req.params.id)); // ownership
    res.json(await getTaskChanges(req.auth!.userId, String(req.params.id)));
  } catch (error) {
    next(error);
  }
});

tasksRouter.post('/:id/workspace/merge', async (req: AuthedRequest, res, next) => {
  try {
    await getTask(req.auth!.userId, String(req.params.id)); // ownership
    res.json(
      await finalizeTaskWorkspace(req.auth!.userId, String(req.params.id), {
        action: 'merge',
        confirmCheckpoint: req.body?.confirmCheckpoint === true,
      })
    );
  } catch (error) {
    next(error);
  }
});

tasksRouter.post('/:id/workspace/keep-branch', async (req: AuthedRequest, res, next) => {
  try {
    await getTask(req.auth!.userId, String(req.params.id)); // ownership
    res.json(
      await finalizeTaskWorkspace(req.auth!.userId, String(req.params.id), {
        action: 'keep_branch',
        confirmCheckpoint: req.body?.confirmCheckpoint === true,
      })
    );
  } catch (error) {
    next(error);
  }
});

tasksRouter.post('/:id/workspace/abandon', async (req: AuthedRequest, res, next) => {
  try {
    await getTask(req.auth!.userId, String(req.params.id)); // ownership
    res.json(
      await abandonTaskWorkspace(req.auth!.userId, String(req.params.id), {
        confirmDiscard: req.body?.confirmDiscard === true,
      })
    );
  } catch (error) {
    next(error);
  }
});

const taskStatus = z.enum([
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'blocked',
  'done',
  'cancelled',
]);

const memberIds = z.array(z.string().uuid()).max(MAX_TASK_MEMBERS);

tasksRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const schema = z.object({
      repositoryId: z.string().uuid().optional(),
      status: taskStatus.optional(),
      leadAgentId: z.string().uuid().optional(),
    });
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) throw badRequest('invalid_input', 'Invalid task filter');
    res.json({ tasks: await toTaskViews(await listTasks(req.auth!.userId, parsed.data)) });
  } catch (error) {
    next(error);
  }
});

tasksRouter.get('/board', async (req: AuthedRequest, res, next) => {
  try {
    const schema = z.object({ repositoryId: z.string().uuid().optional() });
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) throw badRequest('invalid_input', 'Invalid board filter');
    res.json({ board: await getBoard(req.auth!.userId, parsed.data.repositoryId) });
  } catch (error) {
    next(error);
  }
});

tasksRouter.post('/', async (req: AuthedRequest, res, next) => {
  try {
    const schema = z.object({
      title: z.string().trim().min(1).max(300),
      brief: z.string().max(10000).optional(),
      repositoryId: z.string().uuid().optional(),
      crewId: z.string().uuid().optional(),
      leadAgentId: z.string().uuid().optional(),
      memberAgentIds: memberIds.optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid_input', 'Task title is required');
    const task = await createTask(req.auth!.userId, parsed.data);
    res.status(201).json({ task: await toTaskView(task) });
  } catch (error) {
    next(error);
  }
});

tasksRouter.get('/:id', async (req: AuthedRequest, res, next) => {
  try {
    res.json({ task: await toTaskView(await getTask(req.auth!.userId, String(req.params.id))) });
  } catch (error) {
    next(error);
  }
});

tasksRouter.patch('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const schema = z.object({
      title: z.string().trim().min(1).max(300).optional(),
      brief: z.string().max(10000).optional(),
      leadAgentId: z.string().uuid().nullable().optional(),
      memberAgentIds: memberIds.optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid_input', 'Invalid task update');
    const task = await updateTask(req.auth!.userId, String(req.params.id), parsed.data);
    res.json({ task: await toTaskView(task) });
  } catch (error) {
    next(error);
  }
});

tasksRouter.post('/:id/move', async (req: AuthedRequest, res, next) => {
  try {
    const schema = z.object({
      status: taskStatus,
      boardOrder: z.number().finite().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid_input', 'Invalid move');
    const task = await moveTask(req.auth!.userId, String(req.params.id), parsed.data);
    res.json({ task: await toTaskView(task) });
  } catch (error) {
    next(error);
  }
});

tasksRouter.post('/:id/wake', async (req: AuthedRequest, res, next) => {
  try {
    const schema = z.object({ reason: z.string().trim().max(2000).optional() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid_input', 'Invalid wake request');

    const task = await getTask(req.auth!.userId, String(req.params.id));
    if (!task.leadAgentId) {
      throw badRequest('no_lead', 'Choose a lead agent for this task first');
    }
    const decision = await requestWake(req.auth!.userId, {
      agentId: task.leadAgentId,
      taskId: task.id,
      trigger: 'manual',
      reason:
        parsed.data.reason ?? `Manual wake on task #${task.number}: ${task.title}`,
    });
    res.status(202).json({ run: decision.run, admitted: decision.admitted });
  } catch (error) {
    next(error);
  }
});

tasksRouter.get('/:id/turns', async (req: AuthedRequest, res, next) => {
  try {
    res.json({ turns: await listTurns(req.auth!.userId, String(req.params.id)) });
  } catch (error) {
    next(error);
  }
});

/** A person's interjection on the timeline; every member sees it on their next turn. */
tasksRouter.post('/:id/turns', async (req: AuthedRequest, res, next) => {
  try {
    const schema = z.object({ content: z.string().trim().min(1).max(20000) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid_input', 'Turn content is required');
    res.status(201).json({
      turn: await addHumanTurn(req.auth!.userId, String(req.params.id), parsed.data.content),
    });
  } catch (error) {
    next(error);
  }
});

tasksRouter.get('/:id/approvals', async (req: AuthedRequest, res, next) => {
  try {
    res.json({ approvals: await listApprovals(req.auth!.userId, String(req.params.id)) });
  } catch (error) {
    next(error);
  }
});

tasksRouter.post('/:id/approvals', async (req: AuthedRequest, res, next) => {
  try {
    const schema = z.object({
      decision: z.enum(['approved', 'changes_requested']),
      body: z.string().trim().min(1).max(20000),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('invalid_input', 'An approval needs a decision and a comment');
    }
    const approval = await recordApproval(req.auth!.userId, String(req.params.id), parsed.data);
    res.status(201).json({ approval });
  } catch (error) {
    next(error);
  }
});

tasksRouter.delete('/:id', async (req: AuthedRequest, res, next) => {
  try {
    await deleteTask(req.auth!.userId, String(req.params.id));
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});
