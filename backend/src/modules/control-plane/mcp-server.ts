import type { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { HttpError } from '../../http/errors';
import { explorationShape, planReviewShape, planShape } from '../workshop/reports';
import { describeTool, toolsForRun } from './names';
import {
  askBlocker,
  commentOnTask,
  getTaskSnapshot,
  resolveRunContext,
  submitDispatchReport,
  submitResult,
  submitReviewVerdict,
  updateTaskStatus,
  type RunToolContext,
} from './tools';

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

/** Registers exactly the tools toolsForRun offers the run, in that order. */
function buildControlPlaneServer(ctx: RunToolContext): McpServer {
  const server = new McpServer({ name: 'swarmdev-control-plane', version: '1.0.0' });
  const workshop = ctx.run.dispatchId !== null;

  for (const tool of toolsForRun(ctx.run, ctx.phase ?? null)) {
    const description = describeTool(tool, workshop);
    switch (tool) {
      case 'get_task':
        server.registerTool(tool, { description, inputSchema: {} }, async () =>
          guarded(async () => text(await getTaskSnapshot(ctx)))
        );
        break;
      case 'comment_on_task':
        server.registerTool(tool, { description, inputSchema: { body: z.string().min(1).max(20000) } }, async ({ body }) =>
          guarded(async () => {
            await commentOnTask(ctx, body);
            return text('Comment posted');
          })
        );
        break;
      case 'submit_review':
        server.registerTool(
          tool,
          {
            description,
            inputSchema: {
              decision: z.enum(['approved', 'changes_requested']),
              feedback: z.string().min(1).max(20000),
            },
          },
          async ({ decision, feedback }) => guarded(async () => text(await submitReviewVerdict(ctx, decision, feedback)))
        );
        break;
      case 'update_task_status':
        server.registerTool(tool, { description, inputSchema: { status: TASK_STATUS } }, async ({ status }) =>
          guarded(async () => {
            const task = await updateTaskStatus(ctx, status);
            return text({ status: task.status });
          })
        );
        break;
      case 'ask_blocker':
        server.registerTool(tool, { description, inputSchema: { question: z.string().min(1).max(4000) } }, async ({ question }) =>
          guarded(async () => {
            const task = await askBlocker(ctx, question);
            return text({ status: task.status });
          })
        );
        break;
      case 'submit_result':
        server.registerTool(tool, { description, inputSchema: { summary: z.string().min(1).max(20000) } }, async ({ summary }) =>
          guarded(async () => {
            const task = await submitResult(ctx, summary);
            return text({ status: task.status });
          })
        );
        break;
      case 'submit_exploration':
        server.registerTool(tool, { description, inputSchema: explorationShape }, async (args) =>
          guarded(async () => text(await submitDispatchReport(ctx, tool, args)))
        );
        break;
      case 'submit_plan':
        server.registerTool(tool, { description, inputSchema: planShape }, async (args) =>
          guarded(async () => text(await submitDispatchReport(ctx, tool, args)))
        );
        break;
      case 'submit_plan_review':
        server.registerTool(tool, { description, inputSchema: planReviewShape }, async (args) =>
          guarded(async () => text(await submitDispatchReport(ctx, tool, args)))
        );
        break;
    }
  }
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
