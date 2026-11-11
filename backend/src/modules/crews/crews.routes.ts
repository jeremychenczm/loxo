import { Router } from 'express';
import { z } from 'zod';
import { badRequest } from '../../http/errors';
import { requireAuth, type AuthedRequest } from '../../http/middleware/auth';
import { createCrew, deleteCrew, getCrew, listCrews, MAX_CREW_MEMBERS, updateCrew } from './crews.service';

export const crewsRouter = Router();
crewsRouter.use(requireAuth);

const rosterSchema = z.array(z.string().uuid()).min(1).max(MAX_CREW_MEMBERS);

const createSchema = z.object({
  name: z.string().trim().min(1).max(64),
  description: z.string().max(2000).optional(),
  agentIds: rosterSchema,
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  description: z.string().max(2000).optional(),
  agentIds: rosterSchema.optional(),
});

function parseOr400<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw badRequest('invalid_input', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  return parsed.data;
}

crewsRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    res.json({ crews: await listCrews(req.auth!.userId) });
  } catch (error) {
    next(error);
  }
});

crewsRouter.post('/', async (req: AuthedRequest, res, next) => {
  try {
    const input = parseOr400(createSchema, req.body);
    res.status(201).json({ crew: await createCrew(req.auth!.userId, input) });
  } catch (error) {
    next(error);
  }
});

crewsRouter.get('/:id', async (req: AuthedRequest, res, next) => {
  try {
    res.json({ crew: await getCrew(req.auth!.userId, String(req.params.id)) });
  } catch (error) {
    next(error);
  }
});

crewsRouter.patch('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const input = parseOr400(updateSchema, req.body);
    res.json({ crew: await updateCrew(req.auth!.userId, String(req.params.id), input) });
  } catch (error) {
    next(error);
  }
});

crewsRouter.delete('/:id', async (req: AuthedRequest, res, next) => {
  try {
    await deleteCrew(req.auth!.userId, String(req.params.id));
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});
