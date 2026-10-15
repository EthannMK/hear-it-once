/** Shared workflow helpers: source guards, transaction matching, plain-language facts. */
import type { CardSummary, Transaction } from '../adapters/types.ts';
import { policy, type IssueType, type SourceName } from '../config/policy.ts';
import { assessSources, sourceData, type Snapshot } from '../retrieval/retrieval.ts';
import { normaliseMerchant } from '../ai/parsers.ts';
import type { IssueSlots } from '../ai/intent.ts';
import type { Finding } from '../cases/case-service.ts';
import { formatDate, formatMoney } from '../conversation/format.ts';
import type { Operation } from '../actions/action-service.ts';
import type { Choice, WorkflowResult } from './types.ts';

export const SOURCE_LABELS: Record<SourceName, string> = {
  customer_profile: 'customer profile',
  card_status: 'card system',
  transactions: 'transaction history',
  fraud_alerts: 'fraud alerts',
  prior_cases: 'previous cases',
  dispute_rules: 'dispute rules',
  payment_status: 'payment system',
  fee_policy: 'fee system',
  card_declines: 'card authorisation system',
};

const ENTRY: Record<string, string> = {
  ecommerce: 'online purchase',
  chip_pin: 'chip and PIN',
  chip: 'chip',
  contactless: 'contactless',
  recurring: 'recurring payment',
  swipe: 'swiped',
  manual: 'manually keyed',
};

export function describeTxn(t: Transaction, cards: CardSummary[]): string {
  const card = cards.find((c) => c.cardRef === t.cardRef);
  return `${formatMoney(t.amountMinor, t.currency)} at ${t.merchant ?? 'unknown merchant'} on ${formatDate(t.transactedAt)}${card ? `, card ending ${card.last4}` : ''} — ${t.status}${t.entryMode ? `, ${ENTRY[t.entryMode] ?? t.entryMode}` : ''}`;
}

export const txnChoiceLabel = (t: Transaction) => `${formatMoney(t.amountMinor, t.currency)} · ${t.merchant} · ${formatDate(t.transactedAt)}${t.status === 'pending' ? ' (pending)' : ''}`;

/**
 * Guard: required sources must be available, fresh and conflict-free before ANY decision.
 * Returns a handoff result when unsafe.
 */
export function sourceGuard(snap: Snapshot, issue: IssueType): WorkflowResult | null {
  const required = policy().requiredSourcesByIssue[issue];
  const s = assessSources(snap, required);
  if (s.safe) return null;
  const findings: Finding[] = [];
  for (const u of s.unavailable) findings.push({ kind: 'unavailable', text: `The ${SOURCE_LABELS[u]} could not be reached (${snap.sources[u]?.status ?? 'not queried'}).`, source: u });
  for (const u of s.stale) findings.push({ kind: 'unavailable', text: `The ${SOURCE_LABELS[u]} returned out-of-date information (as of ${snap.sources[u]?.asOf}).`, source: u });
  for (const c of s.conflicting) findings.push({ kind: 'unavailable', text: `Conflicting records: ${c.detail}`, source: c.sources.join('+') });
  if (s.conflicting.length) {
    return {
      kind: 'handoff',
      reason: 'conflicting_data',
      detail: s.conflicting.map((c) => c.type).join(', '),
      message:
        "I've checked our systems, but two of them are giving me different information about your account, so I can't safely make a decision or change anything. I'm transferring you to an agent who can resolve this, and I've passed on everything I found so you won't need to repeat yourself.",
      findings,
      priority: 'urgent',
    };
  }
  const names = [...s.unavailable, ...s.stale].map((x) => SOURCE_LABELS[x]).join(' and ');
  return {
    kind: 'handoff',
    reason: 'system_unavailable',
    detail: `unavailable: ${s.unavailable.join(',') || '-'}; stale: ${s.stale.join(',') || '-'}`,
    message: `I'm sorry — I can't get reliable information from our ${names || 'systems'} right now, so I can't safely complete this for you. Nothing has been changed on your account. I'm transferring you to an agent and passing on what I've already checked.`,
    findings,
    missing: [...s.unavailable, ...s.stale].map((x) => SOURCE_LABELS[x]),
  };
}

