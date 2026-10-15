/**
 * CALL FACTS — the structured memory of one call.
 *
 * Every piece of information the call depends on is held here with an explicit status and source,
 * so the back end (not the speech model) decides what is already known and what still has to be
 * asked. Status meanings:
 *   unknown        nothing captured yet
 *   provided       the customer said it; NOT checked against any bank system
 *   confirmed      a bank system returned it (or the customer confirmed a choice the system offered)
 *   verified       passed an identity / security check on the server
 *   conflicting    two sources disagree; a focused clarification or the authoritative source decides
 *   needs_clarification  captured but ambiguous or invalid
 *
 * Rules enforced here:
 * - A customer statement can never raise a fact to confirmed or verified.
 * - Confirmed/verified values are never overwritten by a customer statement; a differing customer
 *   value is recorded beside it and the fact is marked conflicting.
 * - A correction replaces the provided value and keeps the earlier value in history.
 * - Values are always redacted text: no full card number, passcode or date of birth is ever held.
 */
import { redactText } from '../lib/redact.ts';
import { nowIso } from '../lib/clock.ts';
import type { IssueSlots } from '../ai/intent.ts';
import { formatMoney, ISSUE_LABELS } from './format.ts';

export type FactStatus = 'unknown' | 'provided' | 'confirmed' | 'verified' | 'conflicting' | 'needs_clarification';
export type FactSource = 'customer' | 'bank_system' | 'verification' | 'workflow' | 'agent';

export type FactKey =
  | 'issue'
  | 'issue_type'
  | 'card_reference'
  | 'identity'
  | 'amount'
  | 'merchant'
  | 'date'
  | 'transaction'
  | 'consent'
  | 'resolution';

export interface Fact {
  value: string;
  status: FactStatus;
  source: FactSource;
  at: string;
  /** The customer's version when it disagrees with a confirmed/verified value. */
  customerValue?: string;
  history?: { value: string; status: FactStatus; source: FactSource; at: string; why: string }[];
}

export type Facts = Partial<Record<FactKey, Fact>>;

const RANK: Record<FactStatus, number> = { unknown: 0, needs_clarification: 1, provided: 2, conflicting: 3, confirmed: 4, verified: 5 };
const AUTHORITATIVE: FactStatus[] = ['confirmed', 'verified'];

export const FACT_LABELS: Record<FactKey, string> = {
  issue: 'What the customer reported',
  issue_type: 'Issue type',
  card_reference: 'Card',
  identity: 'Identity',
  amount: 'Amount',
  merchant: 'Merchant',
  date: 'Date',
  transaction: 'Transaction',
  consent: 'Consent',
  resolution: 'Outcome',
};

const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9.]/g, '');

/**
 * Record a value. Returns what happened so callers can react (e.g. ask one focused question on a conflict).
 * `correction` marks a customer saying "actually, it was ...": the provided value is replaced, history kept.
 */
export function setFact(
  facts: Facts,
  key: FactKey,
  rawValue: string,
  status: Exclude<FactStatus, 'unknown'>,
  source: FactSource,
  opts: { correction?: boolean; why?: string } = {},
): 'added' | 'unchanged' | 'updated' | 'conflict' | 'kept_authoritative' {
  const value = redactText(rawValue).trim().slice(0, 300);
  if (!value) return 'unchanged';
  const at = nowIso();
  const prev = facts[key];
  if (!prev) {
    facts[key] = { value, status, source, at };
    return 'added';
  }
  const same = norm(prev.value) === norm(value);
  const push = (why: string) => {
    prev.history = [...(prev.history ?? []), { value: prev.value, status: prev.status, source: prev.source, at: prev.at, why }].slice(-6);
  };

  // A customer statement never overrides what a bank system confirmed or a check verified.
  if (source === 'customer' && AUTHORITATIVE.includes(prev.status)) {
    if (same) return 'unchanged';
    prev.customerValue = value;
    if (prev.status !== 'verified') prev.status = 'conflicting';
    prev.at = at;
    return prev.status === 'conflicting' ? 'conflict' : 'kept_authoritative';
  }
  if (source === 'customer' && prev.status === 'conflicting') {
    // The customer restating a value while a conflict is open: keep their latest words beside it.
    prev.customerValue = value;
    prev.at = at;
    return 'conflict';
  }
  if (same && RANK[status] <= RANK[prev.status]) return 'unchanged';

  // A system result arriving for a value the customer gave: confirm it, or flag the difference.
  if (AUTHORITATIVE.includes(status) && prev.source === 'customer' && !same) {
    push('bank system returned a different value');
    facts[key] = { value, status: 'conflicting', source, at, customerValue: prev.value, history: prev.history };
    return 'conflict';
  }
  push(opts.why ?? (opts.correction ? 'customer corrected it' : same ? 'status raised' : 'updated'));
  facts[key] = { value, status, source, at, history: prev.history };
  return 'updated';
}

