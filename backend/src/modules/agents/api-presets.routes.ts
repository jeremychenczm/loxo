import { Router } from 'express';
import { z } from 'zod';
import { badRequest, notFound } from '../../http/errors';
import { requireAuth, type AuthedRequest } from '../../http/middleware/auth';
import { deployApiAgent, getApiAgentPreset, listApiAgentPresets } from './api-presets';

export const apiPresetsRouter = Router();

apiPresetsRouter.use(requireAuth);

const presetQuerySchema = z.object({
  search: z.string().max(120).optional(),
  category: z.string().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

apiPresetsRouter.get('/', (req: AuthedRequest, res, next) => {
  try {
    const parsed = presetQuerySchema.safeParse(req.query);
    if (!parsed.success) throw badRequest('invalid_query', parsed.error.issues[0]?.message ?? 'Invalid query');
    res.json({ presets: listApiAgentPresets(parsed.data) });
  } catch (error) {
    next(error);
  }
});

apiPresetsRouter.get('/:presetId', (req: AuthedRequest, res, next) => {
  try {
    const preset = getApiAgentPreset(String(req.params.presetId));
    if (!preset) throw notFound('API agent preset not found');
    res.json({ preset });
  } catch (error) {
    next(error);
  }
});

apiPresetsRouter.post('/:presetId/deploy', async (req: AuthedRequest, res, next) => {
  try {
    const agent = await deployApiAgent(req.auth!.userId, String(req.params.presetId));
    res.status(201).json({ agent });
  } catch (error) {
    next(error);
  }
});
