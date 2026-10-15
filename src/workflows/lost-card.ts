/** Workflow: LOST OR STOLEN CARD (BRD §6.2, FR-09) — block first, details later. */
import { sourceData } from '../retrieval/retrieval.ts';
import { cardConfirmedBlocked } from '../policy/engine.ts';
import type { Finding } from '../cases/case-service.ts';
import { askWhichCharge, cardsOf, offerAgent, opByType } from './common.ts';
import { evaluateUnrecognised } from './unrecognised.ts';
import { nowMs } from '../lib/clock.ts';
import type { Workflow, WorkflowCtx, WorkflowResult } from './types.ts';

function proposeBlock(ctx: WorkflowCtx, cardRef: string): WorkflowResult {
  const card = cardsOf(ctx.snap).find((c) => c.cardRef === cardRef)!;
  ctx.wf.selectedCardRef = cardRef;
  ctx.wf.step = 'block';
  const reason = ctx.slots.lostOrStolen ?? 'lost';
  return {
    kind: 'propose',
    message: `Thanks${ctx.firstName ? `, ${ctx.firstName}` : ''}. The card system shows your card ending ${card.last4} is currently ${card.status}. I can block it right now — once blocked it can't be used by anyone, including you. Shall I block card ending ${card.last4} now?`,
    actions: [{ type: 'block_card', targetRef: cardRef, params: { reason }, label: `Block card ending ${card.last4}` }],
    findings: [{ kind: 'confirmed', text: `Card ending ${card.last4} (${card.holderRole} cardholder) is ${card.status}.`, source: 'card_status' }],
    ruleRefs: [],
    transactionRefs: [],
  };
}

function proposeReplacement(ctx: WorkflowCtx): WorkflowResult {
  const card = cardsOf(ctx.snap).find((c) => c.cardRef === ctx.wf.selectedCardRef)!;
  ctx.wf.step = 'replacement';
  return {
    kind: 'propose',
    message: `Would you like me to send a replacement for card ending ${card.last4} to your address on file?`,
    actions: [{ type: 'order_replacement', targetRef: card.cardRef, params: { deliveryAddress: 'address_on_file' }, label: `Send a replacement card to your address on file` }],
    findings: [],
    ruleRefs: [],
    transactionRefs: [],
  };
}

/** Purchases on the blocked card in the last two weeks: what a caller could plausibly be asked about. */
function recentPurchases(ctx: WorkflowCtx) {
  const since = nowMs() - 14 * 86_400_000;
  return (sourceData(ctx.snap, 'transactions') ?? []).filter((t) => t.kind === 'purchase' && t.cardRef === ctx.wf.selectedCardRef && Date.parse(t.transactedAt) >= since);
}

/**
 * The card is blocked and replaced; the remaining risk is a charge the thief already made. The
 * question says why it is being asked, and is skipped entirely when the card has no recent charges
 * to ask about, so no one is sent into a list that cannot help them.
 */
function askSuspicious(ctx: WorkflowCtx): WorkflowResult {
  if (!recentPurchases(ctx).length) {
    return {
      kind: 'inform',
      message: 'There are no recent charges on that card to check, so you’re all set. If anything you don’t recognise appears later, call us back and we can dispute it.',
      findings: [],
      resolution: 'resolved',
      nextSteps: 'Card blocked and replacement handled; no recent charges to review.',
    };
  }
  ctx.wf.step = 'suspicious_q';
  return {
    kind: 'ask_yes_no',
    purpose: 'suspicious_review',
    message: 'One last thing, since the card was out of your hands: have you noticed any charges on it that you don’t recognise?',
  };
}

