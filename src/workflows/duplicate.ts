/** Workflow: WRONG OR DUPLICATE CHARGE (BRD §6.3). Never disputes on a model's conclusion. */
import { sourceData } from '../retrieval/retrieval.ts';
import { assessDuplicate } from '../policy/eligibility.ts';
import { activeDisputeTxnIds } from '../policy/engine.ts';
import type { Finding } from '../cases/case-service.ts';
import { formatMoney } from '../conversation/format.ts';
import { cardsOf, describeTxn, offerAgent, opByType, sourceGuard } from './common.ts';
import type { Workflow, WorkflowCtx, WorkflowResult } from './types.ts';

const isWrongAmount = (s: string) => /\b(wrong amount|over ?charged|charged (me )?more|incorrect amount|more than (i|it) (should|was)|should have been)\b/i.test(s);

function evaluate(ctx: WorkflowCtx): WorkflowResult {
  const txns = sourceData(ctx.snap, 'transactions') ?? [];
  const rules = sourceData(ctx.snap, 'dispute_rules') ?? [];
  const cards = cardsOf(ctx.snap);

  if (isWrongAmount(ctx.statement) && !/\btwice|duplicate|double\b/i.test(ctx.statement)) {
    return {
      kind: 'inform',
      message:
        'A charge for the wrong amount is handled as an incorrect-amount dispute (rule DR-AMT-01). That needs a receipt or other documentation from you, so it has to be handled by our disputes team rather than by me.',
      findings: [{ kind: 'confirmed', text: 'Incorrect-amount disputes require documentation and are agent-assisted only (rule DR-AMT-01).', source: 'dispute_rules' }],
      resolution: 'unresolved',
      nextSteps: 'Incorrect-amount dispute requires documentation; agent-assisted.',
      offerAgent: offerAgent('out_of_policy'),
    };
  }

  const a = assessDuplicate({ txns, rules, merchantHint: ctx.slots.merchantHint, amountMinor: ctx.slots.amountMinor, activeDisputeTxnIds: activeDisputeTxnIds(ctx.customerId) });
  if (a.status === 'no_candidate') {
    if (ctx.wf.clarifications < 1) {
      ctx.wf.clarifications++;
      ctx.wf.step = 'describe';
      return { kind: 'clarify', purpose: 'describe_dup', message: "I couldn't find two matching charges yet. Which merchant was it, and what was the amount?" };
    }
    return {
      kind: 'inform',
      message: `I checked your recent transactions and couldn't find two charges with the same merchant and amount. ${a.evidence.join(' ')}`,
      findings: [{ kind: 'confirmed', text: 'No matching pair of charges found in transaction history.', source: 'transactions' }],
      resolution: 'unresolved',
      nextSteps: 'No duplicate found; agent offered.',
      offerAgent: offerAgent('ai_uncertain'),
    };
  }
  const refs = [a.original!.transactionId, a.duplicate!.transactionId];
  const findings: Finding[] = [
    { kind: 'confirmed', text: `First charge: ${describeTxn(a.original!, cards)}.`, source: 'transactions' },
    { kind: 'confirmed', text: `Second charge: ${describeTxn(a.duplicate!, cards)}.`, source: 'transactions' },
  ];
  if (a.status === 'insufficient_evidence') {
    ctx.wf.selectedTxnId = a.duplicate!.transactionId;
    findings.push({ kind: 'confirmed', text: `Not enough evidence for an automated duplicate dispute under ${a.decision.ruleCode}: ${a.decision.reasons.join(' ')}`, source: 'dispute_rules' });
    return {
      kind: 'inform',
      message: `Here's what I can see:\n• ${a.evidence.join('\n• ')}\n\nI can't confirm this is a duplicate yet: ${a.decision.reasons.join(' ')} I won't open a dispute on that basis.`,
      findings,
      resolution: 'unresolved',
      nextSteps: 'Insufficient evidence for duplicate dispute; review again once both charges have posted, or agent review.',
      transactionRefs: refs,
      eligibility: a.decision,
      offerAgent: offerAgent('out_of_policy', 'If you’d like, an agent can review it with you now. Shall I transfer you?'),
    };
  }
  ctx.wf.selectedTxnId = a.duplicate!.transactionId;
  findings.push({ kind: 'confirmed', text: `Meets duplicate-charge rule ${a.decision.ruleCode} (${a.decision.ruleVersion}).`, source: 'dispute_rules' });
  return {
    kind: 'propose',
    message: `Here's what I found:\n• ${a.evidence.join('\n• ')}\nThis meets our duplicate-charge rule ${a.decision.ruleCode}. I can submit a duplicate-charge dispute for the second charge of ${formatMoney(a.duplicate!.amountMinor)}. Shall I go ahead?`,
    actions: [{ type: 'submit_dispute', targetRef: a.duplicate!.transactionId, params: {}, label: `Submit a duplicate-charge dispute for ${formatMoney(a.duplicate!.amountMinor)} at ${a.duplicate!.merchant}` }],
    findings,
    ruleRefs: [a.decision.ruleCode!],
    transactionRefs: refs,
    eligibility: a.decision,
    dispute: { txnId: a.duplicate!.transactionId, reason: 'duplicate_charge', evidence: [{ type: 'duplicate_transaction_ref', description: `Original transaction ${a.original!.transactionId}` }] },
  };
}

export const duplicateWorkflow: Workflow = {
  start(ctx) {
    return sourceGuard(ctx.snap, 'wrong_or_duplicate_charge') ?? evaluate(ctx);
  },
  onChoice(ctx) {
    return evaluate(ctx);
  },
  onFreeText(ctx) {
    return evaluate(ctx);
  },
  onYesNo(ctx) {
    return evaluate(ctx);
  },
  afterActions(_ctx, ops) {
    const d = opByType(ops, 'submit_dispute');
    return {
      kind: 'inform',
      message: d?.status === 'succeeded' ? 'The disputes team will review it and contact you with the outcome.' : '',
      findings: [],
      resolution: d?.status === 'succeeded' ? 'resolved' : 'partially_resolved',
      nextSteps: d?.status === 'succeeded' ? 'Duplicate dispute submitted for review.' : 'Dispute not confirmed — follow up.',
    };
  },
  onDeclined() {
    return { kind: 'inform', message: 'Okay, I haven’t submitted anything.', findings: [], resolution: 'unresolved', nextSteps: 'Customer declined duplicate dispute.' };
  },
};
