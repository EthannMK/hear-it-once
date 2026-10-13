/** Workflow: UNRECOGNISED TRANSACTION (BRD §6.1). */
import type { Transaction } from '../adapters/types.ts';
import { sourceData } from '../retrieval/retrieval.ts';
import { fraudDisputeEligibility } from '../policy/eligibility.ts';
import { activeDisputeTxnIds, cardConfirmedBlocked } from '../policy/engine.ts';
import type { Finding } from '../cases/case-service.ts';
import { formatDate, formatMoney } from '../conversation/format.ts';
import { cardsOf, describeTxn, matchTransactions, offerAgent, opByType, sourceGuard, txnChoices, uniqueBest } from './common.ts';
import type { ProposedAction, Workflow, WorkflowCtx, WorkflowResult } from './types.ts';

function purchases(ctx: WorkflowCtx): Transaction[] {
  return (sourceData(ctx.snap, 'transactions') ?? []).filter((t) => t.kind === 'purchase' || t.kind === 'cash_advance');
}

export function evaluateUnrecognised(ctx: WorkflowCtx, txn: Transaction, opts: { cardAlreadyHandled?: boolean } = {}): WorkflowResult {
  ctx.wf.selectedTxnId = txn.transactionId;
  ctx.wf.step = 'evaluated';
  const cards = cardsOf(ctx.snap);
  const rawCard = cards.find((c) => c.cardRef === txn.cardRef) ?? null;
  // A block confirmed earlier in this call supersedes the (older) snapshot status.
  const card = rawCard && rawCard.status === 'active' && cardConfirmedBlocked(ctx.snap, ctx.customerId, rawCard.cardRef) ? { ...rawCard, status: 'blocked' as const } : rawCard;
  const alerts = (sourceData(ctx.snap, 'fraud_alerts') ?? []).filter((a) => a.transactionId === txn.transactionId);
  const prior = (sourceData(ctx.snap, 'prior_cases') ?? []).filter((c) => c.transactionRefs.includes(txn.transactionId));
  const active = activeDisputeTxnIds(ctx.customerId);
  const rules = sourceData(ctx.snap, 'dispute_rules') ?? [];

  const findings: Finding[] = [
    { kind: 'confirmed', text: `Transaction: ${describeTxn(txn, cards)}.`, source: 'transactions' },
    card ? { kind: 'confirmed', text: `Card ending ${card.last4} is currently ${card.status}.`, source: 'card_status' } : { kind: 'unavailable', text: 'The card for this transaction could not be identified.', source: 'card_status' },
  ];
  if (sourceData(ctx.snap, 'fraud_alerts'))
    findings.push(
      alerts.length
        ? { kind: 'confirmed', text: `The fraud system had already flagged this transaction (${alerts[0].alertType.replace(/_/g, ' ')}, ${alerts[0].riskLevel} risk).`, source: 'fraud_alerts' }
        : { kind: 'confirmed', text: 'The fraud system has no alert for this transaction.', source: 'fraud_alerts' },
    );
  else findings.push({ kind: 'unavailable', text: 'Fraud alerts could not be checked.', source: 'fraud_alerts' });
  findings.push(
    prior.length
      ? { kind: 'confirmed', text: `Previous case(s) mention this transaction: ${prior.map((p) => p.caseId).join(', ')}.`, source: 'prior_cases' }
      : { kind: 'confirmed', text: 'No previous case or dispute exists for this transaction.', source: 'prior_cases' },
  );

  if (active.includes(txn.transactionId)) {
    return {
      kind: 'inform',
      message: `There's already an active dispute for the ${formatMoney(txn.amountMinor)} charge at ${txn.merchant}, so I haven't opened another one. The disputes team is handling it and will contact you with the outcome.`,
      findings,
      resolution: 'informational',
      nextSteps: 'Existing dispute in progress; no new action taken.',
      transactionRefs: [txn.transactionId],
    };
  }

  const elig = fraudDisputeEligibility({ txn, rules, priorCases: prior, activeDisputeTxnIds: active, card });
  findings.push(
    elig.eligible
      ? { kind: 'confirmed', text: `Eligible for a fraud dispute under rule ${elig.ruleCode} (${elig.ruleVersion}).`, source: 'dispute_rules' }
      : { kind: 'confirmed', text: `Not eligible for an automated dispute under rule ${elig.ruleCode ?? 'n/a'}: ${elig.reasons.join(' ')}`, source: 'dispute_rules' },
  );
  const needsBlock = !!card && card.status === 'active' && !opts.cardAlreadyHandled;
  const actions: ProposedAction[] = [];
  if (needsBlock && card) {
    actions.push({ type: 'block_card', targetRef: card.cardRef, params: { reason: 'fraud' }, label: `Block card ending ${card.last4}` });
    actions.push({ type: 'order_replacement', targetRef: card.cardRef, params: { deliveryAddress: 'address_on_file' }, label: `Send a replacement card to your address on file`, requires: 'block_card' });
  }
  const factLines = findings.filter((f) => f.kind === 'confirmed').map((f) => `• ${f.text}`).join('\n');

  if (elig.eligible && card) {
    actions.push({ type: 'submit_dispute', targetRef: txn.transactionId, params: {}, label: `Submit a fraud dispute for ${formatMoney(txn.amountMinor)} at ${txn.merchant}`, requires: needsBlock ? 'block_card' : undefined });
    const list = actions.map((a, i) => `${i + 1}) ${a.label}`).join('\n');
    return {
      kind: 'propose',
      message: `Thanks${ctx.firstName ? `, ${ctx.firstName}` : ''}. Here's what our systems confirm:\n${factLines}\n\nI recommend:\n${list}\n\n${needsBlock ? 'Blocking stops all further use of this card, including by you, until the replacement arrives. ' : ''}Shall I go ahead? You can say yes, no, or ask for an agent.`,
      actions,
      findings,
      ruleRefs: [elig.ruleCode!],
      transactionRefs: [txn.transactionId],
      eligibility: elig,
      dispute: { txnId: txn.transactionId, reason: 'fraud_unrecognised', evidence: [{ type: 'customer_statement', description: 'Customer states they did not make or authorise this transaction.' }] },
    };
  }

  if (actions.length) {
    // Not automatable, but protecting the card is still appropriate for a suspected fraud.
    ctx.wf.step = 'protective_block';
    return {
      kind: 'propose',
      message: `Here's what our systems confirm:\n${factLines}\n\nI can't file the dispute myself because: ${elig.reasons.join(' ')} To protect you now, I can:\n${actions.map((a, i) => `${i + 1}) ${a.label}`).join('\n')}\n\nAfter that, ${txn.status === 'pending' ? 'the charge can be disputed once it posts — I will note this on your case.' : 'I will transfer you to a specialist for the investigation.'} Shall I go ahead?`,
      actions,
      findings,
      ruleRefs: elig.ruleCode ? [elig.ruleCode] : [],
      transactionRefs: [txn.transactionId],
      eligibility: elig,
    };
  }
  return {
    kind: 'inform',
    message: `Here's what our systems confirm:\n${factLines}\n\nI'm not able to open an automated dispute because: ${elig.reasons.join(' ')}`,
    findings,
    resolution: 'unresolved',
    nextSteps: 'Customer offered transfer to an agent for an investigation.',
    transactionRefs: [txn.transactionId],
    eligibility: elig,
    offerAgent: offerAgent('out_of_policy', 'An agent can look into this further. Would you like me to transfer you?'),
  };
}

