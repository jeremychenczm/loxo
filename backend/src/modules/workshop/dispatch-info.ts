import { eq } from 'drizzle-orm';
import { db, type Executor } from '../../db/client';
import { dispatchReports, dispatches, type Dispatch, type Run } from '../../db/schema';
import { agentPhase } from './phases';

export async function dispatchOf(dispatchId: string, ex: Executor = db): Promise<Dispatch | undefined> {
  const [row] = await ex.select().from(dispatches).where(eq(dispatches.id, dispatchId)).limit(1);
  return row;
}

/** Whether a dispatch's phase forbids writing the worktree; unknown dispatches count as read-only. */
export function isReadOnlyDispatch(dispatch: Pick<Dispatch, 'phase'> | undefined): boolean {
  if (!dispatch) return true;
  return agentPhase(dispatch.phase)?.readOnly ?? true;
}

/**
 * Whether a run's final reply may go on the timeline as its fallback report.
 * A workshop run's reply stays on the run (runs.output) when its phase is
 * blind, since the timeline would show it to the other members, and when the
 * dispatch already has its report.
 */
export async function postsFallbackReport(run: Pick<Run, 'dispatchId'>, ex: Executor = db): Promise<boolean> {
  if (!run.dispatchId) return true;
  const dispatch = await dispatchOf(run.dispatchId, ex);
  if (!dispatch || (agentPhase(dispatch.phase)?.blind ?? true)) return false;
  const [report] = await ex
    .select({ id: dispatchReports.id })
    .from(dispatchReports)
    .where(eq(dispatchReports.dispatchId, dispatch.id))
    .limit(1);
  return report === undefined;
}