export function clearConflict(facts: Facts, key: FactKey, keep: 'system' | 'customer'): void {
  const f = facts[key];
  if (!f || f.status !== 'conflicting') return;
  if (keep === 'customer' && f.customerValue) {
    f.history = [...(f.history ?? []), { value: f.value, status: f.status, source: f.source, at: f.at, why: 'customer value kept' }];
    f.value = f.customerValue;
    f.status = 'provided';
    f.source = 'customer';
  } else {
    f.status = 'confirmed';
  }
  delete f.customerValue;
  f.at = nowIso();
}

/** Pull the details a customer gives in passing (amount, merchant, date, last four) into the facts. */
export function factsFromCustomerText(facts: Facts, slots: IssueSlots, opts: { correction?: boolean } = {}): string[] {
  const changed: string[] = [];
  const put = (key: FactKey, v: string | null | undefined) => {
    if (!v) return;
    const r = setFact(facts, key, v, 'provided', 'customer', opts);
    if (r !== 'unchanged') changed.push(`${key}:${r}`);
  };
  put('amount', slots.amountMinor != null ? formatMoney(slots.amountMinor) : null);
  put('merchant', slots.merchantHint);
  put('date', slots.dateRange?.label ?? null);
  put('card_reference', slots.cardLast4 ? `card ending ${slots.cardLast4}` : null);
  return changed;
}

export function setIssueFacts(facts: Facts, statement: string, issueType: string | null, confirmed: boolean): void {
  if (statement) setFact(facts, 'issue', statement, 'provided', 'customer');
  if (issueType) setFact(facts, 'issue_type', ISSUE_LABELS[issueType] ?? issueType, confirmed ? 'confirmed' : 'provided', confirmed ? 'workflow' : 'customer');
}

/** Facts already in hand, phrased for the voice model so it never asks for them again. */
export function knownForAssistant(facts: Facts | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!facts) return out;
  for (const [k, f] of Object.entries(facts) as [FactKey, Fact][]) {
    if (!f || f.status === 'unknown') continue;
    const tag =
      f.status === 'verified' ? 'verified' :
      f.status === 'confirmed' ? 'confirmed by the bank' :
      f.status === 'provided' ? 'customer said, not yet checked' :
      f.status === 'conflicting' ? `CONFLICT: bank has "${f.value}", customer said "${f.customerValue ?? '?'}"` :
      'unclear, ask one short question';
    out[k] = f.status === 'conflicting' ? tag : `${f.value} (${tag})`;
  }
  return out;
}

/** Facts for staff screens: label, value, status and where it came from. */
export function factRows(facts: Facts | undefined) {
  const order: FactKey[] = ['issue', 'issue_type', 'identity', 'card_reference', 'transaction', 'merchant', 'amount', 'date', 'consent', 'resolution'];
  return order.map((key) => {
    const f = facts?.[key];
    return {
      key,
      label: FACT_LABELS[key],
      value: f?.value ?? null,
      status: (f?.status ?? 'unknown') as FactStatus,
      source: f?.source ?? null,
      customerValue: f?.customerValue ?? null,
      history: (f?.history ?? []).map((x) => ({ value: x.value, status: x.status, at: x.at, why: x.why })),
      at: f?.at ?? null,
    };
  });
}