export interface ScoredTxn {
  txn: Transaction;
  score: number;
  merchantMatch: boolean;
  amountMatch: boolean;
  dateMatch: boolean;
}

/** Score transactions against what the caller said. Evidence must be positive, never assumed. */
export function matchTransactions(txns: Transaction[], slots: IssueSlots, statement: string): ScoredTxn[] {
  const stmt = normaliseMerchant(statement);
  const hint = slots.merchantHint ? normaliseMerchant(slots.merchantHint) : null;
  return txns
    .filter((t) => (t.kind === 'purchase' || t.kind === 'cash_advance') && t.merchant)
    .map((t) => {
      const m = normaliseMerchant(t.merchant!);
      const firstWord = normaliseMerchant(t.merchant!.split(/\s+/)[0]);
      const merchantMatch =
        (!!hint && hint.length >= 3 && (m.includes(hint) || hint.includes(m) || (firstWord.length >= 4 && hint.includes(firstWord)))) ||
        (firstWord.length >= 4 && stmt.includes(firstWord)) ||
        (m.length >= 4 && stmt.includes(m));
      const amountMatch = slots.amountMinor != null && Math.abs(t.amountMinor - slots.amountMinor) <= 1;
      const d = t.transactedAt.slice(0, 10);
      const dateMatch = !!slots.dateRange && d >= slots.dateRange.from && d <= slots.dateRange.to;
      const score = (merchantMatch ? 3 : 0) + (amountMatch ? 3 : 0) + (dateMatch ? 1 : 0);
      return { txn: t, score, merchantMatch, amountMatch, dateMatch };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || Date.parse(b.txn.transactedAt) - Date.parse(a.txn.transactedAt));
}

/** A unique best match requires merchant or amount evidence and no tie. */
export function uniqueBest(scored: ScoredTxn[]): ScoredTxn | null {
  if (!scored.length) return null;
  const [a, b] = scored;
  if (!(a.merchantMatch || a.amountMatch)) return null;
  if (b && b.score === a.score) return null;
  return a;
}

export function txnChoices(txns: Transaction[], max = 4): Choice[] {
  return [...txns.slice(0, max).map((t) => ({ id: t.transactionId, label: txnChoiceLabel(t) })), { id: 'none', label: 'None of these' }];
}

/**
 * FP-01, minimum disclosure. A caller who has named nothing is never shown what is on the account:
 * a list of merchants and amounts is exactly what someone calling to harvest data is after, and it
 * is worth as much to them as a stolen statement. The caller states the charge, the bank confirms
 * it. All the caller is told is how much there is to look through, which identifies nothing.
 */
export function askWhichCharge(txns: Transaction[], again = false): WorkflowResult {
  const n = txns.length;
  const scale = n === 0 ? 'I can’t see any recent card purchases to check.' : n === 1 ? 'I can see one recent card purchase.' : `I can see ${n} recent card purchases.`;
  return {
    kind: 'clarify',
    purpose: 'describe_txn',
    message: again
      ? 'Sorry, I couldn’t match that. Could you give me the amount, or the name on the statement, or roughly what day it was?'
      : `${scale} So I check the right one, could you tell me the amount, the merchant, or roughly when it happened?`,
  };
}

export function cardsOf(snap: Snapshot): CardSummary[] {
  return sourceData(snap, 'card_status') ?? [];
}

export function opByType(ops: Operation[], t: string): Operation | undefined {
  return ops.find((o) => o.action_type === t);
}

export const offerAgent = (reason: string, question = 'Would you like me to transfer you to an agent?') => ({ reason, question });
