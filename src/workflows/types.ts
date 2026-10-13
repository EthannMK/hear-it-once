import type { ActionType, IssueType } from '../config/policy.ts';
import type { IssueSlots } from '../ai/intent.ts';
import type { Snapshot } from '../retrieval/retrieval.ts';
import type { Finding } from '../cases/case-service.ts';
import type { EligibilityDecision } from '../policy/eligibility.ts';
import type { Operation } from '../actions/action-service.ts';

export interface Choice {
  id: string;
  label: string;
}

export interface ProposedAction {
  type: ActionType;
  targetRef: string;
  params: Record<string, unknown>;
  label: string;
  /** Do not attempt unless this earlier action in the same proposal succeeded. */
  requires?: ActionType;
}

export interface DisputeDraftSpec {
  txnId: string;
  reason: 'fraud_unrecognised' | 'duplicate_charge';
  evidence: { type: string; description: string }[];
}

export type WorkflowResult =
  | { kind: 'clarify'; purpose: string; message: string; choices?: Choice[]; findings?: Finding[] }
  | {
      kind: 'propose';
      message: string;
      actions: ProposedAction[];
      findings: Finding[];
      ruleRefs: string[];
      transactionRefs: string[];
      eligibility?: EligibilityDecision | null;
      dispute?: DisputeDraftSpec;
    }
  | {
      kind: 'inform';
      message: string;
      findings: Finding[];
      resolution: 'resolved' | 'informational' | 'partially_resolved' | 'unresolved';
      nextSteps: string;
      transactionRefs?: string[];
      eligibility?: EligibilityDecision | null;
      offerAgent?: { reason: string; question: string };
    }
  | { kind: 'ask_yes_no'; purpose: string; message: string; findings?: Finding[] }
  | { kind: 'handoff'; reason: string; detail: string; message: string; findings: Finding[]; missing?: string[]; priority?: 'normal' | 'urgent'; transactionRefs?: string[] };

/** Mutable per-session workflow memory (persisted in the session context). */
export interface WorkflowState {
  name: IssueType;
  step: string;
  selectedTxnId?: string | null;
  selectedCardRef?: string | null;
  selectedFeeId?: string | null;
  selectedPaymentId?: string | null;
  clarifications: number;
  recurring?: boolean;
  priorCaseIds?: string[];
}

export interface WorkflowCtx {
  snap: Snapshot;
  slots: IssueSlots;
  statement: string;
  wf: WorkflowState;
  sessionId: string;
  customerId: string;
  firstName: string;
}

export interface Workflow {
  start(ctx: WorkflowCtx): WorkflowResult;
  onChoice(ctx: WorkflowCtx, purpose: string, optionId: string): WorkflowResult;
  onFreeText?(ctx: WorkflowCtx, purpose: string, text: string): WorkflowResult;
  onYesNo(ctx: WorkflowCtx, purpose: string, yes: boolean): WorkflowResult;
  afterActions(ctx: WorkflowCtx, ops: Operation[]): WorkflowResult;
  onDeclined(ctx: WorkflowCtx): WorkflowResult;
}
