import { Router } from 'express';
import { z } from 'zod';
import { badRequest } from '../../http/errors';
import { requireAuth, type AuthedRequest } from '../../http/middleware/auth';
import { requestWake } from '../runs/wake';
import {
  abandonIssueWorkspace,
  finalizeIssueWorkspace,
  getIssueChanges,
  getIssueWorkspace,
  prepareIssueWorkspace,
  reconcileIssueWorkspace,
} from '../code-workspaces/workspace.service';
import { addHumanComment, listComments } from './comments.service';
import { createReview, listReviews } from './reviews.service';
import {
  createIssue,
  deleteIssue,
  getBoard,
  getIssue,
  listIssues,
  moveIssue,
  updateIssue,
} from './issues.service';

export const issuesRouter = Router();
issuesRouter.use(requireAuth);

// Code workspace state and evidence. Preparation normally happens at run
// admission; the manual endpoints exist for diagnosis and recovery.
issuesRouter.get('/:id/workspace', async (req: AuthedRequest, res, next) => {
  try {
    await getIssue(req.auth!.userId, String(req.params.id)); // ownership
    res.json({ workspace: await getIssueWorkspace(req.auth!.userId, String(req.params.id)) });
  } catch (error) {
    next(error);
  }
});

issuesRouter.post('/:id/workspace/prepare', async (req: AuthedRequest, res, next) => {
  try {
    const issue = await getIssue(req.auth!.userId, String(req.params.id));
    res.json({ workspace: await prepareIssueWorkspace(req.auth!.userId, issue) });
  } catch (error) {
    next(error);
  }
});

issuesRouter.post('/:id/workspace/reconcile', async (req: AuthedRequest, res, next) => {
  try {
    await getIssue(req.auth!.userId, String(req.params.id)); // ownership
    res.json({ workspace: await reconcileIssueWorkspace(req.auth!.userId, String(req.params.id)) });
  } catch (error) {
    next(error);
  }
});

issuesRouter.get('/:id/changes', async (req: AuthedRequest, res, next) => {
  try {
    await getIssue(req.auth!.userId, String(req.params.id)); // ownership
    res.json(await getIssueChanges(req.auth!.userId, String(req.params.id)));
  } catch (error) {
    next(error);
  }
});

issuesRouter.post('/:id/workspace/merge', async (req: AuthedRequest, res, next) => {
  try {
    await getIssue(req.auth!.userId, String(req.params.id)); // ownership
    res.json(
      await finalizeIssueWorkspace(req.auth!.userId, String(req.params.id), {
        action: 'merge',
        confirmCheckpoint: req.body?.confirmCheckpoint === true,
      })
    );
  } catch (error) {
    next(error);
  }
});

issuesRouter.post('/:id/workspace/keep-branch', async (req: AuthedRequest, res, next) => {
  try {
    await getIssue(req.auth!.userId, String(req.params.id)); // ownership
    res.json(
      await finalizeIssueWorkspace(req.auth!.userId, String(req.params.id), {
        action: 'keep_branch',
        confirmCheckpoint: req.body?.confirmCheckpoint === true,
      })
    );
  } catch (error) {
    next(error);
  }
});

issuesRouter.post('/:id/workspace/abandon', async (req: AuthedRequest, res, next) => {
  try {
    await getIssue(req.auth!.userId, String(req.params.id)); // ownership
    res.json(
      await abandonIssueWorkspace(req.auth!.userId, String(req.params.id), {
        confirmDiscard: req.body?.confirmDiscard === true,
      })
    );
  } catch (error) {
    next(error);
  }
});

const issueStatus = z.enum([
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

issuesRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const schema = z.object({
      projectId: z.string().uuid().optional(),
      status: issueStatus.optional(),
      assigneeAgentId: z.string().uuid().optional(),
    });
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) throw badRequest('invalid_input', 'Invalid issue filter');
    res.json({ issues: await listIssues(req.auth!.userId, parsed.data) });
  } catch (error) {
    next(error);
  }
});

issuesRouter.get('/board', async (req: AuthedRequest, res, next) => {
  try {
    const schema = z.object({ projectId: z.string().uuid().optional() });
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) throw badRequest('invalid_input', 'Invalid board filter');
    res.json({ board: await getBoard(req.auth!.userId, parsed.data.projectId) });
  } catch (error) {
    next(error);
  }
});

issuesRouter.post('/', async (req: AuthedRequest, res, next) => {
  try {
    const schema = z.object({
      title: z.string().trim().min(1).max(300),
      description: z.string().max(10000).optional(),
      projectId: z.string().uuid().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid_input', 'Issue title is required');
    res.status(201).json({ issue: await createIssue(req.auth!.userId, parsed.data) });
  } catch (error) {
    next(error);
  }
});

issuesRouter.get('/:id', async (req: AuthedRequest, res, next) => {
  try {
    res.json({ issue: await getIssue(req.auth!.userId, String(req.params.id)) });
  } catch (error) {
    next(error);
  }
});

issuesRouter.patch('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const schema = z.object({
      title: z.string().trim().min(1).max(300).optional(),
      description: z.string().max(10000).optional(),
      assignee: assignmentPatch.optional(),
      reviewer: assignmentPatch.optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid_input', 'Invalid issue update');
    res.json({ issue: await updateIssue(req.auth!.userId, String(req.params.id), parsed.data) });
  } catch (error) {
    next(error);
  }
});

issuesRouter.post('/:id/move', async (req: AuthedRequest, res, next) => {
  try {
    const schema = z.object({
      status: issueStatus,
      boardOrder: z.number().finite().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid_input', 'Invalid move');
    res.json({ issue: await moveIssue(req.auth!.userId, String(req.params.id), parsed.data) });
  } catch (error) {
    next(error);
  }
});

issuesRouter.post('/:id/wake', async (req: AuthedRequest, res, next) => {
  try {
    const schema = z.object({ reason: z.string().trim().max(2000).optional() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid_input', 'Invalid wake request');

    const issue = await getIssue(req.auth!.userId, String(req.params.id));
    if (!issue.assigneeAgentId) {
      throw badRequest('no_agent_assignee', 'Assign an agent to this issue first');
    }
    const decision = await requestWake(req.auth!.userId, {
      agentId: issue.assigneeAgentId,
      issueId: issue.id,
      trigger: 'manual',
      reason:
        parsed.data.reason ?? `Manual wake on issue #${issue.issueNumber}: ${issue.title}`,
    });
    res.status(202).json({ run: decision.run, admitted: decision.admitted });
  } catch (error) {
    next(error);
  }
});

issuesRouter.get('/:id/comments', async (req: AuthedRequest, res, next) => {
  try {
    res.json({ comments: await listComments(req.auth!.userId, String(req.params.id)) });
  } catch (error) {
    next(error);
  }
});

issuesRouter.post('/:id/comments', async (req: AuthedRequest, res, next) => {
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

issuesRouter.get('/:id/reviews', async (req: AuthedRequest, res, next) => {
  try {
    res.json({ reviews: await listReviews(req.auth!.userId, String(req.params.id)) });
  } catch (error) {
    next(error);
  }
});

issuesRouter.post('/:id/reviews', async (req: AuthedRequest, res, next) => {
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

issuesRouter.delete('/:id', async (req: AuthedRequest, res, next) => {
  try {
    await deleteIssue(req.auth!.userId, String(req.params.id));
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});
