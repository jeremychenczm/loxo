import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db/client';
import {
  agentGroups,
  agents,
  machines,
  providers,
  slackIntegrations,
  type Agent,
  type AgentGroup,
  type AgentManifest,
} from '../../db/schema';
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

export type GroupFilter = { groupId?: string; ungrouped?: boolean };

export async function listAgents(userId: string, filter: GroupFilter = {}): Promise<Agent[]> {
  const conditions = [eq(agents.userId, userId)];
  if (filter.ungrouped) {
    conditions.push(isNull(agents.groupId));
  } else if (filter.groupId) {
    conditions.push(eq(agents.groupId, filter.groupId));
  }
  return db.select().from(agents).where(and(...conditions)).orderBy(agents.createdAt);
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
  groupId?: string | null;
  avatarFile?: string;
}

export async function updateAgent(
  userId: string,
  agentId: string,
  input: UpdateAgentInput
): Promise<Agent> {
  await getAgent(userId, agentId);

  if (input.groupId) {
    const [group] = await db
      .select({ id: agentGroups.id })
      .from(agentGroups)
      .where(and(eq(agentGroups.id, input.groupId), eq(agentGroups.userId, userId)))
      .limit(1);
    if (!group) throw notFound('Group not found');
  }

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
  execution?: 'server' | 'api' | 'machine';
  machineId?: string | null;
  machineWorkdir?: string | null;
}

/** Machine binding rules; returns the resolved binding columns. */
async function resolveMachineBinding(
  userId: string,
  agent: Agent,
  input: AgentConfigInput
): Promise<{ execution: string; machineId: string | null; machineWorkdir: string | null }> {
  const execution = input.execution ?? agent.execution;
  const machineId = input.machineId === undefined ? agent.machineId : input.machineId;
  const machineWorkdir =
    input.machineWorkdir === undefined ? agent.machineWorkdir : input.machineWorkdir;

  if ((agent.runtime === 'api') !== (execution === 'api')) {
    throw badRequest(
      'execution_mismatch',
      agent.runtime === 'api'
        ? 'API agents always execute via provider API'
        : `Runtime ${agent.runtime} cannot use api execution`
    );
  }

  if (execution !== 'machine') {
    return { execution, machineId: null, machineWorkdir: null };
  }

  if (!machineId) {
    throw badRequest('machine_required', 'Machine execution requires a paired machine');
  }
  const [machine] = await db
    .select()
    .from(machines)
    .where(and(eq(machines.id, machineId), eq(machines.userId, userId), isNull(machines.revokedAt)))
    .limit(1);
  if (!machine) throw notFound('Machine not found');

  const probe = machine.runtimes.find((r) => r.runtime === agent.runtime);
  if (machine.runtimes.length > 0 && probe && !probe.available) {
    throw badRequest(
      'runtime_unavailable',
      `Runtime ${agent.runtime} is not available on ${machine.name}`
    );
  }
  return { execution, machineId, machineWorkdir };
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

  const binding = await resolveMachineBinding(userId, agent, input);

  const [updated] = await db
    .update(agents)
    .set({ providerId, model, ...binding, updatedAt: new Date() })
    .where(eq(agents.id, agentId))
    .returning();

  // Execution location changes also invalidate CLI sessions: the session
  // state lives on whichever host ran the previous turns.
  if (
    providerId !== agent.providerId ||
    model !== agent.model ||
    binding.execution !== agent.execution ||
    binding.machineId !== agent.machineId
  ) {
    const { clearRunnerSessionsForAgent } = await import('../chat/conversations.service');
    await clearRunnerSessionsForAgent(agentId);
  }
  return updated!;
}

export async function deleteAgent(userId: string, agentId: string): Promise<void> {
  // Manifest unlink must run before the row delete cascades member rows away.
  const { unlinkAgentFromTeams } = await import('../teams/teams.service');
  await unlinkAgentFromTeams(userId, agentId);

  const deleted = await db
    .delete(agents)
    .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
    .returning({ id: agents.id });
  if (deleted.length === 0) throw notFound('Agent not found');

  // subjectId is polymorphic (no FK), so Slack bindings need explicit cleanup.
  await db
    .delete(slackIntegrations)
    .where(and(eq(slackIntegrations.scope, 'agent'), eq(slackIntegrations.subjectId, agentId)));
  removeDir(storage.agentPaths(userId, agentId).root);
}

/** Re-seeds the baseline snapshot from the current workspace contents. */
export function captureBaseline(userId: string, agentId: string): void {
  const paths = storage.agentPaths(userId, agentId);
  removeDir(paths.baseline);
  copyDir(paths.workspace, paths.baseline);
}

// Groups

export async function listGroups(userId: string): Promise<AgentGroup[]> {
  return db
    .select()
    .from(agentGroups)
    .where(eq(agentGroups.userId, userId))
    .orderBy(agentGroups.sortOrder, agentGroups.createdAt);
}

export async function createGroup(
  userId: string,
  input: { name: string; color?: string }
): Promise<AgentGroup> {
  const existing = await listGroups(userId);
  const sortOrder = existing.length > 0 ? Math.max(...existing.map((g) => g.sortOrder)) + 1 : 0;
  const [group] = await db
    .insert(agentGroups)
    .values({ userId, name: input.name, color: input.color ?? '#38bdf8', sortOrder })
    .returning();
  return group!;
}

export async function updateGroup(
  userId: string,
  groupId: string,
  input: { name?: string; color?: string; sortOrder?: number }
): Promise<AgentGroup> {
  const [updated] = await db
    .update(agentGroups)
    .set({ ...input, updatedAt: new Date() })
    .where(and(eq(agentGroups.id, groupId), eq(agentGroups.userId, userId)))
    .returning();
  if (!updated) throw notFound('Group not found');
  return updated;
}

/** Member agents are detached (group_id set null by FK), never deleted. */
export async function deleteGroup(userId: string, groupId: string): Promise<void> {
  const deleted = await db
    .delete(agentGroups)
    .where(and(eq(agentGroups.id, groupId), eq(agentGroups.userId, userId)))
    .returning({ id: agentGroups.id });
  if (deleted.length === 0) throw notFound('Group not found');
}
