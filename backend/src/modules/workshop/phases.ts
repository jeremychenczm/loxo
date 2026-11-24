import type { DispatchPurpose, WorkshopPhase } from '../../db/schema';

/** Who an agent phase asks: every member, the lead, everyone but the lead, or the sign-off roster. */
export type Participants = 'all' | 'lead' | 'others' | 'signers';

export interface AgentPhaseSpec {
  kind: 'agent';
  purpose: DispatchPurpose;
  participants: Participants;
  readOnly: boolean;
  /**
   * Participants work without seeing each other: no comments, no blocker posts,
   * and nothing a peer wrote in this phase reaches their prompt or get_task.
   */
  blind: boolean;
  /** The terminal control-plane tool that carries the phase's report. */
  reportTool: string;
}

/** Phases the platform carries out itself, or that wait on a person. */
export interface PlatformPhaseSpec {
  kind: 'platform';
}

export type PhaseSpec = AgentPhaseSpec | PlatformPhaseSpec;

export const PHASES: Record<WorkshopPhase, PhaseSpec> = {
  brief: { kind: 'platform' },
  explore: { kind: 'agent', purpose: 'explore', participants: 'all', readOnly: true, blind: true, reportTool: 'submit_exploration' },
  plan: { kind: 'agent', purpose: 'plan', participants: 'lead', readOnly: true, blind: false, reportTool: 'submit_plan' },
  plan_review: {
    kind: 'agent',
    purpose: 'plan_review',
    participants: 'others',
    readOnly: true,
    blind: true,
    reportTool: 'submit_plan_review',
  },
  build: { kind: 'agent', purpose: 'build', participants: 'lead', readOnly: false, blind: false, reportTool: 'submit_result' },
  check: { kind: 'platform' },
  verify: { kind: 'agent', purpose: 'verify', participants: 'others', readOnly: true, blind: true, reportTool: 'submit_verification' },
  triage: { kind: 'agent', purpose: 'triage', participants: 'lead', readOnly: true, blind: false, reportTool: 'submit_triage' },
  fix: { kind: 'agent', purpose: 'fix', participants: 'lead', readOnly: false, blind: false, reportTool: 'submit_result' },
  sign_off: { kind: 'agent', purpose: 'sign_off', participants: 'signers', readOnly: true, blind: true, reportTool: 'submit_sign_off' },
  approval: { kind: 'platform' },
  merge: { kind: 'platform' },
  done: { kind: 'platform' },
  stopped: { kind: 'platform' },
};

export const FINISHED_PHASES: readonly WorkshopPhase[] = ['done', 'stopped'];

export function agentPhase(phase: WorkshopPhase): AgentPhaseSpec | null {
  const spec = PHASES[phase];
  return spec.kind === 'agent' ? spec : null;
}
