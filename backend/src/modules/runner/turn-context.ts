import type { Agent, WorkshopPhase } from '../../db/schema';
import { describeTool, type ControlPlaneTool } from '../control-plane/names';
import type { PlanMaterial, WorkshopMaterials } from '../workshop/materials';
import type { WorkshopRunView } from '../workshop/run-view';

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

/** What a phase asks of its participants, beyond reporting through its tool. */
const PHASE_GUIDANCE: Partial<Record<WorkshopPhase, string[]>> = {
  explore: [
    "Explore phase. Every member explores the task at the same time, each in their own read-only worktree. You will not see the other members' findings, and they will not see yours, until everyone has reported.",
    'Read the code the task touches: where the change would go, what it depends on, what could break, and how it is tested. Do not change any files.',
    'Finish by calling submit_exploration once: a summary the lead can plan from, and only the questions a person must answer before the work can be planned.',
  ],
  plan: [
    'Plan phase. You are the lead: turn the explorations below into a plan of work packages.',
    'Each package is built by its owner in their own worktree, at the same time as the packages that do not depend on it, then merged in dependency order. Give each package an area of the code of its own so packages built at the same time do not collide, and make a package depend on another only when it needs that work first.',
    'Finish by calling submit_plan once. A plan that breaks the rules is refused with the reasons; fix it and call again.',
  ],
  plan_review: [
    "Plan review phase. Review the lead's plan below on your own; you will not see the other members' reviews, and they will not see yours.",
    'Check that the packages cover the brief, that parallel packages do not touch the same code, that the dependencies are right, and that each acceptance criterion can be checked. Approve it, or object with comments saying what to change.',
    'Finish by calling submit_plan_review once.',
  ],
  build: [
    'Build phase. Make the change in your worktree. No placeholders and no descriptions of work you did not do.',
    'Finish by calling submit_result with a concise work report that names the files you created or changed.',
  ],
};

/** Longest stretch of phase materials a prompt carries; get_task has them in full. */
const MAX_MATERIALS_CHARS = 12_000;

function formatPlan(plan: PlanMaterial): string {
  const degraded = plan.source === 'degraded' ? ' (the lead gave no plan the platform could accept; one package for the whole task)' : '';
  return [
    `Plan version ${plan.version}${degraded}:`,
    `Summary: ${plan.summary}`,
    'Packages:',
    ...plan.packages.map((p) => {
      const after = p.dependsOn.length ? `after ${p.dependsOn.join(', ')}` : 'no dependencies';
      return `- ${p.key}: ${p.title} (owner ${p.owner}; area ${p.area}; ${after})\n  Acceptance: ${p.acceptance.join('; ')}`;
    }),
    `Integration: ${plan.integration}`,
    `Verification: ${plan.verification}`,
  ].join('\n');
}

/** The phase materials as prompt text, cut to length with a pointer to get_task. */
export function formatMaterials(materials: WorkshopMaterials): string {
  const parts: string[] = [];
  if (materials.explorations) {
    const lines = materials.explorations.map((e) =>
      [`- ${e.member}: ${e.summary}`, ...e.questions.map((q) => `  Asked a person: ${q}`)].join('\n')
    );
    parts.push(['Explorations, one per member:', ...lines].join('\n'));
  }
  if (materials.questions) {
    parts.push(
      materials.questions.answer !== null
        ? `A person answered the members' questions:\n${materials.questions.answer}`
        : "The members' questions got no answer in time; plan without one, and say in the plan what you assumed."
    );
  }
  if (materials.plan) parts.push(formatPlan(materials.plan));
  if (materials.objections?.length) {
    const version = materials.plan?.version ?? 1;
    parts.push(
      [
        `The members objected to plan version ${version}. Revise it once, answering each objection; if objections remain, a person decides.`,
        ...materials.objections.map((o) => `- ${o.member}: ${o.comments}`),
      ].join('\n')
    );
  }
  const text = sanitizeInjected(parts.join('\n\n'));
  return text.length > MAX_MATERIALS_CHARS
    ? `${text.slice(0, MAX_MATERIALS_CHARS)}\n[materials truncated; call get_task for them in full]`
    : text;
}

export interface WorkshopTurnContext {
  agent: Pick<Agent, 'name' | 'description'>;
  taskNumber: number;
  view: WorkshopRunView;
  /** The tools the run is offered, in order. */
  tools: ControlPlaneTool[];
  workspace: string;
  readOnly: boolean;
}

/**
 * Workshop-run prompt: the frozen brief, the member's phase and role, what
 * the phase asks, and the timeline the run may see (already filtered for a
 * blind phase). A text reply is not a report; the phase's tool is.
 */
export function buildWorkshopRunPrompt(input: WorkshopTurnContext): string {
  const { view } = input;
  const reportTool = input.tools.find((t) => t.startsWith('submit_')) ?? null;
  const label = view.phase.replace('_', ' ');
  const guidance =
    PHASE_GUIDANCE[view.phase] ??
    [`${label[0]!.toUpperCase()}${label.slice(1)} phase.`, reportTool ? `Finish by calling ${reportTool} once.` : ''].filter(Boolean);
  const retry =
    view.previousReply !== null && reportTool
      ? [
          `Your previous turn in this phase ended without calling ${reportTool}, so it counts as no report. Its final reply is quoted below; call ${reportTool} now, building on it rather than starting over.`,
          '<previous-reply>',
          sanitizeInjected(view.previousReply),
          '</previous-reply>',
        ].join('\n')
      : view.round > 0
        ? 'An earlier attempt at this phase did not finish. Start again from the worktree as it is now.'
        : '';

  const sections: string[] = [
    '[AGENT_RUNTIME_CONTEXT]',
    'You are the agent described below, working as a member of a workshop: several agents take a task through fixed phases on the Loxo platform, and the platform moves the task from phase to phase.',
    `Agent: ${input.agent.name}`,
    input.agent.description ? `Description: ${sanitizeInjected(input.agent.description)}` : '',
    [`Task #${input.taskNumber}: ${sanitizeInjected(view.title)}`, view.brief ? `Brief: ${sanitizeInjected(view.brief)}` : '']
      .filter(Boolean)
      .join('\n'),
    [
      `Members: ${view.members.map((m) => m.name).join(', ')}.`,
      `You are ${view.role === 'lead' ? 'the lead' : 'a member'}. Current phase: ${label}${view.round > 0 ? ` (attempt ${view.round + 1})` : ''}.`,
    ].join('\n'),
    guidance.join('\n'),
    retry,
    formatMaterials(view.materials),
    view.timeline.length > 0
      ? [
          'Task timeline you can see (oldest first):',
          ...view.timeline
            .slice(-MAX_TIMELINE_ENTRIES)
            .map(
              (t) => `- ${t.kind}: ${sanitizeInjected(t.content.replace(/\s+/g, ' ').slice(0, MAX_TIMELINE_ENTRY_CHARS))}`
            ),
        ].join('\n')
      : '',
    `Workspace: ${input.workspace}`,
    ['Platform control-plane tools for this run:', ...input.tools.map((t) => `- ${t}: ${describeTool(t, true)}`)].join('\n'),
    [
      'Hard rules for this run:',
      '- This run is non-interactive. Never wait for confirmation; decide and proceed.',
      input.readOnly ? '- This phase is read-only: do not create, change, or delete any files.' : '',
      reportTool
        ? `- Your report is what you pass to ${reportTool}. A text reply is not a report and is not shown to the other members.`
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
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
