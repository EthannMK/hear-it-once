/**
 * NORTHSTAR BANK DEMO PROFILES (SYNTHETIC).
 *
 * Five fictional customers for the judge screen. Choosing one sets the real, server-side active
 * customer for the call (caller-ID identification only, never proof of identity). It does NOT
 * pick a scripted problem: the caller says what they need and the back end looks it up.
 * Everything shown is read from the seeded demo database, never typed into the page.
 */
import { all, get } from '../db/db.ts';
import { SCENARIOS } from '../db/scenarios.ts';
import { nationalIdLast4 } from '../adapters/mock/identity.ts';
import { feeReversalEligibility } from '../policy/eligibility.ts';
import type { FeeData, FeeRecord } from '../adapters/types.ts';
import { formatMoney } from '../conversation/format.ts';

export const BANK_NAME = 'Northstar Bank';

export interface ProfileDef {
  id: string;
  scenarioId: string;
  blurb: string;
  /**
   * What this persona is useful for demonstrating. It describes the route through the assistant, not
   * the state of the account — the account's state is read from its records, because it changes
   * during a demo and anything written here would go stale the first time a fee is reversed.
   */
  tryPhrase: string;
}

export const PROFILE_DEFS: ProfileDef[] = [
  { id: 'alex-morgan', scenarioId: 'S01', blurb: 'Use for an unfamiliar charge and the fraud route.', tryPhrase: "There's a charge from Novaplay I don't recognise." },
  { id: 'jamie-tan', scenarioId: 'S19', blurb: 'Use for a declined payment and the travel rule.', tryPhrase: 'My card keeps getting declined.' },
  { id: 'tom-becker', scenarioId: 'S05', blurb: 'Use for a fee query and a courtesy reversal.', tryPhrase: 'Why was I charged a late fee?' },
  { id: 'priya-shah', scenarioId: 'S02', blurb: 'Use for a lost or stolen card and general questions.', tryPhrase: 'I lost my card.' },
  { id: 'lena-fischer', scenarioId: 'S08', blurb: 'Use for asking to speak to a person, and handover.', tryPhrase: 'I want to speak to a person.' },
];

export const profileById = (id: string) => PROFILE_DEFS.find((p) => p.id === id);

const DECLINE_LABEL: Record<string, string> = {
  travel_security_rule: 'travel security rule',
  insufficient_available_credit: 'not enough available credit',
  card_blocked: 'card blocked',
  card_expired: 'card expired',
  merchant_category_restricted: 'merchant category restricted',
};

/**
 * What a judge is told about an account is read from the same records the assistant reads, never
 * written by hand. A typed sentence drifts the moment the data behind it changes — a fee that has
 * since been reversed, a courtesy reversal already used this year, a merchant renamed in BigQuery —
 * and a judge who is told the fee is reversible and then hears otherwise reads that as the assistant
 * being wrong. The eligibility line therefore comes from the policy rule itself, so the page and the
 * call cannot disagree.
 */
function feeSentence(customerId: string, standing: 'good' | 'delinquent' | 'closed'): string[] {
  const fees = all<Record<string, unknown>>('SELECT * FROM bank_fees WHERE customer_id = ? ORDER BY charged_at DESC', [customerId]).map((f) => ({
    feeId: String(f.id),
    feeType: String(f.fee_type),
    amountMinor: Number(f.amount_minor),
    currency: String(f.currency ?? 'USD'),
    chargedAt: String(f.charged_at),
    reversedAt: (f.reversed_at as string | null) ?? null,
    transactionId: (f.transaction_id as string | null) ?? null,
  })) as FeeRecord[];
  if (!fees.length) return [];
  const policies = all<Record<string, unknown>>('SELECT * FROM bank_fee_policies').map((x) => ({
    ruleCode: String(x.rule_code), feeType: String(x.fee_type), reversible: Boolean(x.reversible), description: String(x.description), version: String(x.version),
  }));
  const yearAgo = new Date(Date.now() - 365 * 86_400_000).toISOString();
  const data: FeeData = {
    fees,
    policies,
    reversalsLast12Months: fees.filter((f) => f.reversedAt && f.reversedAt >= yearAgo).length,
    accountStanding: standing,
    latePaymentsLast12Months: fees.filter((f) => f.feeType === 'late_payment' && f.chargedAt >= yearAgo).length,
  };
  return fees.slice(0, 2).map((fee) => {
    const label = fee.feeType.replace(/_/g, ' ');
    const money = formatMoney(fee.amountMinor);
    if (fee.reversedAt) return `A ${money} ${label} was charged and has already been reversed.`;
    const elig = feeReversalEligibility({ fee, data });
    return elig.eligible
      ? `A ${money} ${label} is open and qualifies for a courtesy reversal under ${elig.ruleCode ?? 'the fee policy'}.`
      : `A ${money} ${label} is open and does not qualify for a reversal: ${elig.reasons.join(' ')}`;
  });
}

/**
 * The phrase a judge is told to say. Where it names something from the data — the merchant on a
 * fraud alert, or the one that declined — it is taken from the record rather than the definition,
 * so copying it cannot start a call about a charge the account does not have.
 */
function phraseFor(def: ProfileDef, alerts: { merchant: string | null }[], declines: { merchant: string }[]): string {
  const alerted = alerts.find((a) => a.merchant)?.merchant;
  if (def.scenarioId === 'S01') return alerted ? `There's a charge from ${titleCase(alerted)} I don't recognise.` : def.tryPhrase;
  if (def.scenarioId === 'S19') return declines.length ? `My card was declined at ${titleCase(declines[0].merchant)}.` : def.tryPhrase;
  return def.tryPhrase;
}

