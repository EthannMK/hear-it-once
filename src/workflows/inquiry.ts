/**
 * Workflow: ACCOUNT ENQUIRY (read-only). Answers "is my card active?", "what were my last
 * charges?" and similar questions strictly from the verified card and transaction records.
 * Nothing is changed, and anything not in the records (balances, limits) is said to be unavailable.
 */
import { sourceData } from '../retrieval/retrieval.ts';
import type { Finding } from '../cases/case-service.ts';
import { formatDate, formatMoney } from '../conversation/format.ts';
import { cardsOf, sourceGuard } from './common.ts';
import type { Workflow, WorkflowCtx, WorkflowResult } from './types.ts';

const wantsStatus = (t: string) => /\b(status|active|blocked|working|frozen|locked|expire|expiry)\b/i.test(t);
const wantsTxns = (t: string) => /\b(transactions?|purchases?|charges?|spend|spent|activity|statement|history|recent)\b/i.test(t);

function answer(ctx: WorkflowCtx): WorkflowResult {
  const text = ctx.statement;
  const cards = cardsOf(ctx.snap);
  const txns = (sourceData(ctx.snap, 'transactions') ?? []).filter((t) => t.kind === 'purchase' && t.merchant).sort((a, b) => Date.parse(b.transactedAt) - Date.parse(a.transactedAt));
  const findings: Finding[] = [];
  const parts: string[] = [];
  const status = wantsStatus(text);
  const history = wantsTxns(text);
  if (status || !history) {
    for (const c of cards) {
      parts.push(`Your ${c.network} card ending ${c.last4} is ${c.status}${c.statusReason ? ` (${c.statusReason})` : ''}.`);
      findings.push({ kind: 'confirmed', text: `Card ending ${c.last4} is ${c.status}.`, source: 'card_status' });
    }
  }
  if (history || !status) {
    const last = txns.slice(0, 3);
    if (last.length) {
      parts.push(`Your most recent purchases are ${last.map((t) => `${formatMoney(t.amountMinor, t.currency)} at ${t.merchant} on ${formatDate(t.transactedAt)}${t.status === 'pending' ? ' (pending)' : ''}`).join('; ')}.`);
      findings.push({ kind: 'confirmed', text: `Most recent purchases: ${last.map((t) => `${formatMoney(t.amountMinor, t.currency)} at ${t.merchant}`).join(', ')}.`, source: 'transactions' });
    } else {
      parts.push("I don't see any recent purchases on the account.");
      findings.push({ kind: 'confirmed', text: 'No recent purchases found in transaction history.', source: 'transactions' });
    }
  }
  if (/\b(balance|available credit|limit)\b/i.test(text)) parts.push("I can't see balances or limits in this demo, so I won't guess a figure.");
  return {
    kind: 'inform',
    message: `${parts.join(' ')} I haven't changed anything on your account.`,
    findings,
    resolution: 'informational',
    nextSteps: 'Account information provided from verified records. No change made.',
  };
}

export const inquiryWorkflow: Workflow = {
  start: (ctx) => sourceGuard(ctx.snap, 'account_inquiry') ?? answer(ctx),
  onChoice: (ctx) => answer(ctx),
  onFreeText: (ctx) => answer(ctx),
  onYesNo: (ctx) => answer(ctx),
  afterActions: () => ({ kind: 'inform', message: '', findings: [], resolution: 'informational', nextSteps: '' }),
  onDeclined: () => ({ kind: 'inform', message: 'Okay.', findings: [], resolution: 'informational', nextSteps: '' }),
};
