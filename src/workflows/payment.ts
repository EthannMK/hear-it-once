/** Workflow: PAYMENT NOT SHOWING (BRD §6.3). Never invents a posting date. */
import type { PaymentRecord } from '../adapters/types.ts';
import { sourceData } from '../retrieval/retrieval.ts';
import type { Finding } from '../cases/case-service.ts';
import { formatDate, formatMoney } from '../conversation/format.ts';
import { offerAgent, sourceGuard } from './common.ts';
import { nowMs } from '../lib/clock.ts';
import type { Workflow, WorkflowCtx, WorkflowResult } from './types.ts';

const DETAIL: Record<string, string> = {
  received_awaiting_settlement: 'it has been received and is waiting to settle',
  under_investigation_trace_requested: 'a trace has been requested with the sending bank and is still open',
};

function describe(p: PaymentRecord): string {
  return `${formatMoney(p.amountMinor, p.currency)} by ${p.channel.replace(/_/g, ' ')} from ${p.sourceAccountMasked}, initiated ${formatDate(p.initiatedAt)}`;
}

function evaluate(ctx: WorkflowCtx): WorkflowResult {
  const pays = sourceData(ctx.snap, 'payment_status') ?? [];
  const recent = pays.filter((p) => nowMs() - Date.parse(p.initiatedAt) <= 30 * 86_400_000);
  const recurring = !!ctx.wf.recurring;
  if (!recent.length) {
    return {
      kind: 'inform',
      message: "I can't see any payment to your card account in the last 30 days in the payment system. If you paid from another bank, it may not have reached us yet, or it may have been sent to a different account.",
      findings: [{ kind: 'confirmed', text: 'Payment system shows no payment initiated in the last 30 days.', source: 'payment_status' }],
      resolution: 'unresolved',
      nextSteps: 'No payment found; customer advised to check with sending bank; agent offered.',
      offerAgent: offerAgent('out_of_policy', 'An agent can help trace it. Would you like me to transfer you?'),
    };
  }
  const byAmount = ctx.slots.amountMinor ? recent.filter((p) => p.amountMinor === ctx.slots.amountMinor) : [];
  const p = byAmount[0] ?? recent.find((x) => x.status !== 'posted') ?? recent[0];
  ctx.wf.selectedPaymentId = p.paymentId;
  const findings: Finding[] = [{ kind: 'confirmed', text: `Payment ${describe(p)} — status "${p.status}" (as of ${formatDate(p.statusAsOf)}).`, source: 'payment_status' }];
  if (ctx.slots.amountMinor && !byAmount.length) findings.push({ kind: 'inferred', text: `No payment of exactly ${formatMoney(ctx.slots.amountMinor)} found; showing the most relevant recent payment.`, source: 'payment_status' });

  let message: string;
  let resolution: 'informational' | 'unresolved' = 'informational';
  let offer: ReturnType<typeof offerAgent> | undefined;
  if (p.status === 'posted') {
    message = `Good news: the payment of ${formatMoney(p.amountMinor)} posted to your card account on ${formatDate(p.postedAt!)}.`;
  } else if (p.status === 'pending') {
    const why = p.statusDetail && DETAIL[p.statusDetail] ? ` — ${DETAIL[p.statusDetail]}` : '';
    const when = p.expectedPostingDate
      ? ` The payment system shows an expected posting date of ${formatDate(p.expectedPostingDate)}.`
      : " The payment system hasn't given a posting date, so I can't promise when it will appear.";
    message = `I can see your payment of ${formatMoney(p.amountMinor)} from ${formatDate(p.initiatedAt)}. It's showing as pending${why}.${when}`;
    findings.push(
      p.expectedPostingDate
        ? { kind: 'confirmed', text: `Expected posting date supplied by payment system: ${formatDate(p.expectedPostingDate)}.`, source: 'payment_status' }
        : { kind: 'unavailable', text: 'No posting date was supplied by the payment system.', source: 'payment_status' },
    );
  } else {
    message = `The payment of ${formatMoney(p.amountMinor)} from ${formatDate(p.initiatedAt)} shows as ${p.status}${p.statusDetail ? ` (${p.statusDetail.replace(/_/g, ' ')})` : ''}, which means it has not been applied to your account.`;
    resolution = 'unresolved';
    offer = offerAgent('out_of_policy', 'An agent can look into this with you. Would you like me to transfer you?');
  }
  if (recurring && p.status !== 'posted') {
    resolution = 'unresolved';
    message += ' I can see this is the second time you’ve contacted us about this and it’s still not resolved, so I’ve flagged your case as a recurring issue.';
    offer = offerAgent('customer_accepted_offer', 'Would you like me to transfer you to a payments specialist now?');
  }
  return {
    kind: 'inform',
    message,
    findings,
    resolution,
    nextSteps: p.status === 'posted' ? 'Payment posted; no action needed.' : p.status === 'pending' ? 'Payment pending; no posting date available from payment system.' : 'Payment not applied; agent follow-up offered.',
    offerAgent: offer,
  };
}

export const paymentWorkflow: Workflow = {
  start(ctx) {
    return sourceGuard(ctx.snap, 'payment_not_showing') ?? evaluate(ctx);
  },
  onChoice: (ctx) => evaluate(ctx),
  onFreeText: (ctx) => evaluate(ctx),
  onYesNo: (ctx) => evaluate(ctx),
  afterActions: () => ({ kind: 'inform', message: '', findings: [], resolution: 'informational', nextSteps: '' }),
  onDeclined: () => ({ kind: 'inform', message: 'Okay.', findings: [], resolution: 'informational', nextSteps: '' }),
};