export const unrecognisedWorkflow: Workflow = {
  start(ctx) {
    const guard = sourceGuard(ctx.snap, 'unrecognised_transaction');
    if (guard) return guard;
    const txns = purchases(ctx);
    if (ctx.wf.selectedTxnId) {
      const t = txns.find((x) => x.transactionId === ctx.wf.selectedTxnId);
      if (t) return evaluateUnrecognised(ctx, t);
    }
    const scored = matchTransactions(txns, ctx.slots, ctx.statement);
    const best = uniqueBest(scored);
    if (best) return evaluateUnrecognised(ctx, best.txn);
    ctx.wf.step = 'choose_txn';
    if (scored.length) {
      return { kind: 'clarify', purpose: 'choose_txn', message: 'I found more than one charge that could match. Which one don’t you recognise?', choices: txnChoices(scored.map((s) => s.txn)) };
    }
    const alerted = new Set((sourceData(ctx.snap, 'fraud_alerts') ?? []).filter((a) => a.status === 'open').map((a) => a.transactionId));
    const candidates = [...txns.filter((t) => alerted.has(t.transactionId)), ...txns.filter((t) => !alerted.has(t.transactionId))];
    return { kind: 'clarify', purpose: 'choose_txn', message: 'Which of these recent charges don’t you recognise?', choices: txnChoices(candidates) };
  },
  onChoice(ctx, purpose, id) {
    if (purpose === 'choose_txn') {
      if (id === 'none') {
        ctx.wf.clarifications++;
        ctx.wf.step = 'describe_txn';
        return { kind: 'clarify', purpose: 'describe_txn', message: 'No problem. Could you tell me the merchant name, the amount, or roughly when the charge happened?' };
      }
      const t = purchases(ctx).find((x) => x.transactionId === id);
      if (t) return evaluateUnrecognised(ctx, t);
    }
    return this.start(ctx);
  },
  onFreeText(ctx, purpose, _text) {
    // Slots were already updated by the orchestrator from the new text.
    const scored = matchTransactions(purchases(ctx), ctx.slots, ctx.statement);
    const best = uniqueBest(scored);
    if (best) return evaluateUnrecognised(ctx, best.txn);
    if (scored.length && ctx.wf.clarifications < 2) {
      ctx.wf.clarifications++;
      return { kind: 'clarify', purpose: 'choose_txn', message: 'Is it one of these?', choices: txnChoices(scored.map((s) => s.txn)) };
    }
    return {
      kind: 'handoff',
      reason: 'ai_uncertain',
      detail: `could not identify the transaction (${purpose})`,
      message: "I couldn't find a charge matching those details in your recent transactions, and I don't want to guess. I'm transferring you to an agent who can search further, and I've passed on what you told me.",
      findings: [{ kind: 'unavailable', text: 'The transaction described by the customer could not be matched to a record.', source: 'transactions' }],
      missing: ['transaction identification'],
    };
  },
  onYesNo(ctx, purpose, yes) {
    if (purpose === 'confirm_txn' && yes && ctx.wf.selectedTxnId) {
      const t = purchases(ctx).find((x) => x.transactionId === ctx.wf.selectedTxnId);
      if (t) return evaluateUnrecognised(ctx, t);
    }
    return this.start(ctx);
  },
  afterActions(ctx, ops) {
    const block = opByType(ops, 'block_card');
    const dispute = opByType(ops, 'submit_dispute');
    const t = (sourceData(ctx.snap, 'transactions') ?? []).find((x) => x.transactionId === ctx.wf.selectedTxnId);
    if (block && block.status === 'failed') {
      return {
        kind: 'handoff', reason: 'action_failed', detail: `card block failed (${block.error_code})`, priority: 'urgent', findings: [],
        message: 'Because your card is NOT blocked yet, I’m transferring you to an agent urgently so they can block it manually. They will see everything we’ve covered.',
      };
    }
    if (ctx.wf.step === 'protective_block' && t && t.status !== 'pending') {
      return {
        kind: 'handoff', reason: 'out_of_policy', detail: 'dispute requires specialist investigation', findings: [],
        message: 'I’m now transferring you to a specialist who can open the investigation into this charge. They’ll see everything we’ve covered.',
      };
    }
    const allDone = ops.every((o) => o.status === 'succeeded');
    const nextBits: string[] = [];
    if (dispute?.status === 'succeeded') nextBits.push('The disputes team will review the claim and contact you with the outcome.');
    if (opByType(ops, 'order_replacement')?.status === 'succeeded') nextBits.push('Your replacement card will be sent to your address on file. The card system did not provide a delivery date, so I can’t give you one.');
    if (ctx.wf.step === 'protective_block' && t?.status === 'pending') nextBits.push(`Once the ${formatMoney(t.amountMinor)} charge posts, it can be disputed — this is noted on your case.`);
    return {
      kind: 'inform',
      message: nextBits.join(' '),
      findings: [],
      resolution: allDone ? 'resolved' : 'partially_resolved',
      nextSteps: nextBits.join(' ') || 'Follow up on actions that were not confirmed.',
      transactionRefs: ctx.wf.selectedTxnId ? [ctx.wf.selectedTxnId] : [],
    };
  },
  onDeclined(ctx) {
    const t = (sourceData(ctx.snap, 'transactions') ?? []).find((x) => x.transactionId === ctx.wf.selectedTxnId);
    return {
      kind: 'inform',
      message: `Okay, I haven't made any changes.${t ? ` The ${formatMoney(t.amountMinor)} charge from ${formatDate(t.transactedAt)} is noted on your case if you want to come back to it.` : ''}`,
      findings: [],
      resolution: 'unresolved',
      nextSteps: 'Customer declined the proposed actions; no changes made.',
      offerAgent: offerAgent('customer_accepted_offer', 'Would you like to talk it through with an agent instead?'),
    };
  },
};
