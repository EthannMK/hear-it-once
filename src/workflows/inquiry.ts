/**
 * Workflow: ACCOUNT ENQUIRY (read-only). Answers "is my card active?", "what were my last
 * charges?" and similar questions strictly from the verified card and transaction records.
 * Nothing is changed, and anything not in the records (balances, limits) is said to be unavailable.
 */
import { sourceData } from '../retrieval/retrieval.ts';
import type { Finding } from '../cases/case-service.ts';
import { formatDate, formatMoney } from '../conversation/format.ts';
import { cardsOf, matchTransactions, sourceGuard } from './common.ts';
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
    const slots = ctx.slots;
    const gave = slots.amountMinor != null || !!slots.merchantHint;
    if (ctx.readoutOk) {
      // Read aloud only after the second check and the customer's spoken confirmation.
      const last = txns.slice(0, 3);
      if (last.length) {
        parts.push(`Your most recent purchases are ${last.map((t) => `${formatMoney(t.amountMinor, t.currency)} at ${t.merchant} on ${formatDate(t.transactedAt)}${t.status === 'pending' ? ' (pending)' : ''}`).join('; ')}.`);
        findings.push({ kind: 'confirmed', text: `Most recent purchases read out after the second-level check and the customer's confirmation: ${last.map((t) => `${formatMoney(t.amountMinor, t.currency)} at ${t.merchant}`).join(', ')}.`, source: 'transactions' });
      } else {
        parts.push("I don't see any recent purchases on the account.");
        findings.push({ kind: 'confirmed', text: 'No recent purchases found in transaction history.', source: 'transactions' });
      }
    } else if (gave) {
      // Match what the customer described; say whether it matches, not what else is on the account.
      const scored = matchTransactions(txns, slots, ctx.statement);
      const both = slots.amountMinor != null && !!slots.merchantHint;
      const full = scored.find((s) => (both ? s.merchantMatch && s.amountMatch : s.merchantMatch || s.amountMatch));
      if (full) {
        parts.push(`Yes, I can see a charge that matches what you described, dated ${formatDate(full.txn.transactedAt)}${full.txn.status === 'pending' ? ' and still pending' : ''}.`);
        findings.push({ kind: 'confirmed', text: `A charge matching the customer's description (${[slots.merchantHint, slots.amountMinor != null ? formatMoney(slots.amountMinor) : null].filter(Boolean).join(', ')}) exists in the records.`, source: 'transactions' });
      } else if (scored.length) {
        parts.push("I can see something close, but it doesn't match everything you told me. Can you check the amount and the name on the charge and tell me again?");
        findings.push({ kind: 'confirmed', text: 'A partial match exists for the details the customer gave; they were asked to recheck.', source: 'transactions' });
      } else {
        parts.push("I can't find a charge that matches that. Please check the name, amount and date, and tell me again. I'd rather not guess.");
        findings.push({ kind: 'confirmed', text: "No charge matches the details the customer gave.", source: 'transactions' });
      }
    } else if (!status) {
      ctx.wf.detailAsks = (ctx.wf.detailAsks ?? 0) + 1;
      return {
        kind: 'clarify',
        purpose: 'inquiry:detail',
        message: ctx.wf.detailAsks > 1
          ? "I still can't list your activity without the extra check. You can name a shop or an amount and I'll check it, or say \"read them out\" and I'll ask for the one more check."
          : "For your privacy I don't read out account activity on my own. Tell me the shop or the amount of the charge you're asking about, and I'll check it against your records. If you'd rather I read your recent purchases, I need one more security check first.",
        findings: [{ kind: 'confirmed', text: 'The customer asked about transactions without naming one; nothing was disclosed. Offered to check a described charge, or to read out after a second-level check.', source: 'transactions' }],
      };
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
