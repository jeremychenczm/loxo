import { Router } from 'express';
import { z } from 'zod';
import { badRequest } from '../../http/errors';
import { requireAuth, type AuthedRequest } from '../../http/middleware/auth';
import { getRun, listRuns } from './runs.service';

export const runsRouter = Router();
runsRouter.use(requireAuth);

runsRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const schema = z.object({
      taskId: z.string().uuid().optional(),
      agentId: z.string().uuid().optional(),
      status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']).optional(),
    });
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) throw badRequest('invalid_input', 'Invalid run filter');
    res.json({ runs: await listRuns(req.auth!.userId, parsed.data) });
  } catch (error) {
    next(error);
  }
});

runsRouter.get('/:id', async (req: AuthedRequest, res, next) => {
  try {
    res.json({ run: await getRun(req.auth!.userId, String(req.params.id)) });
  } catch (error) {
    next(error);
  }
});
