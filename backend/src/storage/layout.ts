import fs from 'node:fs';
import path from 'node:path';
import { toHostPath } from './host-path';

/**
 * On-disk layout:
 *
 *   <root>/
 *     users/<userId>/
 *       agents/<agentId>/{workspace,baseline,snapshots,state}
 *       projects/<projectId>/{workspace,worktrees/<issueId>}
 *
 * Agent runtime state lives beside the workspace, not inside it, so
 * workspace diffing never has to filter state files out.
 */
export interface AgentPaths {
  root: string;
  workspace: string;
  baseline: string;
  snapshots: string;
  state: string;
}

export interface StorageLayout {
  root: string;
  userRoot: (userId: string) => string;
  agentPaths: (userId: string, agentId: string) => AgentPaths;
  projectWorkspace: (userId: string, projectId: string) => string;
  projectWorktreesRoot: (userId: string, projectId: string) => string;
  projectCodeArtifacts: (userId: string, projectId: string, runId: string) => string;
}

function ensured(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function createStorageLayout(rootInput: string): StorageLayout {
  const root = toHostPath(rootInput);

  return {
    root,
    userRoot: (userId) => ensured(path.join(root, 'users', userId)),
    agentPaths: (userId, agentId) => {
      const agentRoot = path.join(root, 'users', userId, 'agents', agentId);
      return {
        root: ensured(agentRoot),
        workspace: ensured(path.join(agentRoot, 'workspace')),
        baseline: ensured(path.join(agentRoot, 'baseline')),
        snapshots: ensured(path.join(agentRoot, 'snapshots')),
        state: ensured(path.join(agentRoot, 'state')),
      };
    },
    projectWorkspace: (userId, projectId) =>
      ensured(path.join(root, 'users', userId, 'projects', projectId, 'workspace')),
    // Managed issue worktrees live beside the workspace, never inside the repository.
    projectWorktreesRoot: (userId, projectId) =>
      ensured(path.join(root, 'users', userId, 'projects', projectId, 'worktrees')),
    projectCodeArtifacts: (userId, projectId, runId) =>
      ensured(path.join(root, 'users', userId, 'projects', projectId, 'code-artifacts', runId)),
  };
}

const DEFAULT_ROOT = process.env.STORAGE_ROOT?.trim() || path.resolve('data', 'storage');

export const storage = createStorageLayout(DEFAULT_ROOT);
