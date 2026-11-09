import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { memos, type Memo, type MemoScope, type MemoSource } from '../../db/schema';
import { notFound } from '../../http/errors';

const MEMO_MAX_CHARS = 600;
const INJECT_PER_SCOPE = 4;
const INJECT_MEMO_CHARS = 300;

export interface AddMemoInput {
  userId: string;
  scope: MemoScope;
  subjectId: string;
  source: MemoSource;
  content: string;
}

export async function addMemo(input: AddMemoInput): Promise<Memo | null> {
  const content = input.content.replace(/\s+/g, ' ').trim().slice(0, MEMO_MAX_CHARS);
  if (!content) return null;
  const [row] = await db
    .insert(memos)
    .values({
      userId: input.userId,
      scope: input.scope,
      subjectId: input.subjectId,
      source: input.source,
      content,
    })
    .returning();
  return row!;
}

export async function listMemos(
  userId: string,
  scope: MemoScope,
  subjectId: string,
  limit = 50
): Promise<Memo[]> {
  return db
    .select()
    .from(memos)
    .where(and(eq(memos.userId, userId), eq(memos.scope, scope), eq(memos.subjectId, subjectId)))
    .orderBy(desc(memos.createdAt))
    .limit(limit);
}

export async function deleteMemo(userId: string, memoId: string): Promise<void> {
  const deleted = await db
    .delete(memos)
    .where(and(eq(memos.id, memoId), eq(memos.userId, userId)))
    .returning({ id: memos.id });
  if (deleted.length === 0) throw notFound('Memo not found');
}

export interface NodeMemoScopes {
  agentId?: string | null;
  teamId?: string | null;
  projectId?: string | null;
}

/**
 * Recent memos formatted for prompt injection, newest first within each
 * scope. Hard caps on count and length keep accumulated memory from
 * crowding out the actual task (context-rot guard).
 */
export async function collectNodeMemos(userId: string, scopes: NodeMemoScopes): Promise<string[]> {
  const wanted: Array<{ scope: MemoScope; subjectId: string }> = [];
  if (scopes.teamId) wanted.push({ scope: 'team', subjectId: scopes.teamId });
  if (scopes.agentId) wanted.push({ scope: 'agent', subjectId: scopes.agentId });
  if (scopes.projectId) wanted.push({ scope: 'project', subjectId: scopes.projectId });

  const lines: string[] = [];
  for (const target of wanted) {
    const rows = await listMemos(userId, target.scope, target.subjectId, INJECT_PER_SCOPE);
    for (const row of rows) {
      lines.push(`[${target.scope}] ${row.content.slice(0, INJECT_MEMO_CHARS)}`);
    }
  }
  return lines;
}