export const lostCardWorkflow: Workflow = {
  start(ctx) {
    const profileOk = sourceData(ctx.snap, 'customer_profile');
    const cards = sourceData(ctx.snap, 'card_status');
    if (!profileOk || !cards || ctx.snap.sources.card_status?.stale) {
      return {
        kind: 'handoff', reason: 'system_unavailable', detail: 'card system unavailable for lost/stolen card', priority: 'urgent',
        message: "I'm sorry — I can't reach the card system right now, so I can't block your card myself. Nothing has been changed. I'm transferring you urgently to an agent who can block it for you.",
        findings: [{ kind: 'unavailable', text: 'The card system could not be reached, so the card status is unknown.', source: 'card_status' }],
        missing: ['card status'],
      };
    }
    const conflict = ctx.snap.conflicts.find((c) => c.type === 'card_status_mismatch');
    if (conflict) {
      return {
        kind: 'handoff', reason: 'conflicting_data', detail: conflict.detail, priority: 'urgent', findings: [{ kind: 'unavailable', text: conflict.detail, source: 'card_status+fraud_alerts' }],
        message: "Our systems disagree about your card's current status, so I can't safely act on it. I'm transferring you urgently to an agent who can confirm and block the card.",
      };
    }
    if (ctx.wf.selectedCardRef) return proposeBlock(ctx, ctx.wf.selectedCardRef);
    const active = cards.filter((c) => c.status === 'active');
    if (ctx.slots.cardLast4) {
      const hit = active.find((c) => c.last4 === ctx.slots.cardLast4);
      if (hit) return proposeBlock(ctx, hit.cardRef);
    }
    if (active.length === 1) return proposeBlock(ctx, active[0].cardRef);
    if (active.length > 1) {
      ctx.wf.step = 'choose_card';
      return { kind: 'clarify', purpose: 'choose_card', message: 'Which card is lost or stolen?', choices: active.map((c) => ({ id: c.cardRef, label: `Card ending ${c.last4} (${c.holderName}, ${c.holderRole})` })) };
    }
    const blocked = cards.find((c) => c.status === 'blocked');
    if (blocked) {
      ctx.wf.selectedCardRef = blocked.cardRef;
      const findings: Finding[] = [{ kind: 'confirmed', text: `Card ending ${blocked.last4} is already blocked.`, source: 'card_status' }];
      const r = proposeReplacement(ctx);
      return r.kind === 'propose' ? { ...r, findings, message: `Your card ending ${blocked.last4} is already blocked, so it can't be used. ${r.message}` } : r;
    }
    return { kind: 'handoff', reason: 'out_of_policy', detail: 'no active card found', message: "I can't find an active card on your account to block. I'm transferring you to an agent to check this with you.", findings: [] };
  },
  onChoice(ctx, purpose, id) {
    if (purpose === 'choose_card') {
      const card = cardsOf(ctx.snap).find((c) => c.cardRef === id && c.status === 'active');
      if (card) return proposeBlock(ctx, card.cardRef);
    }
    if (purpose === 'choose_txn') {
      if (id === 'none') return { kind: 'inform', message: 'Okay. If you spot anything later, call us back and we can dispute it.', findings: [], resolution: 'resolved', nextSteps: 'Card blocked; customer to report any suspicious transactions.' };
      const t = (sourceData(ctx.snap, 'transactions') ?? []).find((x) => x.transactionId === id);
      if (t) {
        ctx.wf.step = 'dispute';
        return evaluateUnrecognised(ctx, t, { cardAlreadyHandled: true });
      }
    }
    return this.start(ctx);
  },
  onYesNo(ctx, purpose, yes) {
    if (purpose === 'suspicious_review') {
      if (!yes) return { kind: 'inform', message: 'Good — then you’re all set.', findings: [], resolution: 'resolved', nextSteps: 'Card blocked and replacement handled; no suspicious transactions reported.' };
      const recent = recentPurchases(ctx);
      if (!recent.length)
        return {
          kind: 'inform',
          message: 'I can’t see any recent charges on that card, so there is nothing for me to dispute today. If one appears on your statement, call us back and we can take it from there.',
          findings: [],
          resolution: 'resolved',
          nextSteps: 'Card blocked and replaced; caller reported a concern but no recent charges were on the card.',
        };
      // FP-01: the caller says which charge; the card's recent activity is not read out to them.
      ctx.wf.step = 'describe_txn';
      return askWhichCharge(recent);
    }
    return this.start(ctx);
  },
  afterActions(ctx, ops) {
    const block = opByType(ops, 'block_card');
    if (block) {
      if (block.status === 'succeeded') return proposeReplacement(ctx);
      if (block.status === 'failed')
        return {
          kind: 'handoff', reason: 'action_failed', detail: `card block failed (${block.error_code})`, priority: 'urgent', findings: [],
          message: 'Because your card is NOT blocked, I’m transferring you to an agent urgently so they can block it manually. They’ll see everything we’ve covered so you won’t need to repeat yourself.',
        };
      return { kind: 'inform', message: '', findings: [], resolution: 'unresolved', nextSteps: 'Card block outcome not confirmed.' };
    }
    const rep = opByType(ops, 'order_replacement');
    if (rep) {
      if (rep.status === 'succeeded') return askSuspicious(ctx);
      return { kind: 'inform', message: 'I’ve noted on your case that the replacement still needs to be ordered.', findings: [], resolution: 'partially_resolved', nextSteps: 'Replacement card order not confirmed — agent follow-up.', offerAgent: offerAgent('action_failed') };
    }
    // A dispute chained from the suspicious-transaction review.
    const dispute = opByType(ops, 'submit_dispute');
    if (dispute) {
      return {
        kind: 'inform',
        message: dispute.status === 'succeeded' ? 'The disputes team will review it and contact you with the outcome.' : '',
        findings: [],
        resolution: dispute.status === 'succeeded' ? 'resolved' : 'partially_resolved',
        nextSteps: dispute.status === 'succeeded' ? 'Dispute submitted for review.' : 'Dispute not confirmed — follow up.',
        transactionRefs: ctx.wf.selectedTxnId ? [ctx.wf.selectedTxnId] : [],
      };
    }
    return { kind: 'inform', message: '', findings: [], resolution: 'partially_resolved', nextSteps: '' };
  },
  onDeclined(ctx) {
    if (ctx.wf.step === 'replacement') return askSuspicious(ctx);
    if (ctx.wf.step === 'block' && ctx.wf.selectedCardRef && !cardConfirmedBlocked(ctx.snap, ctx.customerId, ctx.wf.selectedCardRef)) {
      return {
        kind: 'inform',
        message: 'Okay, I haven’t blocked the card. If you can’t find it, please call back straight away so we can block it — anyone who has it could use it.',
        findings: [],
        resolution: 'unresolved',
        nextSteps: 'Customer declined card block. Card remains active.',
        offerAgent: offerAgent('customer_accepted_offer', 'Would you like to speak to an agent about it?'),
      };
    }
    return { kind: 'inform', message: 'Okay, no changes made.', findings: [], resolution: 'partially_resolved', nextSteps: 'Customer declined.' };
  },
};
