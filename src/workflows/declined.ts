/**
 * Workflow: CARD DECLINED. Read-only. The assistant explains the reason the (simulated)
 * authorisation system recorded and changes nothing on the card; anything that needs a change,
 * such as a travel note, is offered to a human agent.
 */
import type { DeclineRecord } from '../adapters/types.ts';
import { sourceData } from '../retrieval/retrieval.ts';
import type { Finding } from '../cases/case-service.ts';
import { formatDate, formatMoney } from '../conversation/format.ts';
import { normaliseMerchant } from '../ai/parsers.ts';
import { nowMs } from '../lib/clock.ts';
import { offerAgent, sourceGuard } from './common.ts';
import type { Workflow, WorkflowCtx, WorkflowResult } from './types.ts';

const REASON: Record<DeclineRecord['reasonCode'], string> = {
  travel_security_rule: 'a travel security rule paused it, because a payment like that looked unusual for the card',
  insufficient_available_credit: 'there was not enough available credit at that moment',
  card_blocked: 'the card is blocked',
  card_expired: 'the card has expired',
  merchant_category_restricted: 'that type of merchant is restricted on the card',
};

function evaluate(ctx: WorkflowCtx): WorkflowResult {
  const all = sourceData(ctx.snap, 'card_declines') ?? [];
  const recent = all.filter((d) => nowMs() - Date.parse(d.declinedAt) <= 14 * 86_400_000);
  if (!recent.length) {
    return {
      kind: 'inform',
      message: "I can't see any declined payments on your card in the last two weeks. If a payment failed, it may not have reached us, or it may have been stopped by the merchant. I haven't changed anything on your card.",
      findings: [{ kind: 'confirmed', text: 'Authorisation system shows no declined payment in the last 14 days.', source: 'card_declines' }],
      resolution: 'unresolved',
      nextSteps: 'No decline found; agent offered.',
      offerAgent: offerAgent('out_of_policy', 'An agent can look at this with you. Would you like me to transfer you?'),
    };
  }
  const hint = ctx.slots.merchantHint ? normaliseMerchant(ctx.slots.merchantHint) : null;
  const d = (hint && recent.find((x) => normaliseMerchant(x.merchant).includes(hint))) || (ctx.slots.amountMinor ? recent.find((x) => x.amountMinor === ctx.slots.amountMinor) : undefined) || recent[0];
  const card = (sourceData(ctx.snap, 'card_status') ?? []).find((c) => c.cardRef === d.cardRef);
  const findings: Finding[] = [{ kind: 'confirmed', text: `Declined: ${formatMoney(d.amountMinor, d.currency)} at ${d.merchant} on ${formatDate(d.declinedAt)} — ${REASON[d.reasonCode]}.`, source: 'card_declines' }];
  if (card) findings.push({ kind: 'confirmed', text: `Card ending ${card.last4} is currently ${card.status}.`, source: 'card_status' });
  const needsAgent = d.reasonCode === 'travel_security_rule';
  const message =
    `I can see the payment of ${formatMoney(d.amountMinor, d.currency)} at ${d.merchant} that was declined on ${formatDate(d.declinedAt)}. The card system shows ${REASON[d.reasonCode]}.` +
    `${card ? ` Your card ending ${card.last4} is ${card.status} right now.` : ''} I haven't changed anything on your card.` +
    `${needsAgent ? ' I can\'t add a travel note myself, but an agent can.' : ''}`;
  return {
    kind: 'inform',
    message,
    findings,
    resolution: needsAgent ? 'unresolved' : 'informational',
    nextSteps: needsAgent ? 'Decline explained (travel security rule). No change made. Agent offered to add a travel note.' : 'Decline reason explained. No change made.',
    offerAgent: needsAgent ? offerAgent('customer_accepted_offer', 'Would you like me to connect you with an agent to sort out a travel note?') : undefined,
  };
}

export const declinedWorkflow: Workflow = {
  start(ctx) {
    return sourceGuard(ctx.snap, 'card_declined') ?? evaluate(ctx);
  },
  onChoice: (ctx) => evaluate(ctx),
  onFreeText: (ctx) => evaluate(ctx),
  onYesNo: (ctx) => evaluate(ctx),
  afterActions: () => ({ kind: 'inform', message: '', findings: [], resolution: 'informational', nextSteps: '' }),
  onDeclined: () => ({ kind: 'inform', message: 'Okay.', findings: [], resolution: 'informational', nextSteps: '' }),
};
