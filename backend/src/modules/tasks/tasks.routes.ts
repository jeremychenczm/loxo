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
import { addHumanComment, listComments } from './comments.service';
import { createReview, listReviews } from './reviews.service';
import {
  createTask,
  deleteTask,
  getBoard,
  getTask,
  listTasks,
  moveTask,
  updateTask,
} from './tasks.service';

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

const assignmentPatch = z
  .object({
    agentId: z.string().uuid().nullable().optional(),
    userId: z.string().uuid().nullable().optional(),
  })
  .nullable();

tasksRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const schema = z.object({
      projectId: z.string().uuid().optional(),
      status: taskStatus.optional(),
      assigneeAgentId: z.string().uuid().optional(),
    });
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) throw badRequest('invalid_input', 'Invalid task filter');
    res.json({ tasks: await listTasks(req.auth!.userId, parsed.data) });
  } catch (error) {
    next(error);
  }
});

tasksRouter.get('/board', async (req: AuthedRequest, res, next) => {
  try {
    const schema = z.object({ projectId: z.string().uuid().optional() });
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) throw badRequest('invalid_input', 'Invalid board filter');
    res.json({ board: await getBoard(req.auth!.userId, parsed.data.projectId) });
  } catch (error) {
    next(error);
  }
});

tasksRouter.post('/', async (req: AuthedRequest, res, next) => {
  try {
    const schema = z.object({
      title: z.string().trim().min(1).max(300),
      brief: z.string().max(10000).optional(),
      projectId: z.string().uuid().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid_input', 'Task title is required');
    res.status(201).json({ task: await createTask(req.auth!.userId, parsed.data) });
  } catch (error) {
    next(error);
  }
});

tasksRouter.get('/:id', async (req: AuthedRequest, res, next) => {
  try {
    res.json({ task: await getTask(req.auth!.userId, String(req.params.id)) });
  } catch (error) {
    next(error);
  }
});

tasksRouter.patch('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const schema = z.object({
      title: z.string().trim().min(1).max(300).optional(),
      brief: z.string().max(10000).optional(),
      assignee: assignmentPatch.optional(),
      reviewer: assignmentPatch.optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid_input', 'Invalid task update');
    res.json({ task: await updateTask(req.auth!.userId, String(req.params.id), parsed.data) });
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
    res.json({ task: await moveTask(req.auth!.userId, String(req.params.id), parsed.data) });
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
    if (!task.assigneeAgentId) {
      throw badRequest('no_agent_assignee', 'Assign an agent to this task first');
    }
    const decision = await requestWake(req.auth!.userId, {
      agentId: task.assigneeAgentId,
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

tasksRouter.get('/:id/comments', async (req: AuthedRequest, res, next) => {
  try {
    res.json({ comments: await listComments(req.auth!.userId, String(req.params.id)) });
  } catch (error) {
    next(error);
  }
});

tasksRouter.post('/:id/comments', async (req: AuthedRequest, res, next) => {
  try {
    const schema = z.object({ body: z.string().trim().min(1).max(20000) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid_input', 'Comment body is required');
    res.status(201).json({
      comment: await addHumanComment(req.auth!.userId, String(req.params.id), parsed.data.body),
    });
  } catch (error) {
    next(error);
  }
});

tasksRouter.get('/:id/reviews', async (req: AuthedRequest, res, next) => {
  try {
    res.json({ reviews: await listReviews(req.auth!.userId, String(req.params.id)) });
  } catch (error) {
    next(error);
  }
});

tasksRouter.post('/:id/reviews', async (req: AuthedRequest, res, next) => {
  try {
    const schema = z.object({
      decision: z.enum(['approved', 'changes_requested']),
      body: z.string().trim().min(1).max(20000),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid_input', 'A review needs a decision and a comment');
    const review = await createReview(req.auth!.userId, String(req.params.id), {
      decision: parsed.data.decision,
      body: parsed.data.body,
      reviewer: { userId: req.auth!.userId },
    });
    res.status(201).json({ review });
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
