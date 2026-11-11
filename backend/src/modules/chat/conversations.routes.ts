import { Router } from 'express';
import { z } from 'zod';
import { badRequest } from '../../http/errors';
import { requireAuth, type AuthedRequest } from '../../http/middleware/auth';
import {
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  listMessages,
  openConversation,
  renameConversation,
} from './conversations.service';
import { draftTaskFromConversation } from './task-draft.service';
import { toTaskView } from '../tasks/tasks.service';
import { fileTaskFromConversation } from './task-filing.service';

export const conversationsRouter = Router();
conversationsRouter.use(requireAuth);

conversationsRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : undefined;
    res.json({ conversations: await listConversations(req.auth!.userId, agentId) });
  } catch (error) {
    next(error);
  }
});

conversationsRouter.post('/', async (req: AuthedRequest, res, next) => {
  try {
    const schema = z.object({ agentId: z.string().uuid(), title: z.string().max(120).optional() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid_input', 'agentId is required');
    // Untitled creates reuse an existing empty conversation; an explicit
    // title always makes a fresh one.
    const conversation = parsed.data.title?.trim()
      ? await createConversation(req.auth!.userId, parsed.data.agentId, parsed.data.title)
      : await openConversation(req.auth!.userId, parsed.data.agentId);
    res.status(201).json({ conversation });
  } catch (error) {
    next(error);
  }
});

conversationsRouter.patch('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    if (!title || title.length > 120) {
      throw badRequest('invalid_input', 'Title must be 1-120 characters');
    }
    res.json({
      conversation: await renameConversation(req.auth!.userId, String(req.params.id), title),
    });
  } catch (error) {
    next(error);
  }
});

conversationsRouter.delete('/:id', async (req: AuthedRequest, res, next) => {
  try {
    await deleteConversation(req.auth!.userId, String(req.params.id));
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

conversationsRouter.get('/:id/messages', async (req: AuthedRequest, res, next) => {
  try {
    res.json({ messages: await listMessages(req.auth!.userId, String(req.params.id)) });
  } catch (error) {
    next(error);
  }
});

// Draft only — nothing is persisted until the user confirms the conversion.
// An explicit range overrides the topic-window heuristic.
conversationsRouter.post('/:id/draft-task', async (req: AuthedRequest, res, next) => {
  try {
    const schema = z.object({
      fromMessageId: z.string().uuid().optional(),
      toMessageId: z.string().uuid().optional(),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('invalid_input', 'Range must be message ids');
    res.json({
      draft: await draftTaskFromConversation(req.auth!.userId, String(req.params.id), parsed.data),
    });
  } catch (error) {
    next(error);
  }
});

// Files the user-confirmed draft; the draft endpoint above never persists.
conversationsRouter.post('/:id/file-task', async (req: AuthedRequest, res, next) => {
  try {
    const schema = z.object({
      title: z.string().trim().min(1).max(300),
      brief: z.string().max(10_000).optional(),
      repositoryId: z.string().uuid().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid_input', 'title is required');
    const task = await fileTaskFromConversation(
      req.auth!.userId,
      String(req.params.id),
      parsed.data
    );
    res.status(201).json({ task: await toTaskView(task) });
  } catch (error) {
    next(error);
  }
});

conversationsRouter.get('/:id/export', async (req: AuthedRequest, res, next) => {
  try {
    const conversationId = String(req.params.id);
    const conversation = await getConversation(req.auth!.userId, conversationId);
    const messages = await listMessages(req.auth!.userId, conversationId);
    res.setHeader('Content-Disposition', `attachment; filename="conversation-${conversationId}.json"`);
    res.json({ conversation, messages, exportedAt: new Date().toISOString() });
  } catch (error) {
    next(error);
  }
});
