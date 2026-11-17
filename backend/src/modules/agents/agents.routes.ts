import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { z } from 'zod';
import { badRequest, notFound } from '../../http/errors';
import { requireAuth, type AuthedRequest } from '../../http/middleware/auth';
import { storage } from '../../storage/layout';
import { db } from '../../db/client';
import { agents } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { checkCliForPlatform } from '../providers/runtime-health';
import { getProviderCredentials } from '../providers/providers.service';
import {
  createAgent,
  deleteAgent,
  getAgent,
  listAgents,
  updateAgent,
  updateAgentConfig,
  VENDORS_FOR_RUNTIME,
} from './agents.service';
import { CLI_RUNTIMES, isAgentRuntime, type AgentRuntime } from './runtimes';

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

export const agentsRouter = Router();

// Public: avatars are embedded via <img>, which cannot send Authorization.
// Agent ids are UUIDs; treat them as unguessable capability tokens here.
agentsRouter.get('/:id/avatar', async (req, res, next) => {
  try {
    const [agent] = await db
      .select({ userId: agents.userId, avatarFile: agents.avatarFile })
      .from(agents)
      .where(eq(agents.id, String(req.params.id)))
      .limit(1);
    if (!agent?.avatarFile) throw notFound('Avatar not found');

    const avatarPath = path.join(storage.agentPaths(agent.userId, String(req.params.id)).root, agent.avatarFile);
    if (!fs.existsSync(avatarPath)) throw notFound('Avatar not found');
    res.sendFile(avatarPath);
  } catch (error) {
    next(error);
  }
});

agentsRouter.use(requireAuth);

const createSchema = z.object({
  name: z.string().min(1).max(80),
  runtime: z.enum([...CLI_RUNTIMES, 'api'] as [string, ...string[]]),
  description: z.string().max(2000).optional(),
  tags: z.array(z.string().min(1)).max(16).optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(2000).optional(),
  tags: z.array(z.string().min(1)).max(16).optional(),
});

const configSchema = z.object({
  providerId: z.string().uuid().nullable().optional(),
  model: z.string().min(1).max(128).nullable().optional(),
  execution: z.enum(['server', 'api']).optional(),
});

function parseOr400<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw badRequest('invalid_input', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  return parsed.data;
}

agentsRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    res.json({ agents: await listAgents(req.auth!.userId) });
  } catch (error) {
    next(error);
  }
});

agentsRouter.post('/', async (req: AuthedRequest, res, next) => {
  try {
    const input = parseOr400(createSchema, req.body);
    const agent = await createAgent(req.auth!.userId, {
      ...input,
      runtime: input.runtime as AgentRuntime,
    });
    res.status(201).json({ agent });
  } catch (error) {
    next(error);
  }
});

agentsRouter.get('/:id', async (req: AuthedRequest, res, next) => {
  try {
    res.json({ agent: await getAgent(req.auth!.userId, String(req.params.id)) });
  } catch (error) {
    next(error);
  }
});

agentsRouter.patch('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const input = parseOr400(updateSchema, req.body);
    res.json({ agent: await updateAgent(req.auth!.userId, String(req.params.id), input) });
  } catch (error) {
    next(error);
  }
});

agentsRouter.patch('/:id/config', async (req: AuthedRequest, res, next) => {
  try {
    const input = parseOr400(configSchema, req.body);
    res.json({ agent: await updateAgentConfig(req.auth!.userId, String(req.params.id), input) });
  } catch (error) {
    next(error);
  }
});

agentsRouter.delete('/:id', async (req: AuthedRequest, res, next) => {
  try {
    await deleteAgent(req.auth!.userId, String(req.params.id));
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

agentsRouter.post(
  '/:id/avatar',
  avatarUpload.single('avatar'),
  async (req: AuthedRequest, res, next) => {
    try {
      if (!req.file) throw badRequest('invalid_input', 'Avatar file is required');
      if (!req.file.mimetype.startsWith('image/')) {
        throw badRequest('invalid_input', 'Avatar must be an image');
      }
      const agentId = String(req.params.id);
      const agent = await getAgent(req.auth!.userId, agentId);

      const ext = path.extname(req.file.originalname).toLowerCase() || '.png';
      const filename = `avatar${ext}`;
      const agentRoot = storage.agentPaths(agent.userId, agentId).root;
      if (agent.avatarFile && agent.avatarFile !== filename) {
        fs.rmSync(path.join(agentRoot, agent.avatarFile), { force: true });
      }
      fs.writeFileSync(path.join(agentRoot, filename), req.file.buffer);

      await updateAgent(req.auth!.userId, agentId, { avatarFile: filename });
      res.json({ ok: true, avatarUrl: `/api/agents/${agentId}/avatar` });
    } catch (error) {
      next(error);
    }
  }
);

// Readiness snapshot: CLI availability plus provider/model wiring.
agentsRouter.get('/:id/diagnostics', async (req: AuthedRequest, res, next) => {
  try {
    const agent = await getAgent(req.auth!.userId, String(req.params.id));
    const cli =
      agent.runtime === 'api'
        ? { available: true, version: 'hosted API runtime' }
        : await checkCliForPlatform(agent.runtime);

    let provider: { vendor: string; vendorMatch: boolean; modelCount: number } | null = null;
    if (agent.providerId) {
      const credentials = await getProviderCredentials(req.auth!.userId, agent.providerId);
      if (credentials) {
        provider = {
          vendor: credentials.vendor,
          vendorMatch: (VENDORS_FOR_RUNTIME[agent.runtime as AgentRuntime] ?? []).includes(
            credentials.vendor
          ),
          modelCount: credentials.models.length,
        };
      }
    }

    res.json({
      agent: { id: agent.id, name: agent.name, runtime: agent.runtime, model: agent.model },
      cli,
      provider,
    });
  } catch (error) {
    next(error);
  }
});
