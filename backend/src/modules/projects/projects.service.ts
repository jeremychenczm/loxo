import fs from 'node:fs';
import path from 'node:path';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import {
  agents,
  projectAgents,
  projects,
  type Project,
} from '../../db/schema';
import { badRequest, conflict, notFound } from '../../http/errors';
import { hasActiveWorkspaces } from '../code-workspaces/workspace.service';
import { removeDir } from '../../storage/file-ops';
import { storage } from '../../storage/layout';

const METADATA_FILE = '.swarmdev-project.json';

export interface ProjectView extends Project {
  agentIds: string[];
}

/** Root that holds workspace/ plus run data; removed wholesale on delete. */
export function projectRoot(userId: string, projectId: string): string {
  return path.dirname(storage.projectWorkspace(userId, projectId));
}

function writeMetadata(userId: string, project: Project): void {
  const workspace = storage.projectWorkspace(userId, project.id);
  const meta = {
    projectId: project.id,
    name: project.name,
    description: project.description,
    createdAt: project.createdAt.toISOString(),
  };
  fs.writeFileSync(path.join(workspace, METADATA_FILE), JSON.stringify(meta, null, 2), 'utf8');
}

async function loadBindings(
  projectIds: string[]
): Promise<Map<string, { agentIds: string[] }>> {
  const bindings = new Map<string, { agentIds: string[] }>();
  for (const id of projectIds) bindings.set(id, { agentIds: [] });
  if (projectIds.length === 0) return bindings;

  const agentRows = await db
    .select()
    .from(projectAgents)
    .where(inArray(projectAgents.projectId, projectIds));
  for (const row of agentRows) bindings.get(row.projectId)?.agentIds.push(row.agentId);
  return bindings;
}

async function toView(project: Project): Promise<ProjectView> {
  const bindings = await loadBindings([project.id]);
  return { ...project, ...bindings.get(project.id)! };
}

/** Replaces bindings; every referenced agent must belong to the owner. */
async function syncBindings(
  userId: string,
  projectId: string,
  input: { agentIds?: string[] }
): Promise<void> {
  if (input.agentIds) {
    const agentIds = [...new Set(input.agentIds)];
    if (agentIds.length > 0) {
      const owned = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.userId, userId), inArray(agents.id, agentIds)));
      if (owned.length !== agentIds.length) {
        throw badRequest('invalid_binding', 'One or more agents do not exist');
      }
    }
    await db.delete(projectAgents).where(eq(projectAgents.projectId, projectId));
    if (agentIds.length > 0) {
      await db.insert(projectAgents).values(agentIds.map((agentId) => ({ projectId, agentId })));
    }
  }
}

export async function createProject(
  userId: string,
  input: { name: string; description?: string; agentIds?: string[] }
): Promise<ProjectView> {
  const [project] = await db
    .insert(projects)
    .values({ userId, name: input.name, description: input.description ?? '' })
    .returning();
  await syncBindings(userId, project!.id, input);
  writeMetadata(userId, project!);
  return toView(project!);
}

export async function listProjects(userId: string): Promise<ProjectView[]> {
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.userId, userId))
    .orderBy(desc(projects.updatedAt));
  const bindings = await loadBindings(rows.map((r) => r.id));
  return rows.map((row) => ({ ...row, ...bindings.get(row.id)! }));
}

export async function getProject(userId: string, projectId: string): Promise<ProjectView> {
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  if (!project) throw notFound('Project not found');
  return toView(project);
}

/**
 * Recency bump for "last worked on" ordering. The new timestamp lands at
 * least one second past the user's current maximum so re-opened projects
 * sort strictly first even within the same clock tick.
 */
export async function touchProject(userId: string, projectId: string): Promise<ProjectView> {
  const [row] = await db
    .select({ max: sql<string | null>`max(${projects.updatedAt})` })
    .from(projects)
    .where(eq(projects.userId, userId));
  const currentMax = row?.max ? new Date(row.max).getTime() : 0;
  const next = new Date(Math.max(Date.now(), currentMax + 1000));

  const [updated] = await db
    .update(projects)
    .set({ updatedAt: next })
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .returning();
  if (!updated) throw notFound('Project not found');
  return toView(updated);
}

export async function updateProject(
  userId: string,
  projectId: string,
  input: { name?: string; description?: string; agentIds?: string[] }
): Promise<ProjectView> {
  const [project] = await db
    .update(projects)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .returning();
  if (!project) throw notFound('Project not found');

  await syncBindings(userId, projectId, input);
  writeMetadata(userId, project);
  return toView(project);
}

export async function deleteProject(userId: string, projectId: string): Promise<void> {
  const [target] = await db
    .select({ kind: projects.kind })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  if (!target) throw notFound('Project not found');
  if (target.kind === 'default') {
    throw badRequest('default_project_protected', 'The default project cannot be deleted');
  }
  if (await hasActiveWorkspaces({ projectId })) {
    throw conflict(
      'workspace_active',
      'Merge, keep, or abandon the active code workspaces before deleting this project'
    );
  }

  await db
    .delete(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
  removeDir(projectRoot(userId, projectId));
}

const DEFAULT_PROJECT_NAME = 'Default Project';

/**
 * Returns the user's built-in default project, creating it on first use.
 * Concurrent first calls are settled by the projects_user_default partial
 * unique index: losers no-op on conflict and re-read the winner's row.
 */
export async function getOrCreateDefaultProject(userId: string): Promise<Project> {
  const [existing] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.userId, userId), eq(projects.kind, 'default')))
    .limit(1);
  if (existing) return existing;

  const [inserted] = await db
    .insert(projects)
    .values({
      userId,
      name: DEFAULT_PROJECT_NAME,
      description: 'Fallback project for issues created without one',
      kind: 'default',
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) {
    writeMetadata(userId, inserted);
    return inserted;
  }

  const [winner] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.userId, userId), eq(projects.kind, 'default')))
    .limit(1);
  return winner!;
}
