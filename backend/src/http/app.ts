import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { config } from '../config';
import { agentsRouter, groupsRouter } from '../modules/agents/agents.routes';
import { apiPresetsRouter } from '../modules/agents/api-presets.routes';
import { authRouter } from '../modules/auth/auth.routes';
import { conversationsRouter } from '../modules/chat/conversations.routes';
import { machinesRouter } from '../modules/machines/machines.routes';
import { issuesRouter } from '../modules/issues/issues.routes';
import { projectsRouter } from '../modules/projects/projects.routes';
import { runsRouter } from '../modules/runs/runs.routes';
import { handleMcpRequest } from '../modules/runs/mcp-server';
import { providersRouter } from '../modules/providers/providers.routes';
import { HttpError } from './errors';

export function createApp(): express.Express {
  const app = express();

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || config.corsOrigins.includes(origin) || config.corsOrigins.includes('*')) {
          callback(null, true);
          return;
        }
        callback(new HttpError(403, 'cors_rejected', `Origin not allowed: ${origin}`));
      },
      credentials: true,
    })
  );
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.use('/auth', authRouter);
  app.use('/api/providers', providersRouter);
  app.use('/api/agents', agentsRouter);
  app.use('/api/agent-groups', groupsRouter);
  app.use('/api/agent-presets', apiPresetsRouter);
  app.use('/api/conversations', conversationsRouter);
  app.use('/api/projects', projectsRouter);
  app.use('/api/issues', issuesRouter);
  app.use('/api/runs', runsRouter);

  // Agent control plane; authenticated by per-run tokens, not user JWTs.
  app
    .route('/mcp')
    .post((req, res, next) => {
      handleMcpRequest(req, res).catch(next);
    })
    .all((_req, res) => {
      res.status(405).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed' },
        id: null,
      });
    });
  app.use('/api/machines', machinesRouter);

  app.use((_req, res) => {
    res.status(404).json({ code: 'not_found', message: 'Route not found' });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ code: err.code, message: err.message });
      return;
    }
    console.error('Unhandled error:', err);
    res.status(500).json({ code: 'internal_error', message: 'Internal server error' });
  });

  return app;
}
