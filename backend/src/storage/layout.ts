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
 *       teams/<teamId>/runs/<runId>/{workspace,artifacts,logs}
 *     runtime/workshop/<userId>/<agentId>/{workspace,state}
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
  teamDir: (userId: string, teamId: string) => string;
  teamRunDirs: (
    userId: string,
    teamId: string,
    runId: string
  ) => { root: string; workspace: string; artifacts: string; logs: string };
  workshopRuntime: (userId: string, agentId: string) => { workspace: string; state: string };
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
    teamDir: (userId, teamId) => ensured(path.join(root, 'users', userId, 'teams', teamId)),
    teamRunDirs: (userId, teamId, runId) => {
      const runRoot = path.join(root, 'users', userId, 'teams', teamId, 'runs', runId);
      return {
        root: ensured(runRoot),
        workspace: ensured(path.join(runRoot, 'workspace')),
        artifacts: ensured(path.join(runRoot, 'artifacts')),
        logs: ensured(path.join(runRoot, 'logs')),
      };
    },
    workshopRuntime: (userId, agentId) => {
      const base = path.join(root, 'runtime', 'workshop', userId, agentId);
      return {
        workspace: ensured(path.join(base, 'workspace')),
        state: ensured(path.join(base, 'state')),
      };
    },
  };
}

const DEFAULT_ROOT = process.env.STORAGE_ROOT?.trim() || path.resolve('data', 'storage');

export const storage = createStorageLayout(DEFAULT_ROOT);
