import type { Scenario } from '@swarmdev/fake-agent';

/**
 * The kinds of run a chaos trial puts through a crash. Each plays for about
 * six seconds: long enough that an agent left running by a dead backend
 * would still be at work when the run's retry starts, which is what the
 * double-execution check needs to see.
 */
export const RUN_KINDS = ['read', 'comment', 'submit', 'edit-clean', 'edit-dirty'] as const;

/**
 * A workshop on a repository: platform runs prepare its worktrees, then its
 * members explore at once, each under its own worktree's gate. Kept out of
 * RUN_KINDS so the run-kind cells and controls stay as they were.
 */
export const WORKSHOP_KIND = 'workshop';
export type RunKind = (typeof RUN_KINDS)[number] | typeof WORKSHOP_KIND;
export const ALL_KINDS: readonly RunKind[] = [...RUN_KINDS, WORKSHOP_KIND];

export interface RunKindSpec {
  /** Bind the task to a repository, so the run gets a worktree it may edit. */
  repository: boolean;
  /** Start a workshop with this many members instead of waking a single agent. */
  members?: number;
  /** About how long one run plays, for the trial's check time. */
  durationMs: number;
  /** `tag` keeps timeline entries unique per trial. */
  scenario(tag: string): Scenario;
}

const DURATION_MS = 6_000;

const turn = (steps: Scenario['turns'][number]['steps']): Scenario => ({ turns: [{ steps }] });

export const RUN_KIND_SPECS: Record<RunKind, RunKindSpec> = {
  read: {
    repository: false,
    durationMs: DURATION_MS,
    scenario: () =>
      turn([
        { say: 'Reading the brief. ' },
        { sleep: 2_000 },
        { say: 'Still reading. ' },
        { sleep: 2_000 },
        { say: 'Nothing to change.' },
        { sleep: 2_000 },
      ]),
  },
  comment: {
    repository: false,
    durationMs: DURATION_MS,
    scenario: (tag) =>
      turn([
        { sleep: 1_500 },
        { mcp: { tool: 'comment_on_task', args: { body: `Progress note ${tag}` } } },
        { sleep: 3_000 },
        { say: 'Noted progress.' },
        { sleep: 1_500 },
      ]),
  },
  submit: {
    repository: false,
    durationMs: DURATION_MS,
    scenario: (tag) =>
      turn([
        { sleep: 1_500 },
        { mcp: { tool: 'submit_result', args: { summary: `Result ${tag}` } } },
        { sleep: 3_000 },
        { say: 'Submitted.' },
        { sleep: 1_500 },
      ]),
  },
  'edit-clean': {
    repository: true,
    durationMs: DURATION_MS,
    scenario: () => turn([{ sleep: 3_000 }, { say: 'Looked around; nothing to edit.' }, { sleep: 3_000 }]),
  },
  // After the platform runs, both members explore at once and report; Plan takes no report from
  // agents yet, so the lead is asked once more and then marked failed: three agent rounds in a row.
  workshop: {
    repository: true,
    members: 2,
    durationMs: 3 * DURATION_MS + 2_000,
    scenario: (tag) =>
      turn([
        { say: 'Looking around the repository. ' },
        { sleep: 1_500 },
        { mcp: { tool: 'submit_exploration', args: { summary: `Exploration ${tag}` } } },
        { sleep: 3_000 },
        { say: 'Reported.' },
        { sleep: 1_500 },
      ]),
  },
  'edit-dirty': {
    repository: true,
    durationMs: DURATION_MS,
    scenario: (tag) =>
      turn([
        { sleep: 1_500 },
        { writeFile: { path: 'chaos.txt', content: `written by ${tag}\n` } },
        { sleep: 3_000 },
        { say: 'Changed a file.' },
        { sleep: 1_500 },
      ]),
  },
};
