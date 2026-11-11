import fs from 'node:fs';
import path from 'node:path';
import { toHostPath } from './host-path';

/**
 * On-disk layout:
 *
 *   <root>/
 *     users/<userId>/
 *       agents/<agentId>/{workspace,baseline,snapshots,state}
 *       worktrees/<taskId>
 *       runs/<runId>/
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
  worktreesRoot: (userId: string) => string;
  runArtifacts: (userId: string, runId: string) => string;
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
    // Managed worktrees live in platform storage, never inside a registered repository.
    worktreesRoot: (userId) => ensured(path.join(root, 'users', userId, 'worktrees')),
    runArtifacts: (userId, runId) => ensured(path.join(root, 'users', userId, 'runs', runId)),
  };
}

const DEFAULT_ROOT = process.env.STORAGE_ROOT?.trim() || path.resolve('data', 'storage');

export const storage = createStorageLayout(DEFAULT_ROOT);
