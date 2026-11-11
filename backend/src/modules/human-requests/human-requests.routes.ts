import { Router } from 'express';
import { z } from 'zod';
import { badRequest } from '../../http/errors';
import { requireAuth, type AuthedRequest } from '../../http/middleware/auth';
import { answerHumanRequest, listHumanRequests } from './human-requests.service';

export const humanRequestsRouter = Router();
humanRequestsRouter.use(requireAuth);

humanRequestsRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const schema = z.object({
      status: z.enum(['open', 'answered', 'expired', 'cancelled']).optional(),
      taskId: z.string().uuid().optional(),
    });
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) throw badRequest('invalid_input', 'Invalid request filter');
    res.json({ requests: await listHumanRequests(req.auth!.userId, parsed.data) });
  } catch (error) {
    next(error);
  }
});

humanRequestsRouter.post('/:id/answer', async (req: AuthedRequest, res, next) => {
  try {
    const schema = z.object({
      choice: z.string().trim().min(1).max(4000),
      note: z.string().trim().max(2000).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid_input', 'An answer needs a choice');
    res.json({
      request: await answerHumanRequest(req.auth!.userId, String(req.params.id), parsed.data),
    });
  } catch (error) {
    next(error);
  }
});
