import { GitDriverError } from './workspace.types';

/**
 * Conservative subset of git-check-ref-format, applied to every ref that
 * reaches a Git invocation. Rejects leading dashes so a ref can never be
 * parsed as an option.
 */
export function isSafeRefName(ref: string): boolean {
  if (!ref || ref.length > 200) return false;
  if (ref.startsWith('-') || ref.startsWith('.') || ref.startsWith('/')) return false;
  if (ref.endsWith('/') || ref.endsWith('.') || ref.endsWith('.lock')) return false;
  if (/[\s~^:?*[\\]/.test(ref)) return false;
  for (let i = 0; i < ref.length; i += 1) {
    const code = ref.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  if (ref.includes('..') || ref.includes('@{') || ref.includes('//')) return false;
  return true;
}

export function assertSafeRefName(ref: string): string {
  if (!isSafeRefName(ref)) {
    throw new GitDriverError('invalid_ref', `Invalid Git ref name: ${JSON.stringify(ref)}`);
  }
  return ref;
}

export function assertCommitId(commit: string): string {
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new GitDriverError('invalid_ref', `Invalid commit id: ${JSON.stringify(commit)}`);
  }
  return commit;
}

/** Every branch Loxo creates lives under this namespace; nothing outside it is ever deleted. */
export const MANAGED_BRANCH_PREFIX = 'loxo';

export function isManagedBranch(branch: string): boolean {
  return isSafeRefName(branch) && branch.startsWith(`${MANAGED_BRANCH_PREFIX}/`);
}

export function assertManagedBranch(branch: string): string {
  if (!isManagedBranch(branch)) {
    throw new GitDriverError(
      'unmanaged_branch',
      `Refusing to touch ${JSON.stringify(branch)}: only ${MANAGED_BRANCH_PREFIX}/ branches are managed`
    );
  }
  return branch;
}

/** Ref-safe, human-readable member label: slugged name plus a short id for uniqueness. */
export function memberSlug(name: string, agentId: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/g, '');
  const shortId = agentId.replace(/-/g, '').slice(0, 6).toLowerCase();
  return base ? `${base}-${shortId}` : shortId;
}

/** `loxo/t<n>/integration` for the task branch, `loxo/t<n>/<member>` for a member's. */
export function workspaceBranchName(taskNumber: number, member: string | null): string {
  return assertSafeRefName(`${MANAGED_BRANCH_PREFIX}/t${taskNumber}/${member ?? 'integration'}`);
}

/** Worktree leaf under the managed root: `<taskId>/integration` or `<taskId>/<kind>-<member>`. */
export function workspaceLeaf(taskId: string, kind: string, member: string | null): string {
  return kind === 'integration' || !member ? `${taskId}/integration` : `${taskId}/${kind}-${member}`;
}
