import type { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { agents, tasks, turns, workspaces } from '../../db/schema';
import { HttpError, unauthorized } from '../../http/errors';
import { TASK_TOOLS, toolsForPhase, type TaskToolContext } from './task-tools';
import { parseTurnToken, signatureMatches } from './turn-token';

/**
 * Resolves a turn token to its scope. Any mismatch — unknown turn, finished
 * turn, wrong signature for the stored task and agent — is unauthorized.
 */
export async function resolveTurnContext(token: string): Promise<TaskToolContext> {
  const parsed = parseTurnToken(token);
  if (!parsed) throw unauthorized('Invalid turn token');
  const [turn] = await db.select().from(turns).where(eq(turns.id, parsed.turnId)).limit(1);
  if (!turn || !turn.agentId) throw unauthorized('Invalid turn token');
  if (!signatureMatches({ turnId: turn.id, taskId: turn.taskId, agentId: turn.agentId }, parsed.signature)) {
    throw unauthorized('Invalid turn token');
  }
  if (turn.status !== 'running') throw unauthorized('Turn is not running');
  const [task] = await db.select().from(tasks).where(eq(tasks.id, turn.taskId)).limit(1);
  const [agent] = task
    ? await db
        .select()
        .from(agents)
        .where(and(eq(agents.id, turn.agentId), eq(agents.userId, task.userId)))
        .limit(1)
    : [];
  if (!task || !agent) throw unauthorized('Turn scope no longer exists');
  const [workspace] = turn.workspaceId
    ? await db.select().from(workspaces).where(eq(workspaces.id, turn.workspaceId)).limit(1)
    : [];
  return { turn, task, agent, workspace: workspace ?? null };
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function asText(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }] };
}

function buildServer(token: string, phase: string | null): McpServer {
  const server = new McpServer({ name: 'loxo-task', version: '1.0.0' });
  for (const name of toolsForPhase(phase)) {
    const tool = TASK_TOOLS[name];
    server.registerTool(
      name,
      { description: tool.description, inputSchema: tool.input },
      async (args: Record<string, unknown>): Promise<ToolResult> => {
        try {
          // Re-resolve per call: a turn that ended mid-session loses its tools at once.
          const ctx = await resolveTurnContext(token);
          return asText(await tool.run(ctx, args ?? {}));
        } catch (error) {
          if (error instanceof HttpError) {
            return { isError: true, content: [{ type: 'text', text: `${error.code}: ${error.message}` }] };
          }
          throw error;
        }
      }
    );
  }
  return server;
}

/** Stateless task-level MCP endpoint, authenticated per request by a turn token. */
export async function handleTaskMcpRequest(req: Request, res: Response): Promise<void> {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  let ctx: TaskToolContext;
  try {
    ctx = await resolveTurnContext(token);
  } catch (error) {
    const message = error instanceof HttpError ? error.message : 'Unauthorized';
    res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message }, id: null });
    return;
  }
  const server = buildServer(token, ctx.turn.phase);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
