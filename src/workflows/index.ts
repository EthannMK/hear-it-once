import type { IssueType } from '../config/policy.ts';
import type { Workflow } from './types.ts';
import { unrecognisedWorkflow } from './unrecognised.ts';
import { lostCardWorkflow } from './lost-card.ts';
import { duplicateWorkflow } from './duplicate.ts';
import { paymentWorkflow } from './payment.ts';
import { feeWorkflow } from './fee.ts';

export const WORKFLOWS: Record<IssueType, Workflow> = {
  unrecognised_transaction: unrecognisedWorkflow,
  lost_stolen_card: lostCardWorkflow,
  wrong_or_duplicate_charge: duplicateWorkflow,
  payment_not_showing: paymentWorkflow,
  fee_query: feeWorkflow,
};
