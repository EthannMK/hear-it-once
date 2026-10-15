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
import { formatMoney } from '../conversation/format.ts';

export const BANK_NAME = 'Northstar Bank';

export interface ProfileDef {
  id: string;
  scenarioId: string;
  blurb: string;
  /** A sentence a tester can say to start this customer's scenario. */
  tryPhrase: string;
  /** What is true of this customer's card and account, in plain words, so a tester picks the right one. */
  situation: string;
}

export const PROFILE_DEFS: ProfileDef[] = [
  { id: 'alex-morgan', scenarioId: 'S01', blurb: 'Has a recent online charge that may look unfamiliar.', tryPhrase: "There's a charge from Novaplay I don't recognise.", situation: 'Card active. Open fraud alert on a $249 NOVAPLAY DIGITAL online charge. Also a $84.50 CITYLINK RIDES charge.' },
  { id: 'jamie-tan', scenarioId: 'S19', blurb: 'Is travelling soon and had a card payment declined.', tryPhrase: 'My card keeps getting declined.', situation: 'Card active. A $189 EuroRail Booking payment was declined by the travel security rule.' },
  { id: 'tom-becker', scenarioId: 'S05', blurb: 'Was charged a late-payment fee.', tryPhrase: 'Why was I charged a late fee?', situation: 'Card active. A $29 late payment fee is eligible for one courtesy reversal. A $76 Metro Fuel payment was declined for low available credit.' },
  { id: 'priya-shah', scenarioId: 'S02', blurb: 'Everyday cardholder in good standing.', tryPhrase: 'I lost my card.', situation: 'Card active, no problems. Good for a lost or stolen card and for general questions.' },
  { id: 'lena-fischer', scenarioId: 'S08', blurb: 'Everyday cardholder; may prefer to speak to a person.', tryPhrase: 'I want to speak to a person.', situation: 'Card active, no problems. Good for asking for a person and for handover.' },
];

export const profileById = (id: string) => PROFILE_DEFS.find((p) => p.id === id);

const DECLINE_LABEL: Record<string, string> = {
  travel_security_rule: 'travel security rule',
  insufficient_available_credit: 'not enough available credit',
  card_blocked: 'card blocked',
  card_expired: 'card expired',
  merchant_category_restricted: 'merchant category restricted',
};

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
  const alerts = get<{ n: number }>("SELECT COUNT(*) n FROM bank_fraud_alerts WHERE customer_id = ? AND status = 'open'", [sc.customer.id])?.n ?? 0;
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
    tryPhrase: def.tryPhrase,
    situation: def.situation,
    nrcLast4: nationalIdLast4(sc.customer.id),
    recentTransactions: txns,
    fees,
    declines,
    restrictions,
    synthetic: true,
  };
}

export const allProfileCards = () => PROFILE_DEFS.map(profileCard);
