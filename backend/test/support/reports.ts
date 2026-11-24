import type { RunToolContext } from '../../src/modules/control-plane/tools';

/**
 * A valid report for each phase tool, as a well-behaved member would send it:
 * a one-package plan owned by the lead who writes it, and an approving review.
 */
export function sampleReport(tool: string, ctx: RunToolContext, note = 'Looked.'): Record<string, unknown> {
  switch (tool) {
    case 'submit_plan':
      return {
        summary: note,
        packages: [{ key: 'main', title: 'The whole task', owner: ctx.agent.name, area: 'everything', acceptance: ['It works'] }],
        integration: 'One package.',
        verification: 'Run the tests.',
      };
    case 'submit_plan_review':
      return { verdict: 'approve' };
    default:
      return { summary: note };
  }
}
