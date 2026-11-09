import { Router } from 'express';
import { z } from 'zod';
import { badRequest } from '../../http/errors';
import { requireAuth, type AuthedRequest } from '../../http/middleware/auth';
import {
  archiveProject,
  buildFileTree,
  deleteFile,
  previewFile,
  renameFile,
  resolveDownload,
} from './project-files.service';
import {
  bindProjectRepository,
  getProjectRepository,
  inspectProjectRepository,
  unbindProjectRepository,
} from '../code-workspaces/workspace.service';
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  touchProject,
  updateProject,
} from './projects.service';

export const projectsRouter = Router();
projectsRouter.use(requireAuth);

const bindingFields = {
  agentIds: z.array(z.string().uuid()).max(100).optional(),
};

projectsRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    res.json({ projects: await listProjects(req.auth!.userId) });
  } catch (error) {
    next(error);
  }
});

projectsRouter.post('/', async (req: AuthedRequest, res, next) => {
  try {
    const schema = z.object({
      name: z.string().trim().min(1).max(80),
      description: z.string().max(2000).optional(),
      ...bindingFields,
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid_input', 'Project name is required');
    res.status(201).json({ project: await createProject(req.auth!.userId, parsed.data) });
  } catch (error) {
    next(error);
  }
});

projectsRouter.get('/:id', async (req: AuthedRequest, res, next) => {
  try {
    res.json({ project: await getProject(req.auth!.userId, String(req.params.id)) });
  } catch (error) {
    next(error);
  }
});

/** Recency bump; the client calls this when the workspace opens. */
projectsRouter.post('/:id/open', async (req: AuthedRequest, res, next) => {
  try {
    res.json({ project: await touchProject(req.auth!.userId, String(req.params.id)) });
  } catch (error) {
    next(error);
  }
});

projectsRouter.patch('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const schema = z.object({
      name: z.string().trim().min(1).max(80).optional(),
      description: z.string().max(2000).optional(),
      ...bindingFields,
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid_input', 'Invalid project fields');
    res.json({
      project: await updateProject(req.auth!.userId, String(req.params.id), parsed.data),
    });
  } catch (error) {
    next(error);
  }
});

projectsRouter.delete('/:id', async (req: AuthedRequest, res, next) => {
  try {
    await deleteProject(req.auth!.userId, String(req.params.id));
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// Repository binding for code execution.
projectsRouter.get('/:id/repository', async (req: AuthedRequest, res, next) => {
  try {
    await getProject(req.auth!.userId, String(req.params.id)); // ownership
    res.json({
      repository: await getProjectRepository(req.auth!.userId, String(req.params.id)),
    });
  } catch (error) {
    next(error);
  }
});

projectsRouter.put('/:id/repository', async (req: AuthedRequest, res, next) => {
  try {
    const schema = z.object({
      location: z.literal('server'),
      defaultBaseRef: z.string().trim().min(1).max(200).optional(),
      branchPrefix: z.string().trim().min(1).max(60).optional(),
      cleanupPolicy: z.enum(['manual', 'after_merge']).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid_input', 'Invalid repository binding');
    res.json({
      repository: await bindProjectRepository(req.auth!.userId, String(req.params.id), parsed.data),
    });
  } catch (error) {
    next(error);
  }
});

projectsRouter.post('/:id/repository/inspect', async (req: AuthedRequest, res, next) => {
  try {
    await getProject(req.auth!.userId, String(req.params.id)); // ownership
    res.json(await inspectProjectRepository(req.auth!.userId, String(req.params.id)));
  } catch (error) {
    next(error);
  }
});

projectsRouter.delete('/:id/repository', async (req: AuthedRequest, res, next) => {
  try {
    await unbindProjectRepository(req.auth!.userId, String(req.params.id));
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

const pathQuery = (req: AuthedRequest): string =>
  typeof req.query.path === 'string' ? req.query.path : '';

projectsRouter.get('/:id/files', async (req: AuthedRequest, res, next) => {
  try {
    res.json({
      tree: await buildFileTree(req.auth!.userId, String(req.params.id), pathQuery(req)),
    });
  } catch (error) {
    next(error);
  }
});

projectsRouter.get('/:id/files/content', async (req: AuthedRequest, res, next) => {
  try {
    res.json({
      file: await previewFile(req.auth!.userId, String(req.params.id), pathQuery(req)),
    });
  } catch (error) {
    next(error);
  }
});

projectsRouter.get('/:id/files/download', async (req: AuthedRequest, res, next) => {
  try {
    const { absolute, name } = await resolveDownload(
      req.auth!.userId,
      String(req.params.id),
      pathQuery(req)
    );
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"`);
    res.sendFile(absolute);
  } catch (error) {
    next(error);
  }
});

projectsRouter.get('/:id/files/archive', async (req: AuthedRequest, res, next) => {
  try {
    const archive = await archiveProject(req.auth!.userId, String(req.params.id));
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${archive.fileName}"; filename*=UTF-8''${encodeURIComponent(archive.fileName)}`
    );
    res.setHeader('X-File-Count', String(archive.fileCount));
    res.send(archive.buffer);
  } catch (error) {
    next(error);
  }
});

projectsRouter.patch('/:id/files', async (req: AuthedRequest, res, next) => {
  try {
    const schema = z.object({ path: z.string().min(1), newName: z.string().min(1).max(255) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid_input', 'path and newName are required');
    res.json({
      file: await renameFile(
        req.auth!.userId,
        String(req.params.id),
        parsed.data.path,
        parsed.data.newName
      ),
    });
  } catch (error) {
    next(error);
  }
});

projectsRouter.delete('/:id/files', async (req: AuthedRequest, res, next) => {
  try {
    const target = typeof req.body?.path === 'string' ? req.body.path : pathQuery(req);
    await deleteFile(req.auth!.userId, String(req.params.id), target);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});
