import { and, desc, eq, lte, sql } from 'drizzle-orm';
import { db, type Executor } from '../../db/client';
import { integrations, workPackages, type WorkPackage } from '../../db/schema';

/** The integration a package's resolve is for: its latest conflict, against the head it is resolving onto. */
export async function conflictOf(
  pkg: Pick<WorkPackage, 'taskId' | 'key' | 'resolveOnto'>,
  ex: Executor = db
): Promise<{ id: string; files: string[]; onto: string } | null> {
  if (!pkg.resolveOnto) return null;
  const [latest] = await ex
    .select({ id: integrations.id, ontoCommit: integrations.ontoCommit, conflictFiles: integrations.conflictFiles })
    .from(integrations)
    .where(and(eq(integrations.taskId, pkg.taskId), eq(integrations.packageKey, pkg.key), eq(integrations.outcome, 'conflicted')))
    .orderBy(desc(integrations.createdAt))
    .limit(1);
  if (!latest || latest.ontoCommit !== pkg.resolveOnto) return null;
  return { id: latest.id, files: latest.conflictFiles, onto: latest.ontoCommit };
}

/** The files a package's resolve must clear of conflict markers. */
export async function conflictFilesOf(pkg: Pick<WorkPackage, 'taskId' | 'key' | 'resolveOnto'>, ex: Executor = db): Promise<string[]> {
  return (await conflictOf(pkg, ex))?.files ?? [];
}

/** Packages merged into the integration branch by the time the given conflict was found, in merge order. */
export async function mergedBefore(taskId: string, conflictId: string, ex: Executor = db): Promise<WorkPackage[]> {
  const rows = await ex
    .select({ pkg: workPackages })
    .from(integrations)
    .innerJoin(workPackages, and(eq(workPackages.taskId, integrations.taskId), eq(workPackages.key, integrations.packageKey)))
    .where(
      and(
        eq(integrations.taskId, taskId),
        eq(integrations.outcome, 'merged'),
        // In SQL, at full precision: both rows carry the database clock.
        lte(integrations.createdAt, sql`(SELECT created_at FROM integrations WHERE id = ${conflictId})`)
      )
    )
    .orderBy(integrations.createdAt);
  const seen = new Set<string>();
  return rows.map((r) => r.pkg).filter((p) => !seen.has(p.key) && seen.add(p.key));
}
