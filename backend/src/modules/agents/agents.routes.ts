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
  createGroup,
  deleteAgent,
  deleteGroup,
  getAgent,
  listAgents,
  listGroups,
  updateAgent,
  updateAgentConfig,
  updateGroup,
  VENDORS_FOR_RUNTIME,
} from './agents.service';
import { importAgent, unpackArchive, type ImportFile } from './agent-import.service';
import { addSkillFromMarkdown, addSkillsFromArchive, listSkills } from './agent-skills.service';
import { CLI_RUNTIMES, isAgentRuntime, type AgentRuntime } from './runtime-detect';

const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1000, fileSize: 50 * 1024 * 1024 },
});
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});
const skillUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
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
  groupId: z.string().uuid().nullable().optional(),
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
    const groupId = typeof req.query.groupId === 'string' ? req.query.groupId : undefined;
    const filter = groupId === 'none' ? { ungrouped: true } : groupId ? { groupId } : {};
    res.json({ agents: await listAgents(req.auth!.userId, filter) });
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

// Import: zip archive (field "archive") or individual files (field "files",
// filenames carry workspace-relative paths).
agentsRouter.post(
  '/import',
  importUpload.fields([
    { name: 'archive', maxCount: 1 },
    { name: 'files', maxCount: 1000 },
  ]),
  async (req: AuthedRequest, res, next) => {
    try {
      const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
      if (!name) throw badRequest('invalid_input', 'Agent name is required');
      const runtime = typeof req.body.runtime === 'string' ? req.body.runtime : undefined;
      const description =
        typeof req.body.description === 'string' ? req.body.description : undefined;

      const uploaded = req.files as Record<string, Express.Multer.File[]> | undefined;
      let files: ImportFile[];
      if (uploaded?.archive?.[0]) {
        files = unpackArchive(uploaded.archive[0].buffer);
      } else if (uploaded?.files?.length) {
        files = uploaded.files.map((f) => ({ relativePath: f.originalname, content: f.buffer }));
        for (const file of files) {
          if (!/^[^\0]+$/.test(file.relativePath)) {
            throw badRequest('unsafe_path', 'Invalid file path');
          }
        }
      } else {
        throw badRequest('invalid_input', 'Provide an archive or files to import');
      }

      const result = await importAgent(req.auth!.userId, files, { name, description, runtime });
      res.status(201).json({ agent: result.agent, fileCount: result.fileCount });
    } catch (error) {
      next(error);
    }
  }
);

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

agentsRouter.get('/:id/skills', async (req: AuthedRequest, res, next) => {
  try {
    res.json({ skills: await listSkills(req.auth!.userId, String(req.params.id)) });
  } catch (error) {
    next(error);
  }
});

agentsRouter.post(
  '/:id/skills',
  skillUpload.single('skill'),
  async (req: AuthedRequest, res, next) => {
    try {
      if (!req.file) throw badRequest('invalid_input', 'Skill file is required');
      const agentId = String(req.params.id);
      const name = typeof req.body.name === 'string' ? req.body.name : undefined;
      const ext = path.extname(req.file.originalname).toLowerCase();

      const skills =
        ext === '.zip'
          ? await addSkillsFromArchive(req.auth!.userId, agentId, req.file.buffer)
          : await addSkillFromMarkdown(req.auth!.userId, agentId, req.file, name);
      res.status(201).json({ skills });
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

// Groups

export const groupsRouter = Router();
groupsRouter.use(requireAuth);

const groupSchema = z.object({
  name: z.string().min(1).max(64),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
});

groupsRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    res.json({ groups: await listGroups(req.auth!.userId) });
  } catch (error) {
    next(error);
  }
});

groupsRouter.post('/', async (req: AuthedRequest, res, next) => {
  try {
    const input = parseOr400(groupSchema, req.body);
    res.status(201).json({ group: await createGroup(req.auth!.userId, input) });
  } catch (error) {
    next(error);
  }
});

groupsRouter.patch('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const input = parseOr400(groupSchema.partial().extend({ sortOrder: z.number().int().optional() }), req.body);
    res.json({ group: await updateGroup(req.auth!.userId, String(req.params.id), input) });
  } catch (error) {
    next(error);
  }
});

groupsRouter.delete('/:id', async (req: AuthedRequest, res, next) => {
  try {
    await deleteGroup(req.auth!.userId, String(req.params.id));
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});
