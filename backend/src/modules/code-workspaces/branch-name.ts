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

export function taskBranchName(prefix: string, taskNumber: number, taskId: string): string {
  const shortId = taskId.replace(/-/g, '').slice(0, 6).toLowerCase();
  return assertSafeRefName(`${prefix}/task-${taskNumber}-${shortId}`);
}
