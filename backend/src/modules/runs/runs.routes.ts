import { Router } from 'express';
import { z } from 'zod';
import { badRequest } from '../../http/errors';
import { requireAuth, type AuthedRequest } from '../../http/middleware/auth';
import { listRunEvents } from './run-events.service';
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

/** Event history after `after` (exclusive), for replay and for backfilling a live view. */
runsRouter.get('/:id/events', async (req: AuthedRequest, res, next) => {
  try {
    const schema = z.object({ after: z.coerce.number().int().nonnegative().optional() });
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) throw badRequest('invalid_input', 'after must be a non-negative integer');
    res.json({
      events: await listRunEvents(req.auth!.userId, String(req.params.id), parsed.data.after ?? 0),
    });
  } catch (error) {
    next(error);
  }
});