/** Merchant names arrive upper-case from the ledger; a judge reads them aloud. */
const titleCase = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** The account's state in plain words, assembled from its own records. */
function situationFor(
  customerId: string,
  card: { status: string; status_reason: string | null } | null,
  standing: 'good' | 'delinquent' | 'closed',
  alerts: { merchant: string | null; amount: string }[],
  declines: { merchant: string; amount: string; reason: string }[],
): string {
  const parts: string[] = [card ? `Card ${card.status}${card.status !== 'active' && card.status_reason ? ` (${card.status_reason})` : ''}.` : 'No card on file.'];
  if (standing !== 'good') parts.push(`Account standing: ${standing}.`);
  for (const a of alerts) parts.push(`Open fraud alert on a ${a.amount} charge${a.merchant ? ` at ${a.merchant}` : ''}.`);
  parts.push(...feeSentence(customerId, standing));
  for (const d of declines) parts.push(`A ${d.amount} payment at ${d.merchant} was declined — ${d.reason}.`);
  if (parts.length === 1) parts.push('Nothing open on the account, so this one is good for general questions, a lost or stolen card, or asking for a person.');
  return parts.join(' ');
}

export function profileCard(def: ProfileDef) {
  const sc = SCENARIOS.find((s) => s.id === def.scenarioId)!;
  const cu = get<{ id: string; customer_number: string; full_name: string; account_standing: string }>('SELECT id, customer_number, full_name, account_standing FROM bank_customers WHERE id = ?', [sc.customer.id]);
  const card = get<{ id: string; demo_pan: string | null; last4: string; network: string; product: string; status: string; status_reason: string | null }>(
    "SELECT id, demo_pan, last4, network, product, status, status_reason FROM bank_cards WHERE customer_id = ? ORDER BY id LIMIT 1",
    [sc.customer.id],
  );
  const txns = all<{ merchant_name: string | null; amount_minor: number; txn_at: string; status: string; kind: string }>(
    "SELECT merchant_name, amount_minor, txn_at, status, kind FROM bank_transactions WHERE customer_id = ? AND kind IN ('purchase','fee') ORDER BY txn_at DESC LIMIT 6",
    [sc.customer.id],
  ).map((t) => ({ merchant: t.merchant_name ?? '—', amount: formatMoney(Math.abs(t.amount_minor)), at: t.txn_at.slice(0, 10), status: t.status, kind: t.kind }));
  const fees = all<{ fee_type: string; amount_minor: number; charged_at: string; reversed_at: string | null }>(
    'SELECT fee_type, amount_minor, charged_at, reversed_at FROM bank_fees WHERE customer_id = ? ORDER BY charged_at DESC',
    [sc.customer.id],
  ).map((f) => ({ type: f.fee_type.replace(/_/g, ' '), amount: formatMoney(f.amount_minor), at: f.charged_at.slice(0, 10), reversed: !!f.reversed_at }));
  const declines = all<{ merchant_name: string; amount_minor: number; declined_at: string; reason_code: string }>(
    'SELECT merchant_name, amount_minor, declined_at, reason_code FROM bank_declines WHERE customer_id = ? ORDER BY declined_at DESC LIMIT 3',
    [sc.customer.id],
  ).map((d) => ({ merchant: d.merchant_name, amount: formatMoney(d.amount_minor), at: d.declined_at.slice(0, 10), reason: DECLINE_LABEL[d.reason_code] ?? d.reason_code }));
  const alertRows = all<{ merchant_name: string | null; reported_amount_minor: number }>(
    "SELECT t.merchant_name, a.reported_amount_minor FROM bank_fraud_alerts a LEFT JOIN bank_transactions t ON t.id = a.transaction_id WHERE a.customer_id = ? AND a.status = 'open' ORDER BY a.created_at DESC",
    [sc.customer.id],
  ).map((a) => ({ merchant: a.merchant_name, amount: formatMoney(Math.abs(a.reported_amount_minor)) }));
  const alerts = alertRows.length;
  const restrictions: string[] = [];
  if (card && card.status !== 'active') restrictions.push(`Card is ${card.status}${card.status_reason ? ` (${card.status_reason})` : ''}`);
  if (cu && cu.account_standing !== 'good') restrictions.push(`Account standing: ${cu.account_standing}`);
  if (alerts) restrictions.push(`${alerts} open fraud alert${alerts > 1 ? 's' : ''} on the account`);
  for (const d of declines.filter((x) => x.reason === 'travel security rule')) restrictions.push(`Travel security rule declined a ${d.amount} payment at ${d.merchant}`);
  return {
    id: def.id,
    name: sc.customer.name,
    phone: sc.customer.phone,
    accountRef: cu?.customer_number ?? sc.customer.number,
    cardNumber: card?.demo_pan ?? null,
    cardLast4: card?.last4 ?? null,
    cardNetwork: card?.network ?? null,
    cardProduct: card?.product ?? null,
    cardStatus: card?.status ?? 'unknown',
    accountStanding: cu?.account_standing ?? 'good',
    blurb: def.blurb,
    tryPhrase: phraseFor(def, alertRows, declines),
    situation: situationFor(sc.customer.id, card ?? null, (cu?.account_standing ?? 'good') as 'good', alertRows, declines),
    nrcLast4: nationalIdLast4(sc.customer.id),
    recentTransactions: txns,
    fees,
    declines,
    restrictions,
    synthetic: true,
  };
}

export const allProfileCards = () => PROFILE_DEFS.map(profileCard);
