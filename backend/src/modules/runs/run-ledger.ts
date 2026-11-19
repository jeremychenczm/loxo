import { asc, eq, sql } from 'drizzle-orm';
import { db, type Executor } from '../../db/client';
import { changeSnapshots, controlPlaneRequests, turns, TERMINAL_CONTROL_PLANE_TOOLS } from '../../db/schema';

type TerminalTool = (typeof TERMINAL_CONTROL_PLANE_TOOLS)[number];

const TERMINAL: readonly string[] = TERMINAL_CONTROL_PLANE_TOOLS;

export interface RunLedger {
  /** Committed control-plane calls, terminal ones included. */
  controlPlaneWrites: number;
  /** The run's terminal call and the result it returned, once committed. */
  terminal: { tool: TerminalTool; result: unknown } | null;
  /** The platform committed a change snapshot for the run. */
  captured: boolean;
  /** Timeline entries tied to the run: agent posts, evidence notes, the fallback report. */
  timelineEntries: number;
}

/**
 * What a run has committed to platform state, read back from the rows its
 * writes leave. Each source row commits in the same fenced transaction as
 * the write it stands for: a control-plane request row with the tool's
 * writes, the change snapshot with the capture, a timeline entry with the
 * post. The ledger therefore never shows a write that rolled back and never
 * misses one that committed. Run events, permission requests, and the
 * before-state are bookkeeping, not effects; worktree changes are measured
 * against the before-state instead.
 */
export async function readRunLedger(runId: string, ex: Executor = db): Promise<RunLedger> {
  const requests = await ex
    .select({ tool: controlPlaneRequests.tool, result: controlPlaneRequests.result })
    .from(controlPlaneRequests)
    .where(eq(controlPlaneRequests.runId, runId))
    .orderBy(asc(controlPlaneRequests.seq));
  const [snapshot] = await ex
    .select({ id: changeSnapshots.id })
    .from(changeSnapshots)
    .where(eq(changeSnapshots.runId, runId))
    .limit(1);
  const [entries] = await ex
    .select({ n: sql<number>`count(*)::int` })
    .from(turns)
    .where(eq(turns.runId, runId));
  const terminal = requests.find((r) => TERMINAL.includes(r.tool));
  return {
    controlPlaneWrites: requests.length,
    terminal: terminal ? { tool: terminal.tool as TerminalTool, result: terminal.result } : null,
    captured: snapshot !== undefined,
    timelineEntries: entries?.n ?? 0,
  };
}

/** Whether anything the run did is visible in platform state; a retry could repeat it. */
export function hasCommittedEffects(ledger: RunLedger): boolean {
  return ledger.controlPlaneWrites > 0 || ledger.captured || ledger.timelineEntries > 0;
}
