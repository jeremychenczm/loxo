import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { agents, providers, type Agent, type AgentManifest } from '../../db/schema';
import { badRequest, notFound } from '../../http/errors';
import { copyDir, removeDir } from '../../storage/file-ops';
import { storage } from '../../storage/layout';
import type { AgentRuntime } from './runtime-detect';

/** Provider vendors accepted by each runtime. */
export const VENDORS_FOR_RUNTIME: Record<AgentRuntime, string[]> = {
  'claude-code': ['anthropic'],
  codex: ['openai'],
  opencode: ['openai'],
  hermes: ['hermes'],
  openclaw: ['openclaw'],
  api: ['anthropic', 'openai'],
};

export interface CreateAgentInput {
  name: string;
  runtime: AgentRuntime;
  description?: string;
  tags?: string[];
  manifest?: AgentManifest;
}

export async function createAgent(userId: string, input: CreateAgentInput): Promise<Agent> {
  const [agent] = await db
    .insert(agents)
    .values({
      userId,
      name: input.name,
      description: input.description ?? '',
      runtime: input.runtime,
      execution: input.runtime === 'api' ? 'api' : 'server',
      tags: input.tags ?? [],
      manifest: input.manifest ?? {},
    })
    .returning();
  storage.agentPaths(userId, agent!.id);
  return agent!;
}

export async function listAgents(userId: string): Promise<Agent[]> {
  return db.select().from(agents).where(eq(agents.userId, userId)).orderBy(agents.createdAt);
}

export async function getAgent(userId: string, agentId: string): Promise<Agent> {
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
    .limit(1);
  if (!agent) throw notFound('Agent not found');
  return agent;
}

export interface UpdateAgentInput {
  name?: string;
  description?: string;
  tags?: string[];
  avatarFile?: string;
}

export async function updateAgent(
  userId: string,
  agentId: string,
  input: UpdateAgentInput
): Promise<Agent> {
  await getAgent(userId, agentId);

  const [updated] = await db
    .update(agents)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(agents.id, agentId))
    .returning();
  return updated!;
}

export interface AgentConfigInput {
  providerId?: string | null;
  model?: string | null;
  execution?: 'server' | 'api';
}

/** API agents always execute via provider API; CLI agents never do. */
function resolveExecution(agent: Agent, input: AgentConfigInput): string {
  const execution = input.execution ?? agent.execution;
  if ((agent.runtime === 'api') !== (execution === 'api')) {
    throw badRequest(
      'execution_mismatch',
      agent.runtime === 'api'
        ? 'API agents always execute via provider API'
        : `Runtime ${agent.runtime} cannot use api execution`
    );
  }
  return execution;
}

/**
 * Validates provider vendor against the agent runtime and the model against
 * the provider's model list before persisting. Credential or model changes
 * invalidate stored CLI session refs so the next turn starts fresh.
 */
export async function updateAgentConfig(
  userId: string,
  agentId: string,
  input: AgentConfigInput
): Promise<Agent> {
  const agent = await getAgent(userId, agentId);
  const providerId = input.providerId === undefined ? agent.providerId : input.providerId;
  const model = input.model === undefined ? agent.model : input.model;

  if (providerId) {
    const [provider] = await db
      .select({ vendor: providers.vendor, models: providers.models })
      .from(providers)
      .where(and(eq(providers.id, providerId), eq(providers.userId, userId)))
      .limit(1);
    if (!provider) throw notFound('Provider not found');

    const allowed = VENDORS_FOR_RUNTIME[agent.runtime as AgentRuntime] ?? [];
    if (!allowed.includes(provider.vendor)) {
      throw badRequest(
        'vendor_mismatch',
        `Runtime ${agent.runtime} requires a ${allowed.join(' or ')} provider, got ${provider.vendor}`
      );
    }
    if (model && provider.models.length > 0 && !provider.models.includes(model)) {
      throw badRequest('unknown_model', `Model ${model} is not configured on this provider`);
    }
  }

  const execution = resolveExecution(agent, input);

  const [updated] = await db
    .update(agents)
    .set({ providerId, model, execution, updatedAt: new Date() })
    .where(eq(agents.id, agentId))
    .returning();

  if (providerId !== agent.providerId || model !== agent.model || execution !== agent.execution) {
    const { clearRunnerSessionsForAgent } = await import('../chat/conversations.service');
    await clearRunnerSessionsForAgent(agentId);
  }
  return updated!;
}

export async function deleteAgent(userId: string, agentId: string): Promise<void> {
  const deleted = await db
    .delete(agents)
    .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
    .returning({ id: agents.id });
  if (deleted.length === 0) throw notFound('Agent not found');

  removeDir(storage.agentPaths(userId, agentId).root);
}

/** Re-seeds the baseline snapshot from the current workspace contents. */
export function captureBaseline(userId: string, agentId: string): void {
  const paths = storage.agentPaths(userId, agentId);
  removeDir(paths.baseline);
  copyDir(paths.workspace, paths.baseline);
}
