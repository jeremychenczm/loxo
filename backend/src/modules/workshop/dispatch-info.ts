import { eq } from 'drizzle-orm';
import { db, type Executor } from '../../db/client';
import { dispatches, type Dispatch } from '../../db/schema';
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
