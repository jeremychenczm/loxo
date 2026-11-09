import fs from 'node:fs';
import path from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client';
import { agents, teamMembers, teams, type Team } from '../../db/schema';
import { badRequest, notFound } from '../../http/errors';
import { removeDir } from '../../storage/file-ops';
import { storage } from '../../storage/layout';
import {
  normalizeDsl,
  validateGraph,
  type ValidationIssue,
  type WorkflowDsl,
} from './workflow-dsl';

const MANIFEST_FILE = 'team.json';

export interface TeamView {
  id: string;
  name: string;
  description: string;
  workflow: WorkflowDsl;
  warnings: ValidationIssue[];
  createdAt: Date;
  updatedAt: Date;
}

function manifestPath(userId: string, teamId: string): string {
  return path.join(storage.teamDir(userId, teamId), MANIFEST_FILE);
}

function readManifest(userId: string, teamId: string): WorkflowDsl | null {
  const file = manifestPath(userId, teamId);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as WorkflowDsl;
  } catch {
    return null;
  }
}

async function ownedAgentIds(userId: string): Promise<Set<string>> {
  const rows = await db.select({ id: agents.id }).from(agents).where(eq(agents.userId, userId));
  return new Set(rows.map((r) => r.id));
}

async function toView(userId: string, team: Team): Promise<TeamView> {
  const known = await ownedAgentIds(userId);
  const workflow = normalizeDsl(readManifest(userId, team.id) ?? {}, known);
  workflow.name = team.name;
  workflow.description = team.description;
  const { warnings } = validateGraph(workflow.nodes, workflow.edges);
  return {
    id: team.id,
    name: team.name,
    description: team.description,
    workflow,
    warnings,
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
  };
}

async function syncMembers(teamId: string, workflow: WorkflowDsl): Promise<void> {
  await db.delete(teamMembers).where(eq(teamMembers.teamId, teamId));
  const rows = workflow.nodes
    .filter((n): n is Extract<typeof n, { type: 'agent' }> => n.type === 'agent' && !!n.agentId)
    .map((n) => ({ teamId, agentId: n.agentId!, nodeId: n.id }));
  if (rows.length > 0) {
    await db.insert(teamMembers).values(rows);
  }
}

export async function listTeams(userId: string): Promise<TeamView[]> {
  const rows = await db.select().from(teams).where(eq(teams.userId, userId)).orderBy(teams.updatedAt);
  return Promise.all(rows.map((row) => toView(userId, row)));
}

export async function getTeam(userId: string, teamId: string): Promise<TeamView> {
  const [team] = await db
    .select()
    .from(teams)
    .where(and(eq(teams.id, teamId), eq(teams.userId, userId)))
    .limit(1);
  if (!team) throw notFound('Team not found');
  return toView(userId, team);
}

export async function createTeam(
  userId: string,
  input: { name: string; description?: string; workflow?: unknown }
): Promise<TeamView> {
  const [team] = await db
    .insert(teams)
    .values({ userId, name: input.name, description: input.description ?? '' })
    .returning();
  return saveWorkflow(userId, team!.id, input.workflow ?? {}, { skipErrorCheck: true });
}

export interface SaveOptions {
  /** Drafts may be saved with structural errors; execution re-validates. */
  skipErrorCheck?: boolean;
}

export async function saveWorkflow(
  userId: string,
  teamId: string,
  rawWorkflow: unknown,
  options: SaveOptions = {}
): Promise<TeamView> {
  const [team] = await db
    .select()
    .from(teams)
    .where(and(eq(teams.id, teamId), eq(teams.userId, userId)))
    .limit(1);
  if (!team) throw notFound('Team not found');

  const known = await ownedAgentIds(userId);
  const workflow = normalizeDsl(rawWorkflow, known);
  const { errors } = validateGraph(workflow.nodes, workflow.edges);
  if (errors.length > 0 && !options.skipErrorCheck) {
    throw badRequest('invalid_workflow', errors[0]!.message);
  }

  fs.writeFileSync(manifestPath(userId, teamId), JSON.stringify(workflow, null, 2), 'utf8');
  await syncMembers(teamId, workflow);
  const [updated] = await db
    .update(teams)
    .set({ updatedAt: new Date() })
    .where(eq(teams.id, teamId))
    .returning();
  return toView(userId, updated!);
}

export async function updateTeamMeta(
  userId: string,
  teamId: string,
  input: { name?: string; description?: string }
): Promise<TeamView> {
  const [updated] = await db
    .update(teams)
    .set({ ...input, updatedAt: new Date() })
    .where(and(eq(teams.id, teamId), eq(teams.userId, userId)))
    .returning();
  if (!updated) throw notFound('Team not found');
  return toView(userId, updated);
}

export async function deleteTeam(userId: string, teamId: string): Promise<void> {
  const deleted = await db
    .delete(teams)
    .where(and(eq(teams.id, teamId), eq(teams.userId, userId)))
    .returning({ id: teams.id });
  if (deleted.length === 0) throw notFound('Team not found');

  removeDir(storage.teamDir(userId, teamId));
}

/**
 * Detaches a deleted agent from every team manifest that references it.
 * Member rows disappear via FK cascade; manifests are files and need this.
 */
export async function unlinkAgentFromTeams(userId: string, agentId: string): Promise<void> {
  const memberRows = await db
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(eq(teamMembers.agentId, agentId));
  const teamIds = [...new Set(memberRows.map((r) => r.teamId))];
  if (teamIds.length === 0) return;

  const ownedTeams = await db
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.userId, userId), inArray(teams.id, teamIds)));

  for (const team of ownedTeams) {
    const manifest = readManifest(userId, team.id);
    if (!manifest) continue;
    let changed = false;
    for (const node of manifest.nodes) {
      if (node.type === 'agent' && node.agentId === agentId) {
        node.agentId = undefined;
        changed = true;
      }
    }
    if (changed) {
      fs.writeFileSync(manifestPath(userId, team.id), JSON.stringify(manifest, null, 2), 'utf8');
    }
  }
}
