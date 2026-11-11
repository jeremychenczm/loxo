import type { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { HttpError } from '../../http/errors';
import {
  askBlocker,
  commentOnTask,
  getTaskSnapshot,
  resolveRunContext,
  submitResult,
  submitReviewVerdict,
  updateTaskStatus,
  type RunToolContext,
} from './control-plane';

const TASK_STATUS = z.enum([
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'blocked',
  'done',
  'cancelled',
]);

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function text(payload: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }],
  };
}

/** Domain rejections (illegal transition, bad input) surface as tool errors, not protocol errors. */
async function guarded(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof HttpError) {
      return { isError: true, content: [{ type: 'text', text: `${error.code}: ${error.message}` }] };
    }
    throw error;
  }
}

function buildControlPlaneServer(ctx: RunToolContext): McpServer {
  const server = new McpServer({ name: 'swarmdev-control-plane', version: '1.0.0' });

  server.registerTool(
    'get_task',
    {
      description: 'Read the task this run was woken for: title, brief, status, and timeline.',
      inputSchema: {},
    },
    async () => guarded(async () => text(await getTaskSnapshot(ctx)))
  );

  server.registerTool(
    'comment_on_task',
    {
      description: 'Post a progress note to the task timeline as yourself.',
      inputSchema: { body: z.string().min(1).max(20000) },
    },
    async ({ body }) =>
      guarded(async () => {
        await commentOnTask(ctx, body);
        return text('Comment posted');
      })
  );

  if (ctx.run.trigger === 'review') {
    server.registerTool(
      'submit_review',
      {
        description:
          'Deliver your review verdict. approved records a recommendation (a human closes the task); changes_requested reopens work with your feedback.',
        inputSchema: {
          decision: z.enum(['approved', 'changes_requested']),
          feedback: z.string().min(1).max(20000),
        },
      },
      async ({ decision, feedback }) =>
        guarded(async () => text(await submitReviewVerdict(ctx, decision, feedback)))
    );
    return server;
  }

  server.registerTool(
    'update_task_status',
    {
      description:
        'Move the task to a new status. Transitions follow the board rules; illegal moves are rejected.',
      inputSchema: { status: TASK_STATUS },
    },
    async ({ status }) =>
      guarded(async () => {
        const task = await updateTaskStatus(ctx, status);
        return text({ status: task.status });
      })
  );

  server.registerTool(
    'ask_blocker',
    {
      description:
        'You are stuck and need a human decision. Posts the question to the timeline and marks the task blocked.',
      inputSchema: { question: z.string().min(1).max(4000) },
    },
    async ({ question }) =>
      guarded(async () => {
        const task = await askBlocker(ctx, question);
        return text({ status: task.status });
      })
  );

  server.registerTool(
    'submit_result',
    {
      description:
        'You finished the work. Posts your result summary to the timeline and hands the task to review.',
      inputSchema: { summary: z.string().min(1).max(20000) },
    },
    async ({ summary }) =>
      guarded(async () => {
        const task = await submitResult(ctx, summary);
        return text({ status: task.status });
      })
  );

  return server;
}

/**
 * Stateless MCP endpoint: every POST authenticates the per-run token and gets
 * a fresh server bound to that run's scope, so token revocation (run settled)
 * takes effect on the next call.
 */
export async function handleMcpRequest(req: Request, res: Response): Promise<void> {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';

  let ctx: RunToolContext;
  try {
    ctx = await resolveRunContext(token);
  } catch (error) {
    const message = error instanceof HttpError ? error.message : 'Unauthorized';
    res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message }, id: null });
    return;
  }

  const server = buildControlPlaneServer(ctx);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
