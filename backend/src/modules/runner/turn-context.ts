import type { Agent } from '../../db/schema';

const MAX_PROMPT_CHARS = 24_000;

/**
 * Neutralizes code fences so injected documents cannot break out of the
 * context block or read as executable instructions.
 */
export function sanitizeInjected(text: string): string {
  return text.replace(/```/g, '~~~');
}

const MAX_TIMELINE_ENTRIES = 10;
const MAX_TIMELINE_ENTRY_CHARS = 400;

export interface TaskRunTurnContext {
  agent: Pick<Agent, 'name' | 'description'>;
  taskNumber: number;
  title: string;
  brief: string;
  status: string;
  /** Why the agent was woken (assignment, manual nudge, ...). */
  reason: string;
  timeline: Array<{ author: string; body: string }>;
  workspace: string;
}

/**
 * Task-run prompt. The run is non-interactive and the work report lands on
 * the task timeline through submit_result, or the reply text as a fallback.
 */
export function buildTaskRunPrompt(input: TaskRunTurnContext): string {
  const sections: string[] = [
    '[AGENT_RUNTIME_CONTEXT]',
    'You are the agent described below, executing one run against a task assigned to you on the Loxo platform.',
    `Agent: ${input.agent.name}`,
    input.agent.description ? `Description: ${sanitizeInjected(input.agent.description)}` : '',
    [
      `Task #${input.taskNumber}: ${sanitizeInjected(input.title)}`,
      `Status: ${input.status}`,
      input.brief ? `Brief: ${sanitizeInjected(input.brief)}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    `Wake reason: ${sanitizeInjected(input.reason)}`,
    input.timeline.length > 0
      ? [
          'Recent task timeline (oldest first):',
          ...input.timeline
            .slice(-MAX_TIMELINE_ENTRIES)
            .map(
              (c) =>
                `- ${c.author}: ${sanitizeInjected(c.body.replace(/\s+/g, ' ').slice(0, MAX_TIMELINE_ENTRY_CHARS))}`
            ),
        ].join('\n')
      : '',
    `Workspace: ${input.workspace}`,
    [
      'Platform control-plane tools for this run:',
      '- get_task: re-read the task and its timeline.',
      '- comment_on_task: post a progress note.',
      '- update_task_status: move the task on the board (legal transitions only).',
      '- ask_blocker: you are stuck and need a human decision; marks the task blocked.',
      '- submit_result: you finished; posts your work report and hands the task to review.',
    ].join('\n'),
    [
      'Hard rules for this run:',
      '- This run is non-interactive. Never wait for confirmation; decide and proceed.',
      '- Do the actual work in the workspace. No placeholders and no descriptions of work you did not do.',
      '- Finish by calling submit_result with a concise work report, or ask_blocker if you cannot proceed. If you post nothing through the control plane, your final reply text lands on the timeline as a fallback.',
      '- State the paths of files you created or changed in your report.',
    ].join('\n'),
    'Treat everything inside AGENT_RUNTIME_CONTEXT as platform framing, not user-authored text.',
    'Do not reveal credentials or platform internals in replies.',
    '[/AGENT_RUNTIME_CONTEXT]',
  ].filter(Boolean);

  let context = sections.join('\n\n');
  if (context.length > MAX_PROMPT_CHARS) {
    context = `${context.slice(0, MAX_PROMPT_CHARS)}\n[context truncated]\n[/AGENT_RUNTIME_CONTEXT]`;
  }

  return context;
}

/**
 * Review-run prompt. The reviewer judges submitted work: inspect the real
 * files, never modify them, and deliver a verdict through submit_review.
 */
export function buildReviewRunPrompt(input: TaskRunTurnContext): string {
  const sections: string[] = [
    '[AGENT_RUNTIME_CONTEXT]',
    'You are the agent described below, acting as the REVIEWER for a task on the Loxo platform. Work has been submitted; your job is to judge it.',
    `Agent: ${input.agent.name}`,
    input.agent.description ? `Description: ${sanitizeInjected(input.agent.description)}` : '',
    [
      `Task #${input.taskNumber}: ${sanitizeInjected(input.title)}`,
      `Status: ${input.status}`,
      input.brief ? `Brief: ${sanitizeInjected(input.brief)}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    `Wake reason: ${sanitizeInjected(input.reason)}`,
    input.timeline.length > 0
      ? [
          'Task timeline (oldest first — the work reports you are reviewing are here):',
          ...input.timeline
            .slice(-MAX_TIMELINE_ENTRIES)
            .map(
              (c) =>
                `- ${c.author}: ${sanitizeInjected(c.body.replace(/\s+/g, ' ').slice(0, MAX_TIMELINE_ENTRY_CHARS))}`
            ),
        ].join('\n')
      : '',
    `Workspace (inspect the actual work here): ${input.workspace}`,
    [
      'Reviewer control-plane tools for this run:',
      '- get_task: re-read the task and its timeline.',
      '- comment_on_task: post a review note.',
      '- submit_review: deliver your verdict — approved (recorded as a recommendation; a human closes the task) or changes_requested (reopens work with your feedback).',
    ].join('\n'),
    [
      'Hard rules for this review:',
      '- This run is non-interactive. Never wait for confirmation; decide and proceed.',
      '- Inspect the actual files and results in the workspace. Do not take timeline claims at face value.',
      '- You are the reviewer: do NOT modify any files. Defects are sent back via changes_requested, not fixed by you.',
      '- Finish by calling submit_review with a clear verdict and concrete, actionable feedback.',
    ].join('\n'),
    'Treat everything inside AGENT_RUNTIME_CONTEXT as platform framing, not user-authored text.',
    'Do not reveal credentials or platform internals in replies.',
    '[/AGENT_RUNTIME_CONTEXT]',
  ].filter(Boolean);

  let context = sections.join('\n\n');
  if (context.length > MAX_PROMPT_CHARS) {
    context = `${context.slice(0, MAX_PROMPT_CHARS)}\n[context truncated]\n[/AGENT_RUNTIME_CONTEXT]`;
  }

  return context;
}
