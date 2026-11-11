import path from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import { config } from '../../config';
import { db } from '../../db/client';
import { repositories, type Repository, type RepositoryCheck } from '../../db/schema';
import { badRequest, conflict, notFound } from '../../http/errors';
import { storage } from '../../storage/layout';
import { localGitDriver } from '../code-workspaces/local-git-driver';
import {
  findRepository,
  hasActiveWorkspaces,
  rethrowGitError,
} from '../code-workspaces/workspace.service';
import { GitDriverError } from '../code-workspaces/workspace.types';

export interface CreateRepositoryInput {
  rootPath: string;
  name?: string;
  defaultBranch?: string;
  setupCommand?: string | null;
  checks?: RepositoryCheck[];
}

export interface UpdateRepositoryInput {
  name?: string;
  defaultBranch?: string;
  setupCommand?: string | null;
  checks?: RepositoryCheck[];
}

/** Comparable host path: resolved, forward slashes, case-folded on Windows. */
function comparablePath(input: string): string {
  const resolved = path.resolve(input).replace(/\\/g, '/');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInside(child: string, parent: string): boolean {
  const c = comparablePath(child);
  const p = comparablePath(parent).replace(/\/$/, '');
  return c === p || c.startsWith(`${p}/`);
}

/**
 * Host-path policy: absolute, outside platform storage (worktrees and agent
 * workspaces live there), and under a configured root when roots are set.
 */
function assertAllowedRoot(rootPath: string): void {
  if (!path.isAbsolute(rootPath)) {
    throw badRequest('invalid_path', 'Repository path must be absolute');
  }
  if (isInside(rootPath, storage.root)) {
    throw badRequest('invalid_path', 'Repository path is inside Loxo storage');
  }
  const roots = config.repositoryRoots();
  if (roots.length > 0 && !roots.some((root) => isInside(rootPath, root))) {
    throw badRequest('path_not_allowed', 'Repository path is outside the allowed directories');
  }
}

function normalizeSetupCommand(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = value?.trim() ?? '';
  return trimmed ? trimmed : null;
}

function assertUniqueCheckNames(checks: RepositoryCheck[] | undefined): void {
  if (!checks) return;
  const names = new Set(checks.map((c) => c.name));
  if (names.size !== checks.length) {
    throw badRequest('invalid_checks', 'Check names must be unique');
  }
}

export async function listRepositories(userId: string): Promise<Repository[]> {
  return db
    .select()
    .from(repositories)
    .where(eq(repositories.userId, userId))
    .orderBy(asc(repositories.createdAt));
}

export async function getRepository(userId: string, repositoryId: string): Promise<Repository> {
  const repository = await findRepository(userId, repositoryId);
  if (!repository) throw notFound('Repository not found');
  return repository;
}

/**
 * Registers an existing repository by its primary checkout root. The path is
 * inspected, never modified: it must be the repository top level and the
 * default branch must exist locally.
 */
export async function createRepository(
  userId: string,
  input: CreateRepositoryInput
): Promise<Repository> {
  assertAllowedRoot(input.rootPath);
  assertUniqueCheckNames(input.checks);
  const defaultBranch = input.defaultBranch?.trim() || 'main';
  const info = await localGitDriver
    .inspectRepository({ rootPath: input.rootPath, baseRef: defaultBranch })
    .catch(rethrowGitError);

  const existing = await listRepositories(userId);
  if (existing.some((r) => comparablePath(r.rootPath) === comparablePath(info.root))) {
    throw conflict('repository_exists', 'This repository is already registered');
  }

  const [created] = await db
    .insert(repositories)
    .values({
      userId,
      name: input.name?.trim() || path.basename(info.root),
      rootPath: info.root,
      defaultBranch,
      setupCommand: normalizeSetupCommand(input.setupCommand) ?? null,
      checks: input.checks ?? [],
      fingerprint: info.fingerprint,
    })
    .returning();
  return created!;
}

/** The root path is immutable; register the other path as a new repository instead. */
export async function updateRepository(
  userId: string,
  repositoryId: string,
  input: UpdateRepositoryInput
): Promise<Repository> {
  const repository = await getRepository(userId, repositoryId);
  assertUniqueCheckNames(input.checks);

  const patch: Partial<typeof repositories.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) patch.name = input.name.trim() || repository.name;
  if (input.checks !== undefined) patch.checks = input.checks;
  const setupCommand = normalizeSetupCommand(input.setupCommand);
  if (setupCommand !== undefined) patch.setupCommand = setupCommand;

  const defaultBranch = input.defaultBranch?.trim();
  if (defaultBranch && defaultBranch !== repository.defaultBranch) {
    const info = await localGitDriver
      .inspectRepository({ rootPath: repository.rootPath, baseRef: defaultBranch })
      .catch(rethrowGitError);
    patch.defaultBranch = defaultBranch;
    patch.fingerprint = info.fingerprint;
  }

  const [updated] = await db
    .update(repositories)
    .set(patch)
    .where(eq(repositories.id, repository.id))
    .returning();
  return updated!;
}

export interface RepositoryInspection {
  valid: boolean;
  error?: string;
  root?: string;
  defaultBranch?: string;
  baseCommit?: string;
  currentBranch?: string | null;
  dirty?: boolean;
  /** False when the path now holds a different repository than the one registered. */
  sameRepository?: boolean;
}

export async function inspectRepository(
  userId: string,
  repositoryId: string
): Promise<RepositoryInspection> {
  const repository = await getRepository(userId, repositoryId);
  try {
    const info = await localGitDriver.inspectRepository({
      rootPath: repository.rootPath,
      baseRef: repository.defaultBranch,
    });
    return {
      valid: true,
      root: info.root,
      defaultBranch: info.baseRef,
      baseCommit: info.baseCommit,
      currentBranch: info.currentBranch,
      dirty: info.dirty,
      sameRepository: info.fingerprint === repository.fingerprint,
    };
  } catch (err) {
    if (err instanceof GitDriverError) return { valid: false, error: err.message };
    throw err;
  }
}

/** Removal forgets the registration only; the repository on disk is untouched. */
export async function deleteRepository(userId: string, repositoryId: string): Promise<void> {
  const repository = await getRepository(userId, repositoryId);
  if (await hasActiveWorkspaces({ repositoryId: repository.id })) {
    throw conflict(
      'workspace_active',
      'Merge, keep, or abandon the active task workspaces before removing the repository'
    );
  }
  await db
    .delete(repositories)
    .where(and(eq(repositories.id, repository.id), eq(repositories.userId, userId)));
}
