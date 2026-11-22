import type { Run, WorkshopPhase } from '../../db/schema';
import { agentPhase } from '../workshop/phases';

/** The MCP server name a run reaches the control plane under. */
export const CONTROL_PLANE_SERVER = 'swarmdev';

/** The control plane's tools, by the names agents call them. */
export const CONTROL_PLANE_TOOLS = [
  'get_task',
  'comment_on_task',
  'update_task_status',
  'submit_review',
  'ask_blocker',
  'submit_result',
  'submit_exploration',
] as const;

export type ControlPlaneTool = (typeof CONTROL_PLANE_TOOLS)[number];

/** Phase report tools the control plane takes; a phase whose tool is not listed gets no report tool. */
const OFFERED_REPORT_TOOLS: readonly string[] = ['submit_exploration', 'submit_result'];

/**
 * The tools a run is offered. A review run judges; a legacy worker run moves
 * its task. A workshop run reports through its phase's tool, and in a blind
 * phase it has no way to post anything its peers would see.
 */
export function toolsForRun(run: Pick<Run, 'trigger' | 'dispatchId'>, phase: WorkshopPhase | null): ControlPlaneTool[] {
  if (run.trigger === 'review') return ['get_task', 'comment_on_task', 'submit_review'];
  if (!run.dispatchId) return ['get_task', 'comment_on_task', 'update_task_status', 'ask_blocker', 'submit_result'];
  const spec = phase ? agentPhase(phase) : null;
  const tools: ControlPlaneTool[] = ['get_task'];
  if (spec && !spec.blind) tools.push('comment_on_task', 'ask_blocker');
  if (spec && OFFERED_REPORT_TOOLS.includes(spec.reportTool)) tools.push(spec.reportTool as ControlPlaneTool);
  return tools;
}

/** What each tool tells the agent, worded for a workshop run or a legacy one. */
export function describeTool(tool: ControlPlaneTool, workshop: boolean): string {
  switch (tool) {
    case 'get_task':
      return workshop
        ? 'Read the task, the workshop phase you are in, and what this phase gives you to work from.'
        : 'Read the task this run was woken for: title, brief, status, and timeline.';
    case 'comment_on_task':
      return 'Post a progress note to the task timeline as yourself.';
    case 'update_task_status':
      return 'Move the task to a new status. Transitions follow the board rules; illegal moves are rejected.';
    case 'submit_review':
      return 'Deliver your review verdict. approved records a recommendation (a human closes the task); changes_requested reopens work with your feedback.';
    case 'ask_blocker':
      return workshop
        ? 'You need a person to decide something before you can go on. Opens the question for a person; the task stays in its phase.'
        : 'You are stuck and need a human decision. Posts the question to the timeline and marks the task blocked.';
    case 'submit_result':
      return workshop
        ? 'You finished your part. Records your work report for this phase and posts it to the timeline.'
        : 'You finished the work. Posts your result summary to the timeline and hands the task to review.';
    case 'submit_exploration':
      return [
        'Submit your exploration, once; the first submission stands.',
        '`summary`: what the code looks like where the task touches it, constraints and risks you found, and the approach you would take.',
        '`questions`: only what a person must answer before the work can be planned. They reach a person together with the other members\' questions once everyone has reported.',
      ].join(' ');
  }
}
