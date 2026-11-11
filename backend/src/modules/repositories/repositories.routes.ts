import { Router } from 'express';
import { z } from 'zod';
import { badRequest } from '../../http/errors';
import { requireAuth, type AuthedRequest } from '../../http/middleware/auth';
import {
  createRepository,
  deleteRepository,
  getRepository,
  inspectRepository,
  listRepositories,
  updateRepository,
} from './repositories.service';

export const repositoriesRouter = Router();
repositoriesRouter.use(requireAuth);

const checkSchema = z.object({
  name: z.string().trim().min(1).max(64),
  command: z.string().trim().min(1).max(2000),
  timeoutSeconds: z.number().int().min(1).max(3600).default(600),
});

const settingsSchema = z.object({
  name: z.string().max(120).optional(),
  defaultBranch: z.string().trim().min(1).max(200).optional(),
  setupCommand: z.string().max(2000).nullable().optional(),
  checks: z.array(checkSchema).max(20).optional(),
});

const createSchema = settingsSchema.extend({
  rootPath: z.string().trim().min(1).max(1024),
});

function parseOr400<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw badRequest('invalid_input', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  return parsed.data;
}

repositoriesRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    res.json({ repositories: await listRepositories(req.auth!.userId) });
  } catch (error) {
    next(error);
  }
});

repositoriesRouter.post('/', async (req: AuthedRequest, res, next) => {
  try {
    const input = parseOr400(createSchema, req.body);
    res.status(201).json({ repository: await createRepository(req.auth!.userId, input) });
  } catch (error) {
    next(error);
  }
});

repositoriesRouter.get('/:id', async (req: AuthedRequest, res, next) => {
  try {
    res.json({ repository: await getRepository(req.auth!.userId, String(req.params.id)) });
  } catch (error) {
    next(error);
  }
});

repositoriesRouter.patch('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const input = parseOr400(settingsSchema, req.body);
    res.json({
      repository: await updateRepository(req.auth!.userId, String(req.params.id), input),
    });
  } catch (error) {
    next(error);
  }
});

repositoriesRouter.post('/:id/inspect', async (req: AuthedRequest, res, next) => {
  try {
    res.json({ inspection: await inspectRepository(req.auth!.userId, String(req.params.id)) });
  } catch (error) {
    next(error);
  }
});

repositoriesRouter.delete('/:id', async (req: AuthedRequest, res, next) => {
  try {
    await deleteRepository(req.auth!.userId, String(req.params.id));
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});
