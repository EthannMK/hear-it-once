/**
 * CRM CASE WORKSPACE — read model and edits for the human agent.
 *
 * One case database: everything here is read from the same rows the call writes (cases, case
 * events, call facts, operations, disputes, handoffs, timeline, transcript). Nothing about a case
 * is typed into the page. The view keeps five things apart:
 *   confirmed facts (bank systems / verification) · what the customer said · AI suggestions ·
 *   actions waiting for someone · actions that completed, failed or have an unknown outcome.
 * Agent corrections (tags, status, notes), recommendation decisions and tickets are validated,
 * persisted and audited here. Accepting a suggestion records the agent's plan; it never runs a
 * banking action (those keep their own consent / approval checks).
 */
import { z } from 'zod';
import { all, get, parseJson, run, tx } from '../db/db.ts';
import { AppError } from '../lib/errors.ts';
import { nowIso } from '../lib/clock.ts';
import { newId } from '../lib/ids.ts';
import { redactText } from '../lib/redact.ts';
import { audit, type Actor } from '../audit/audit.ts';
import { readCheck } from '../verification/agent-check.ts';
import { emitTimeline, listTimeline } from '../events/timeline.ts';
import { caseEvent, updateCase } from '../cases/case-service.ts';
import { buildResolution } from '../api/brief.ts';
import { ACTION_LABELS, HANDOFF_REASON_LABELS, ISSUE_LABELS, formatDate, formatMoney } from '../conversation/format.ts';
import { factRows, setFact, type Facts } from '../conversation/facts.ts';
import type { CallContext } from '../conversation/orchestrator.ts';
import { SOURCE_DISPLAY } from '../retrieval/labels.ts';
import { PROFILE_DEFS } from '../live/profiles.ts';
import { SCENARIOS } from '../db/scenarios.ts';
import {
  CATEGORIES, ESCALATION_MAP, ESCALATION_REASONS, HIGH_VALUE_MINOR, ISSUE_MAP, ISSUE_TYPES, PRIORITIES, RESOLUTION_TYPES, STATUSES, STATUS_LABELS, TEAMS,
  type CrmStatus, type Priority,
} from '../config/taxonomy.ts';

type StaffActor = Actor & { id: string };

interface CaseRow {
  id: string; session_id: string; customer_id: string | null; issue_type: string | null; status: string; resolution_status: string | null; verification_outcome: string;
  customer_reported: string | null; transaction_refs_json: string; sources_checked_json: string; eligibility_json: string | null; summary: string | null; next_steps: string | null;
  previous_case_ids_json: string; recurring_issue: number; risk_flags_json: string; data_origin: string; created_at: string; updated_at: string; closed_at: string | null;
  agent_overrides_json: string | null; agent_notes: string | null;
}
interface SessionRow {
  id: string; channel: string; context_json: string; verification_status: string; outcome: string | null; ended_at: string | null; answered_at: string; issue_statement: string | null;
  profile_id: string | null; data_origin: string; customer_id: string | null;
}
interface OpRow { id: string; action_type: string; status: string; target_ref: string; external_ref: string | null; error_code: string | null; requested_at: string; completed_at: string | null }
interface HandoffRow { id: string; status: string; reason: string; reason_detail: string | null; agent_id: string | null; requested_at: string; connected_at: string | null; completed_at: string | null; outcome: string | null }
interface TicketRow {
  id: string; case_id: string; customer_id: string | null; type: string; category: string; reason: string; original_concern: string | null; summary: string; confirmed_details_json: string;
  steps_taken_json: string; evidence_json: string; outstanding_action: string | null; priority: Priority; status: string; team: string | null; owner_id: string | null; created_by: string;
  created_at: string; updated_at: string; data_origin: string;
}

const looksLikeCardNumber = (q: string): boolean => /\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,4}\b/.test(q) || /(?<!\d)\d{13,19}(?!\d)/.test(q);
/** Placeholder text from seeded history is never shown as if it were a customer's words or a summary. */
const real = (t: string | null | undefined): string | null => (t && !/^\[|^Seeded illustrative/i.test(t.trim()) ? t : null);
const ctxOf = (s: SessionRow | undefined): Partial<CallContext> => (s ? parseJson<Partial<CallContext>>(s.context_json, {}) : {});
const staffName = (id: string | null) => (id ? get<{ display_name: string }>('SELECT display_name FROM staff_users WHERE id = ?', [id])?.display_name?.replace(/ \(demo (agent|QA|admin)\)$/, '') ?? id : null);

/* ================================================================== customers */

/** The customer a call belongs to: verified on the case, else identified at the start of the call (not proof of identity). */
function customerForCase(c: CaseRow, s: SessionRow | undefined): { id: string | null; verified: boolean } {
  if (c.customer_id) return { id: c.customer_id, verified: c.verification_outcome === 'verified' };
  const ctx = ctxOf(s);
  return { id: ctx.verification?.identifiedCustomerId ?? s?.customer_id ?? null, verified: false };
}

function customerBrief(id: string) {
  const cu = get<{ id: string; customer_number: string; full_name: string; phone_masked: string; email_masked: string | null; account_standing: string; segment: string; created_at: string }>(
    'SELECT id, customer_number, full_name, phone_masked, email_masked, account_standing, segment, created_at FROM bank_customers WHERE id = ?',
    [id],
  );
  if (!cu) return null;
  const cards = all<{ id: string; last4: string; network: string; product: string; status: string; status_reason: string | null; holder_role: string }>(
    'SELECT id, last4, network, product, status, status_reason, holder_role FROM bank_cards WHERE customer_id = ? ORDER BY id',
    [id],
  );
  const alerts = get<{ n: number }>("SELECT COUNT(*) n FROM bank_fraud_alerts WHERE customer_id = ? AND status = 'open'", [id])?.n ?? 0;
  return {
    id: cu.id,
    name: cu.full_name,
    accountRef: cu.customer_number,
    phone: cu.phone_masked,
    email: cu.email_masked,
    standing: cu.account_standing,
    segment: cu.segment,
    cards: cards.map((k) => ({ ref: k.id, masked: `•••• ${k.last4}`, last4: k.last4, network: k.network, product: k.product, status: k.status, statusReason: k.status_reason, holder: k.holder_role })),
    openFraudAlerts: alerts,
    demoProfile: PROFILE_DEFS.some((p) => SCENARIOS.find((s) => s.id === p.scenarioId)?.customer.id === id),
  };
}

const DEMO_CUSTOMER_IDS = () => PROFILE_DEFS.map((p) => SCENARIOS.find((s) => s.id === p.scenarioId)?.customer.id).filter(Boolean) as string[];

/** Customer search by name, account reference, phone last digits or case reference. Card numbers are refused. */
export function searchCustomers(query: string, actor: Actor) {
  const q = query.trim().slice(0, 120);
  if (looksLikeCardNumber(q)) throw new AppError('VALIDATION_FAILED', 'Card numbers can’t be used to search. Search by name, account reference, phone or case reference.');
  let rows: { id: string; score: number; matched: string }[] = [];
  if (!q) {
    // Default view: the demo customers first, then customers with recent cases.
    const demo = DEMO_CUSTOMER_IDS();
    const recent = all<{ customer_id: string }>('SELECT customer_id, MAX(created_at) m FROM cases WHERE customer_id IS NOT NULL GROUP BY customer_id ORDER BY m DESC LIMIT 20').map((r) => r.customer_id);
    rows = [...new Set([...demo, ...recent])].slice(0, 20).map((id) => ({ id, score: 0, matched: '' }));
  } else {
    const tokens = [...new Set(q.toLowerCase().split(/[\s,;]+/).filter((t) => t.length >= 2))];
    const digits = tokens.map((t) => t.replace(/\D/g, '')).filter((d) => d.length >= 3);
    const hits = new Map<string, { score: number; matched: Set<string> }>();
    const add = (id: string, score: number, why: string) => {
      const h = hits.get(id) ?? { score: 0, matched: new Set<string>() };
      h.score += score;
      h.matched.add(why);
      hits.set(id, h);
    };
    for (const c of all<{ id: string; full_name: string; customer_number: string; phone_masked: string }>('SELECT id, full_name, customer_number, phone_masked FROM bank_customers')) {
      const name = c.full_name.toLowerCase();
      for (const t of tokens) if (t.length >= 2 && /[a-z]/.test(t) && name.includes(t)) add(c.id, 3, 'name');
      for (const d of digits) {
        if (c.customer_number.includes(d)) add(c.id, 4, 'account reference');
        if (d.length === 4 && c.phone_masked.endsWith(d)) add(c.id, 2, 'phone');
      }
    }
    for (const t of tokens.filter((x) => /^case-|^tck-/i.test(x))) {
      const cs = get<{ customer_id: string | null; session_id: string }>('SELECT customer_id, session_id FROM cases WHERE lower(id) = ?', [t]) ?? get<{ customer_id: string | null; session_id: string }>('SELECT c.customer_id, c.session_id FROM case_tickets t JOIN cases c ON c.id = t.case_id WHERE lower(t.id) = ?', [t]);
      if (cs?.customer_id) add(cs.customer_id, 6, 'case reference');
    }
    rows = [...hits.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, 20).map(([id, h]) => ({ id, score: h.score, matched: [...h.matched].join(', ') }));
  }
  const items = rows.map((r) => {
    const b = customerBrief(r.id);
    if (!b) return null;
    const cases = all<{ id: string; status: string; created_at: string }>('SELECT id, status, created_at FROM cases WHERE customer_id = ? ORDER BY created_at DESC', [r.id]);
    return { ...b, matchedOn: r.matched || null, openCases: cases.filter((c) => !['resolved', 'closed'].includes(c.status)).length, totalCases: cases.length, lastContact: cases[0]?.created_at ?? null };
  }).filter(Boolean);
  audit({ actor, event: 'crm.customer_search', status: 'ok', metadata: { hasQuery: !!q, results: items.length } });
  return { query: q, items };
}

export function customerProfile(customerId: string, actor: Actor) {
  const b = customerBrief(customerId);
  if (!b) throw new AppError('NOT_FOUND', 'Customer not found.');
  const disputed = new Set(all<{ transaction_id: string }>('SELECT transaction_id FROM disputes WHERE customer_id = ?', [customerId]).map((d) => d.transaction_id));
  const cardList = all<{ id: string; last4: string }>('SELECT id, last4 FROM bank_cards WHERE customer_id = ?', [customerId]).map((c) => ({ ref: c.id, masked: `•••• ${c.last4}` }));
  const txns = all<Parameters<typeof txnRow>[0]>(
    `SELECT ${DETAIL_COLS} FROM bank_transactions WHERE customer_id = ? ORDER BY txn_at DESC LIMIT 12`,
    [customerId],
  ).map((t) => txnRow(t, cardList, disputed));
  const cases = casesForCustomer(customerId);
  audit({ actor, event: 'crm.customer_viewed', status: 'ok', resourceType: 'customer', resourceId: customerId });
  return {
    customer: b,
    account: accountOverview(customerId),
    transactions: txns,
    cases,
    tickets: all<TicketRow>('SELECT * FROM case_tickets WHERE customer_id = ? ORDER BY created_at DESC', [customerId]).map(ticketBrief),
  };
}

/**
 * The card account at a glance: balance, available credit, last payment, and how the card is used.
 * Balance and usage are worked out from the bank's own records on every read (posted purchases,
 * fees not reversed, payments received), so a fee reversal on the call shows here at once. The
 * synthetic data has no credit limit, so one is set per customer: where a recent decline was for
 * low available credit, the limit is set so that this is still true.
 */
export function accountOverview(customerId: string) {
  const DAY = 86_400_000;
  const now = Date.now();
  const since = (days: number) => new Date(now - days * DAY).toISOString();
  const seed = [...customerId].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const sum = (sql: string, args: unknown[]) => get<{ n: number | null }>(sql, args)?.n ?? 0;
  const cycle = since(30);
  const spent = sum("SELECT SUM(amount_minor) n FROM bank_transactions WHERE customer_id = ? AND status = 'posted' AND kind NOT IN ('payment','fee') AND txn_at >= ?", [customerId, cycle]);
  const fees = sum('SELECT SUM(amount_minor) n FROM bank_fees WHERE customer_id = ? AND reversed_at IS NULL AND charged_at >= ?', [customerId, since(60)]);
  const paid = sum("SELECT SUM(amount_minor) n FROM bank_payments WHERE customer_id = ? AND status = 'posted' AND COALESCE(posted_at, initiated_at) >= ?", [customerId, cycle]);
  const pending = sum("SELECT SUM(amount_minor) n FROM bank_transactions WHERE customer_id = ? AND status = 'pending' AND kind NOT IN ('payment')", [customerId]);
  const carried = 15_000 + (seed % 60) * 1_500; // $150 to $1,035 brought forward from the last statement
  const balance = Math.max(0, carried + spent + fees - paid);
  const lowCredit = get<{ amount_minor: number }>("SELECT amount_minor FROM bank_declines WHERE customer_id = ? AND reason_code = 'insufficient_available_credit' AND declined_at >= ? ORDER BY declined_at DESC LIMIT 1", [customerId, cycle]);
  const limit = lowCredit
    ? Math.ceil((balance + pending + Math.round(lowCredit.amount_minor * 0.4)) / 1000) * 1000
    : [200_000, 300_000, 500_000, 750_000][seed % 4];
  const available = Math.max(0, limit - balance - pending);
  const lastPayment = get<{ amount_minor: number; at: string; status: string }>("SELECT amount_minor, COALESCE(posted_at, initiated_at) at, status FROM bank_payments WHERE customer_id = ? ORDER BY initiated_at DESC LIMIT 1", [customerId]);
  const cats = all<{ category: string | null; n: number; total: number }>(
    "SELECT merchant_category category, COUNT(*) n, SUM(amount_minor) total FROM bank_transactions WHERE customer_id = ? AND kind = 'purchase' AND status != 'reversed' AND txn_at >= ? GROUP BY merchant_category ORDER BY total DESC LIMIT 4",
    [customerId, since(90)],
  );
  const spend = (from: number, to: number) => sum("SELECT SUM(amount_minor) n FROM bank_transactions WHERE customer_id = ? AND kind = 'purchase' AND status != 'reversed' AND txn_at >= ? AND txn_at < ?", [customerId, since(from), since(to)]);
  const months = [spend(30, 0), spend(60, 30), spend(90, 60)];
  const count30 = sum("SELECT COUNT(*) n FROM bank_transactions WHERE customer_id = ? AND kind = 'purchase' AND txn_at >= ?", [customerId, cycle]);
  return {
    currency: 'USD',
    balance: formatMoney(balance),
    available: formatMoney(available),
    limit: formatMoney(limit),
    pending: pending ? formatMoney(pending) : null,
    utilisation: limit ? Math.min(100, Math.round(((balance + pending) / limit) * 100)) : 0,
    lowCredit: !!lowCredit,
    lastPayment: lastPayment ? { amount: formatMoney(lastPayment.amount_minor), at: lastPayment.at, status: lastPayment.status } : null,
    usage: {
      last30: formatMoney(months[0]),
      purchases30: count30,
      months: [['Last 30 days', months[0]], ['30–60 days ago', months[1]], ['60–90 days ago', months[2]]].map(([label, v]) => ({ label: label as string, amount: formatMoney(v as number), minor: v as number })),
      categories: cats.map((c) => ({ category: String(c.category ?? 'other').replace(/_/g, ' '), count: c.n, amount: formatMoney(c.total), minor: c.total })),
    },
    note: 'Balance and usage are worked out from the bank records; the credit limit is a demo figure.',
  };
}

/**
 * One transaction as a card agent reads it: when it happened and when it settled, what it was, how
 * the card was presented, and the references a dispute is filed against. Every field comes from the
 * record; nothing is filled in by the page.
 */
function txnRow(
  t: {
    id: string; kind: string; merchant_name: string | null; merchant_category?: string | null; mcc?: string | null;
    merchant_city?: string | null; merchant_country?: string | null; amount_minor: number; currency: string;
    txn_at: string; posted_at?: string | null; status: string; card_id: string | null;
    entry_mode?: string | null; auth_code?: string | null; network_ref?: string | null; acquirer?: string | null;
  },
  cards: { ref: string; masked: string }[],
  disputed: Set<string>,
  focusIds: string[] = [],
) {
  return {
    id: t.id,
    kind: t.kind,
    typeLabel: TXN_TYPE_LABELS[t.kind] ?? t.kind,
    merchant: t.merchant_name ?? (t.kind === 'payment' ? 'Payment received' : t.kind === 'fee' ? 'Fee charged' : '—'),
    where: [t.merchant_city, t.merchant_country ? COUNTRY_NAMES[t.merchant_country] ?? t.merchant_country : null].filter(Boolean).join(', ') || null,
    category: t.merchant_category ?? null,
    mcc: t.mcc ?? null,
    mccLabel: t.mcc ? MCC_LABELS[t.mcc] ?? null : null,
    amount: formatMoney(t.amount_minor, t.currency),
    amountMinor: t.amount_minor,
    currency: t.currency,
    at: t.txn_at,
    postedAt: t.posted_at ?? null,
    status: t.status,
    statusLabel: t.status === 'posted' ? 'Posted' : t.status === 'pending' ? 'Authorised, not yet settled' : 'Reversed',
    entryMode: t.entry_mode ?? null,
    entryLabel: t.entry_mode ? ENTRY_LABELS[t.entry_mode] ?? t.entry_mode : null,
    authCode: t.auth_code ?? null,
    networkRef: t.network_ref ?? null,
    acquirer: t.acquirer ?? null,
    card: cards.find((c) => c.ref === t.card_id)?.masked ?? null,
    disputed: disputed.has(t.id),
    focus: focusIds.includes(t.id),
  };
}

/** The columns a transaction row needs, in one place: both views read the same record. */
const DETAIL_COLS = 'id, kind, merchant_name, merchant_category, mcc, merchant_city, merchant_country, amount_minor, currency, txn_at, posted_at, status, card_id, entry_mode, auth_code, network_ref, acquirer';

/** The countries the demo bank's merchants sit in, named rather than coded. */
const COUNTRY_NAMES: Record<string, string> = {
  SG: 'Singapore', TH: 'Thailand', MM: 'Myanmar', MY: 'Malaysia', PH: 'Philippines', HK: 'Hong Kong', ID: 'Indonesia',
};

/** How the card was presented, in the words an agent uses rather than the network's codes. */
const ENTRY_LABELS: Record<string, string> = {
  ecommerce: 'Online, card not present',
  chip: 'Chip',
  chip_pin: 'Chip and PIN',
  contactless: 'Contactless',
  swipe: 'Magnetic stripe',
  recurring: 'Recurring, card on file',
  manual: 'Keyed in manually',
  atm: 'ATM',
};
const TXN_TYPE_LABELS: Record<string, string> = {
  purchase: 'Purchase', payment: 'Payment', fee: 'Fee', refund: 'Refund', credit: 'Credit', cash_advance: 'Cash advance',
};
const MCC_LABELS: Record<string, string> = {
  '4121': 'Taxis and limousines', '4722': 'Travel agencies', '4814': 'Telecommunications', '4900': 'Utilities',
  '5411': 'Groceries and supermarkets', '5541': 'Service stations', '5732': 'Electronics', '5812': 'Restaurants',
  '5814': 'Fast food', '5815': 'Digital goods', '5912': 'Pharmacies', '5968': 'Subscriptions', '5999': 'Miscellaneous retail',
  '6012': 'Financial institution', '6300': 'Insurance', '7832': 'Cinemas',
};

/** Up to 6 recent transactions, with the ones this case is about always included and marked. */
function recentTransactions(customerId: string, cards: { ref: string; masked: string }[], focusIds: string[]) {
  type T = {
    id: string; kind: string; merchant_name: string | null; merchant_category: string | null; mcc: string | null;
    merchant_city: string | null; merchant_country: string | null; amount_minor: number; currency: string;
    txn_at: string; posted_at: string | null; status: string; card_id: string | null;
    entry_mode: string | null; auth_code: string | null; network_ref: string | null; acquirer: string | null;
  };
  const cols = `SELECT ${DETAIL_COLS} FROM bank_transactions`;
  const recent = all<T>(`${cols} WHERE customer_id = ? ORDER BY txn_at DESC LIMIT 6`, [customerId]);
  const focus = focusIds.length ? all<T>(`${cols} WHERE customer_id = ? AND id IN (${focusIds.map(() => '?').join(',')})`, [customerId, ...focusIds]) : [];
  const disputed = new Set(all<{ transaction_id: string }>('SELECT transaction_id FROM disputes WHERE customer_id = ?', [customerId]).map((d) => d.transaction_id));
  const rows = [...focus, ...recent.filter((t) => !focus.some((f) => f.id === t.id))].slice(0, Math.max(6, focus.length));
  return rows.map((t) => txnRow(t, cards, disputed, focusIds));
}

/** The case to open when the agent's screen is opened without one: a call still waiting or live first, then the newest. */
export function latestCaseId(): string | null {
  const waiting = get<{ id: string }>("SELECT c.id FROM cases c JOIN handoffs h ON h.session_id = c.session_id WHERE h.status IN ('requested','queued','connected') ORDER BY h.updated_at DESC LIMIT 1");
  if (waiting) return waiting.id;
  const live = get<{ id: string }>("SELECT c.id FROM cases c JOIN call_sessions s ON s.id = c.session_id WHERE s.ended_at IS NULL AND s.data_origin = 'demo_session' ORDER BY c.updated_at DESC LIMIT 1");
  return live?.id ?? get<{ id: string }>("SELECT id FROM cases WHERE data_origin = 'demo_session' ORDER BY created_at DESC LIMIT 1")?.id ?? get<{ id: string }>('SELECT id FROM cases ORDER BY created_at DESC LIMIT 1')?.id ?? null;
}

function casesForCustomer(customerId: string) {
  // Cases verified to this customer, plus calls where the caller was identified as them but not verified.
  const direct = all<CaseRow>('SELECT * FROM cases WHERE customer_id = ?', [customerId]);
  const unverified = all<CaseRow>('SELECT c.* FROM cases c JOIN call_sessions s ON s.id = c.session_id WHERE c.customer_id IS NULL').filter((c) => {
    const s = get<SessionRow>('SELECT * FROM call_sessions WHERE id = ?', [c.session_id]);
    return customerForCase(c, s).id === customerId;
  });
  return [...direct, ...unverified].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).map((c) => caseListItem(c));
}

/* ================================================================== case list */

function caseListItem(c: CaseRow) {
  const s = get<SessionRow>('SELECT * FROM call_sessions WHERE id = ?', [c.session_id]);
  const meta = computeMeta(c, s);
  const cust = customerForCase(c, s);
  const name = cust.id ? get<{ full_name: string }>('SELECT full_name FROM bank_customers WHERE id = ?', [cust.id])?.full_name ?? null : null;
  return {
    id: c.id,
    sessionId: c.session_id,
    customer: name,
    customerId: cust.id,
    identityVerified: cust.verified,
    category: meta.effective.category,
    issueType: meta.effective.issueType,
    priority: meta.effective.priority,
    status: meta.effective.status,
    statusLabel: STATUS_LABELS[meta.effective.status],
    headline: caseHeadline(c, s),
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    live: !!s && !s.ended_at && s.data_origin === 'demo_session',
    waitingForAgent: meta.handoff?.status === 'queued' || meta.handoff?.status === 'requested',
  };
}

function caseHeadline(c: CaseRow, s: SessionRow | undefined): string {
  const said = real(c.customer_reported) ?? real(s?.issue_statement ?? null);
  if (said) return redactText(said).slice(0, 140);
  const label = c.issue_type ? ISSUE_LABELS[c.issue_type] ?? c.issue_type : 'Customer call';
  return `${label}${c.resolution_status ? ` — ${c.resolution_status.replace(/_/g, ' ')}` : ''}`;
}

export const CaseListQuery = z.object({
  view: z.enum(['attention', 'open', 'all', 'resolved']).default('attention'),
  q: z.string().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
});

export function listCrmCases(raw: unknown, actor: Actor) {
  const f = CaseListQuery.parse(raw ?? {});
  if (f.q && looksLikeCardNumber(f.q)) throw new AppError('VALIDATION_FAILED', 'Card numbers can’t be used to search.');
  const rows = all<CaseRow>('SELECT * FROM cases ORDER BY updated_at DESC LIMIT 400');
  let items = rows.map(caseListItem);
  if (f.view === 'attention') items = items.filter((i) => i.status !== 'resolved' && (i.live || i.waitingForAgent || i.priority !== 'normal' || i.status === 'escalated' || i.status === 'awaiting_bank' || i.status === 'new'));
  if (f.view === 'open') items = items.filter((i) => i.status !== 'resolved');
  if (f.view === 'resolved') items = items.filter((i) => i.status === 'resolved');
  if (f.q) {
    const t = f.q.toLowerCase();
    items = items.filter((i) => `${i.id} ${i.customer ?? ''} ${i.issueType} ${i.category} ${i.headline}`.toLowerCase().includes(t));
  }
  // Live and waiting calls first, then by priority, then most recent.
  const rank = (i: (typeof items)[number]) => (i.live || i.waitingForAgent ? 0 : 1) * 10 + (2 - PRIORITIES.indexOf(i.priority));
  items.sort((a, b) => rank(a) - rank(b) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  audit({ actor, event: 'crm.case_list_viewed', status: 'ok', metadata: { view: f.view } });
  return { view: f.view, items: items.slice(0, f.limit), total: items.length };
}

export function caseIdForSession(sessionId: string): string | null {
  return get<{ id: string }>('SELECT id FROM cases WHERE session_id = ?', [sessionId])?.id ?? null;
}

/* ================================================================== tags, priority, status */

interface Overrides {
  category?: string; issueType?: string; priority?: Priority; status?: CrmStatus; resolutionType?: string; escalationReason?: string;
  version?: number; by?: string; at?: string;
}

function computeMeta(c: CaseRow, s: SessionRow | undefined) {
  const ctx = ctxOf(s);
  const ops = all<OpRow>('SELECT id, action_type, status, target_ref, external_ref, error_code, requested_at, completed_at FROM action_operations WHERE case_id = ? OR session_id = ?', [c.id, c.session_id]);
  const handoff = get<HandoffRow>("SELECT id, status, reason, reason_detail, agent_id, requested_at, connected_at, completed_at, outcome FROM handoffs WHERE session_id = ? AND status != 'cancelled' ORDER BY requested_at DESC LIMIT 1", [c.session_id]) ?? null;
  const tickets = all<{ type: string; status: string }>('SELECT type, status FROM case_tickets WHERE case_id = ?', [c.id]);
  const flags = parseJson<string[]>(c.risk_flags_json, []);
  const map = c.issue_type ? ISSUE_MAP[c.issue_type] : undefined;
  const facts = (ctx.facts ?? {}) as Facts;
  // Cases that were not written by a live call (earlier history) have no working memory. Rebuild the
  // basics from the saved case so the "what we know" table is never empty for them.
  if (!Object.keys(facts).length) {
    const said = c.customer_reported ?? s?.issue_statement ?? null;
    if (said && !said.startsWith('[')) setFact(facts, 'issue', said, 'provided', 'customer');
    if (c.issue_type) setFact(facts, 'issue_type', ISSUE_LABELS[c.issue_type] ?? c.issue_type, 'provided', 'workflow');
    if (c.verification_outcome === 'verified' || s?.verification_status === 'verified') setFact(facts, 'identity', 'Verified during the call', 'verified', 'verification');
  }
  const live = !!s && !s.ended_at && s.data_origin === 'demo_session';

  // Priority: explicit rules over recorded state. Sentiment never raises it beyond "high".
  const blockOp = ops.find((o) => o.action_type === 'block_card');
  const amountMinor = (() => {
    const ref = parseJson<string[]>(c.transaction_refs_json, [])[0];
    return ref ? get<{ amount_minor: number }>('SELECT amount_minor FROM bank_transactions WHERE id = ?', [ref])?.amount_minor ?? null : null;
  })();
  let priority: Priority = 'normal';
  let priorityReason = 'No rule for a higher priority applies.';
  const rules: [boolean, Priority, string][] = [
    [c.issue_type === 'lost_stolen_card' && blockOp?.status !== 'succeeded', 'urgent', 'Lost or stolen card not yet confirmed blocked'],
    [!!blockOp && ['failed', 'unknown'].includes(blockOp.status), 'urgent', 'Card block failed or is unconfirmed'],
    [flags.includes('account_takeover_risk'), 'urgent', 'Account-takeover risk signal'],
    [flags.includes('fraud_alert'), 'high', 'Open fraud alert'],
    [c.issue_type === 'unrecognised_transaction', 'high', 'Suspected unauthorised transaction'],
    [amountMinor != null && amountMinor >= HIGH_VALUE_MINOR, 'high', `Amount of ${amountMinor != null ? formatMoney(amountMinor) : ''} or more`],
    [!!c.recurring_issue, 'high', 'Customer has called before about the same issue'],
    [tickets.some((t) => t.type === 'complaint'), 'high', 'Formal complaint raised'],
    [c.verification_outcome === 'failed', 'high', 'Identity check failed'],
    [ops.some((o) => o.status === 'unknown'), 'high', 'An action has an unknown outcome'],
  ];
  for (const [hit, p, why] of rules) {
    if (hit && PRIORITIES.indexOf(p) > PRIORITIES.indexOf(priority)) [priority, priorityReason] = [p, why];
  }
  const resolvedNow = c.issue_type === 'lost_stolen_card' && blockOp?.status === 'succeeded' && priority === 'urgent';
  if (resolvedNow) [priority, priorityReason] = ['high', 'Card blocked; follow-up still open'];

  // Status
  const handoffOpen = handoff && ['requested', 'queued', 'connected'].includes(handoff.status);
  const pendingConsent = live && ctx.pending?.kind === 'consent';
  const waitingOnBank = ops.some((o) => ['awaiting_approval', 'submitted', 'unknown'].includes(o.status)) || !!get("SELECT 1 FROM disputes WHERE case_id = ? AND status IN ('pending','submitting','unknown','needs_review')", [c.id]);
  let status: CrmStatus;
  if (c.status === 'resolved' || c.status === 'closed' || (handoff?.status === 'completed' && handoff.outcome === 'resolved')) status = 'resolved';
  else if (handoffOpen || (handoff && handoff.status === 'no_agent')) status = 'escalated';
  else if (waitingOnBank) status = 'awaiting_bank';
  else if (pendingConsent || (live && ctx.pending)) status = 'awaiting_customer';
  else if (live || ops.length || get('SELECT 1 FROM case_events WHERE case_id = ? AND event_type LIKE ? LIMIT 1', [c.id, 'fact_%'])) status = 'in_progress';
  else status = s?.ended_at || (s && s.verification_status !== 'not_started') ? 'in_progress' : 'new';
  if (status === 'in_progress' && s?.ended_at && (s.outcome === 'resolved' || c.resolution_status === 'resolved' || c.resolution_status === 'informational')) status = 'resolved';

  // Resolution type
  const succeeded = ops.filter((o) => o.status === 'succeeded');
  let resolutionType: string | null = null;
  if (handoff?.status === 'completed' && handoff.outcome === 'resolved') resolutionType = 'Resolved by agent';
  else if (handoff) resolutionType = 'Passed to an agent';
  else if (waitingOnBank) resolutionType = 'Action taken, awaiting bank';
  else if (c.resolution_status === 'informational') resolutionType = 'Information given';
  else if (c.resolution_status === 'resolved' || (succeeded.length && status === 'resolved')) resolutionType = 'Resolved by assistant';
  else if (s?.ended_at) resolutionType = 'Not resolved';

  const sentiment = ctx.sentiment?.sentiment ?? null;
  const ai = {
    category: map?.category ?? 'General inquiry',
    issueType: map?.issueType ?? 'Other',
    priority,
    priorityReason,
    status,
    resolutionType,
    escalationReason: handoff ? ESCALATION_MAP[handoff.reason] ?? (HANDOFF_REASON_LABELS[handoff.reason] ?? handoff.reason) : null,
    sentiment,
    sentimentBasis: ctx.sentiment?.basis ?? null,
  };
  const ov = parseJson<Overrides>(c.agent_overrides_json, {});
  const effective = {
    category: ov.category ?? ai.category,
    issueType: ov.issueType ?? ai.issueType,
    priority: (ov.priority ?? ai.priority) as Priority,
    status: (ov.status ?? ai.status) as CrmStatus,
    resolutionType: ov.resolutionType ?? ai.resolutionType,
    escalationReason: ov.escalationReason ?? ai.escalationReason,
  };
  return { ai, overrides: ov, effective, ops, handoff, facts, ctx, live, team: map?.team ?? 'Card services' };
}

/* ================================================================== the case workspace */

export function caseWorkspace(caseId: string, actor: Actor) {
  const c = get<CaseRow>('SELECT * FROM cases WHERE id = ?', [caseId]);
  if (!c) throw new AppError('NOT_FOUND', 'Case not found.');
  const s = get<SessionRow>('SELECT * FROM call_sessions WHERE id = ?', [c.session_id]);
  const meta = computeMeta(c, s);
  const res = s ? buildResolution(s.id) : null;
  const cust = customerForCase(c, s);
  const customer = cust.id ? customerBrief(cust.id) : null;
  const facts = meta.facts;
  const eligibility = parseJson<{ eligible: boolean; ruleCode: string | null; reasons: string[] } | null>(c.eligibility_json, null);

  const cardFact = facts.card_reference;
  const txnFact = facts.transaction;
  const isTxnIssue = ['unrecognised_transaction', 'wrong_or_duplicate_charge'].includes(c.issue_type ?? '');
  const identity = c.verification_outcome === 'verified' || s?.verification_status === 'verified' ? 'verified' : c.verification_outcome === 'failed' || s?.verification_status === 'failed' ? 'failed' : 'not_verified';

  // Key information: one line each, from records only.
  const keyInfo = [
    { key: 'identity', label: identity === 'verified' ? 'Identity verified' : identity === 'failed' ? 'Identity check failed' : 'Identity not verified yet', state: identity === 'verified' ? 'ok' : identity === 'failed' ? 'bad' : 'unknown', detail: identity === 'verified' ? facts.identity?.value ?? 'Verified during the call' : identity === 'failed' ? 'Did not pass the security check' : 'Not verified' },
    { key: 'card', label: 'Card details found', state: cardFact?.status === 'verified' || (customer?.cards.length && identity === 'verified') ? 'ok' : cardFact ? 'warn' : 'unknown', detail: cardFact ? `${cardFact.value}${cardFact.status === 'verified' ? '' : ' (customer said, not checked)'}` : customer?.cards[0] ? `${customer.cards[0].masked} · ${customer.cards[0].status}` : 'No card identified' },
    ...(isTxnIssue || txnFact
      ? [{ key: 'charge', label: 'Charge details matched', state: txnFact?.status === 'confirmed' ? 'ok' : txnFact?.status === 'conflicting' ? 'warn' : 'unknown', detail: txnFact ? txnFact.status === 'conflicting' ? `Bank: ${txnFact.value}; customer: ${txnFact.customerValue}` : txnFact.value : 'Not matched yet' }]
      : []),
    { key: 'fraud', label: 'Fraud flags', state: !customer ? 'unknown' : customer.openFraudAlerts ? 'warn' : 'ok', detail: !customer ? 'Customer not identified' : customer.openFraudAlerts ? `${customer.openFraudAlerts} open alert${customer.openFraudAlerts > 1 ? 's' : ''}` : 'None open' },
    ...(isTxnIssue
      ? [{ key: 'dispute', label: 'Dispute eligible', state: eligibility ? (eligibility.eligible ? 'ok' : 'bad') : 'unknown', detail: eligibility ? (eligibility.eligible ? `Yes, under rule ${eligibility.ruleCode}` : `No: ${eligibility.reasons.join(' ')}`) : 'Not evaluated yet' }]
      : []),
  ];

  const confirmed = res?.verifiedFacts ?? all<{ detail_json: string }>("SELECT detail_json FROM case_events WHERE case_id = ? AND event_type = 'fact_confirmed'", [c.id]).map((e) => parseJson<{ text: string }>(e.detail_json, { text: '' }).text);
  const conflicts = Object.entries(facts).filter(([, f]) => f?.status === 'conflicting').map(([k, f]) => `${k.replace(/_/g, ' ')}: bank has ${f!.value}, customer said ${f!.customerValue}`);
  const sources = parseJson<{ source: string; status: string; stale?: boolean }[]>(c.sources_checked_json, []);
  const actions = (res?.actions ?? []).map((a) => ({
    id: a.id,
    label: a.label,
    type: a.type,
    state: actionState(a.status),
    stateLabel: ACTION_STATE_LABEL[actionState(a.status)],
    reference: a.reference,
    error: a.error,
    canApprove: a.status === 'awaiting_approval',
    canCheck: a.status === 'unknown' || a.status === 'submitted',
  }));
  const intended = INTENDED[c.issue_type ?? ''] ?? null;
  const reported = real(c.customer_reported) ?? real(s?.issue_statement ?? null) ?? facts.issue?.value ?? null;
  const transactionLine = txnFact
    ? `${txnFact.value}${txnFact.status === 'conflicting' ? ` — customer said ${txnFact.customerValue}` : ''}`
    : [facts.merchant, facts.amount, facts.date].some(Boolean)
      ? `Customer mentioned ${[facts.merchant?.value, facts.amount?.value, facts.date?.value].filter(Boolean).join(', ')} (not yet matched to a bank record)`
      : null;

  const recommendations = buildRecommendations(c, s, meta, { identity, eligibility, customer, conflicts });
  const demoReset = (() => {
    const e = all<{ detail_json: string }>("SELECT detail_json FROM case_events WHERE case_id = ? AND event_type = 'demo_data_reset' ORDER BY id DESC LIMIT 1", [c.id]).at(0);
    return e ? parseJson<{ at?: string }>(e.detail_json, {}) : null;
  })();
  const summary = {
    demoReset: demoReset ? { at: demoReset.at ?? null, note: 'The bank records were put back for a later demo call.' } : null,
    reported: reported ? redactText(reported) : null,
    intendedOutcome: intended,
    transaction: transactionLine,
    verification: identity === 'verified' ? 'Verified' : identity === 'failed' ? 'Failed: the security check did not pass' : 'Not verified',
    checks: sources.map((x) => ({ label: SOURCE_DISPLAY[x.source as keyof typeof SOURCE_DISPLAY] ?? x.source, status: x.status, stale: !!x.stale })),
    confirmed,
    unresolved: [...new Set([...(res?.unresolved ?? []), ...conflicts])],
    attempted: actions.map((a) => `${a.label}: ${a.stateLabel}${a.reference ? ` (ref ${a.reference})` : ''}`),
    outcome: res?.headline ?? (s?.ended_at ? 'Call ended' : 'In progress'),
    nextSteps: recommendations.filter((r) => r.status !== 'rejected').slice(0, 3).map((r) => r.editedText ?? r.title),
  };
  const summaryText = [
    `${customer?.name ?? 'The caller'} ${reported ? `reported: “${redactText(reported).slice(0, 200).replace(/[.!?\s]+$/, '')}”` : 'called; their words were not captured'}.`,
    `Identity: ${summary.verification.toLowerCase()}.`,
    transactionLine ? `Transaction: ${transactionLine}.` : null,
    confirmed.length ? `Confirmed by bank systems: ${confirmed.slice(0, 3).join(' ')}` : 'Nothing confirmed by bank systems yet.',
    actions.length ? `Actions: ${summary.attempted.join('; ')}.` : 'No account changes were made.',
    `Outcome: ${summary.outcome}.`,
    // Demo data is put back between calls. Say so here, or this reads as the account's state now
    // and contradicts the account panel next to it.
    demoReset ? `Demo data was put back after this call${demoReset.at ? ` on ${formatDate(demoReset.at)}` : ''}: the card is active again and fees are charged again. What happened on this call still stands.` : null,
  ].filter(Boolean).join(' ');

  const tickets = all<TicketRow>('SELECT * FROM case_tickets WHERE case_id = ? ORDER BY created_at DESC', [c.id]).map((t) => ({
    ...ticketBrief(t),
    events: all<{ event: string; detail: string | null; actor_id: string; created_at: string }>('SELECT event, detail, actor_id, created_at FROM ticket_events WHERE ticket_id = ? ORDER BY id', [t.id]).map((e) => ({ event: e.event, detail: e.detail, by: staffName(e.actor_id) ?? e.actor_id, at: e.created_at })),
  }));

  // In a voice call Lily's spoken words and the bank text she was given are both stored. The record
  // for staff shows what the customer actually heard: when an exchange has a spoken reply, the
  // matching typed text is left out so each line appears once.
  const rawTurns = s
    ? all<{ seq: number; speaker: string; kind: string | null; text: string; created_at: string; sensitive_redacted: number }>('SELECT seq, speaker, kind, text, created_at, sensitive_redacted FROM conversation_turns WHERE session_id = ? ORDER BY seq', [s.id])
    : [];
  const spokenIn = new Set<number>();
  {
    let start = 0;
    const flush = (end: number) => {
      const seg = rawTurns.slice(start, end);
      if (seg.some((x) => x.speaker === 'assistant' && (x.kind === 'voice' || x.kind === 'voice_interrupted'))) for (const x of seg) if (x.speaker === 'assistant' && x.kind === 'utterance') spokenIn.add(x.seq);
    };
    rawTurns.forEach((x, i) => { if (x.speaker === 'customer') { flush(i); start = i; } });
    flush(rawTurns.length);
  }
  const transcript = rawTurns.filter((x) => !spokenIn.has(x.seq)).map((t) => ({ seq: t.seq, speaker: t.speaker, kind: t.kind, text: t.text, at: t.created_at, hidden: !!t.sensitive_redacted }));
  const previous = cust.id ? casesForCustomer(cust.id).filter((x) => x.id !== c.id).slice(0, 6) : [];

  // The one card and the charges this call is about, so the agent sees those first.
  const txnRefs = parseJson<string[]>(c.transaction_refs_json, []);
  const opTargets = all<{ action_type: string; target_ref: string }>('SELECT action_type, target_ref FROM action_operations WHERE session_id = ? ORDER BY requested_at', [c.session_id]);
  const focusTxnIds = [...new Set([...txnRefs, ...opTargets.filter((o) => o.action_type === 'submit_dispute' || o.action_type === 'reverse_fee').map((o) => o.target_ref)])];
  let focusCard: string | null = null;
  if (customer) {
    const refs = new Set(customer.cards.map((k) => k.ref));
    focusCard = opTargets.map((o) => o.target_ref).find((r) => refs.has(r)) ?? null;
    if (!focusCard && focusTxnIds.length) focusCard = get<{ card_id: string | null }>(`SELECT card_id FROM bank_transactions WHERE id IN (${focusTxnIds.map(() => '?').join(',')}) AND card_id IS NOT NULL LIMIT 1`, focusTxnIds)?.card_id ?? null;
    if (!focusCard && cardFact?.value) focusCard = customer.cards.find((k) => String(cardFact.value).includes(k.last4))?.ref ?? null;
    if (!focusCard) focusCard = (customer.cards.find((k) => k.holder === 'primary') ?? customer.cards[0])?.ref ?? null;
  }
  // Account detail only once identity is verified: an identified-but-unverified caller sees no transactions.
  const transactions = customer && cust.verified ? recentTransactions(customer.id, customer.cards, focusTxnIds) : [];

  audit({ actor, event: 'crm.case_viewed', status: 'ok', resourceType: 'case', resourceId: c.id, sessionId: c.session_id });
  return {
    focus: { cardRef: focusCard, transactionIds: focusTxnIds },
    transactions,
    account: customer && cust.verified ? accountOverview(customer.id) : null,
    customerTickets: customer && cust.verified ? all<TicketRow>('SELECT * FROM case_tickets WHERE customer_id = ? AND case_id != ? ORDER BY created_at DESC LIMIT 5', [customer.id, c.id]).map(ticketBrief) : [],
    case: {
      id: c.id,
      sessionId: c.session_id,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      live: meta.live,
      channel: s?.channel === 'voice_browser' ? 'Voice call' : s?.channel === 'telephony' ? 'Phone call' : 'Chat',
      origin: c.data_origin,
      version: meta.overrides.version ?? 0,
    },
    customer: customer ? { ...customer, identityVerified: cust.verified } : null,
    tags: {
      ai: meta.ai,
      overrides: { category: meta.overrides.category ?? null, issueType: meta.overrides.issueType ?? null, priority: meta.overrides.priority ?? null, status: meta.overrides.status ?? null, resolutionType: meta.overrides.resolutionType ?? null, escalationReason: meta.overrides.escalationReason ?? null },
      effective: { ...meta.effective, statusLabel: STATUS_LABELS[meta.effective.status] },
      editedBy: staffName(meta.overrides.by ?? null),
      editedAt: meta.overrides.at ?? null,
    },
    keyInfo,
    summary,
    summaryText,
    facts: factRows(facts).filter((f) => f.status !== 'unknown' || ['issue', 'identity', 'card_reference'].includes(f.key)),
    recommendations,
    actions,
    handoff: meta.handoff ? { ...meta.handoff, reasonLabel: HANDOFF_REASON_LABELS[meta.handoff.reason] ?? meta.handoff.reason, agentName: staffName(meta.handoff.agent_id) } : null,
    // The agent's own passcode check: where it went and whether it matched. Never the code.
    agentCheck: (() => {
      const ck = readCheck(c.session_id);
      return ck ? { status: ck.status, deliveredTo: ck.deliveredTo, attempts: ck.attempts, requestedByName: ck.requestedByName } : null;
    })(),
    tickets,
    timeline: buildTimeline(c, s),
    transcript,
    notes: c.agent_notes ?? '',
    previousCases: previous,
    taxonomy: taxonomy(),
  };
}

export const taxonomy = () => ({ categories: CATEGORIES, issueTypes: ISSUE_TYPES, priorities: PRIORITIES, statuses: STATUSES.map((s) => ({ id: s, label: STATUS_LABELS[s] })), resolutionTypes: RESOLUTION_TYPES, escalationReasons: ESCALATION_REASONS, teams: TEAMS });

const INTENDED: Record<string, string> = {
  unrecognised_transaction: 'Have the unrecognised charge investigated and the card protected',
  wrong_or_duplicate_charge: 'Get the duplicate or wrong charge corrected',
  lost_stolen_card: 'Get the card blocked and replaced',
  payment_not_showing: 'See the payment applied to the card account',
  fee_query: 'Understand the fee, and have it removed if eligible',
  card_declined: 'Understand the decline and use the card again',
  account_inquiry: 'Get information about the account',
};

type ActionState = 'awaiting_customer' | 'awaiting_approval' | 'in_progress' | 'completed' | 'failed' | 'unknown' | 'declined';
const actionState = (status: string): ActionState =>
  status === 'succeeded' ? 'completed' : status === 'failed' ? 'failed' : status === 'unknown' ? 'unknown' : status === 'rejected' ? 'declined' : status === 'awaiting_approval' ? 'awaiting_approval' : status === 'submitted' ? 'in_progress' : 'awaiting_customer';
const ACTION_STATE_LABEL: Record<ActionState, string> = {
  awaiting_customer: 'Waiting for the customer’s consent',
  awaiting_approval: 'Waiting for agent approval',
  in_progress: 'Sent, not yet confirmed',
  completed: 'Completed, confirmed by the bank system',
  failed: 'Failed, not done',
  unknown: 'Outcome unknown, check before retrying',
  declined: 'Not done (declined or not allowed)',
};

/* ================================================================== recommendations */

interface Rec { kind: string; title: string; reason: string; basis: 'confirmed' | 'customer' | 'rule'; status: 'suggested' | 'accepted' | 'rejected' | 'edited'; editedText: string | null; decidedBy: string | null; decidedAt: string | null }

function buildRecommendations(c: CaseRow, s: SessionRow | undefined, meta: ReturnType<typeof computeMeta>, x: { identity: string; eligibility: { eligible: boolean; ruleCode: string | null; reasons: string[] } | null; customer: ReturnType<typeof customerBrief>; conflicts: string[] }): Rec[] {
  const out: Omit<Rec, 'status' | 'editedText' | 'decidedBy' | 'decidedAt'>[] = [];
  const add = (kind: string, title: string, reason: string, basis: Rec['basis']) => { if (!out.some((r) => r.kind === kind)) out.push({ kind, title, reason, basis }); };
  const ops = meta.ops;
  const op = (t: string) => ops.find((o) => o.action_type === t);
  const card = x.customer?.cards[0];
  const ctx = meta.ctx;
  const flags = parseJson<string[]>(c.risk_flags_json, []);

  if (x.identity === 'failed') add('verify_other_way', 'Verify the customer another way before discussing the account', 'The card number did not match after the allowed attempts, so nothing on the account was read or changed.', 'confirmed');
  if (flags.includes('account_takeover_risk')) add('security_review', 'Send to Fraud and security before any change', 'There is an account-takeover risk signal on this customer.', 'confirmed');
  for (const o of ops.filter((o) => o.status === 'awaiting_approval')) add(`approve_${o.action_type}`, `Review and approve: ${ACTION_LABELS[o.action_type] ?? o.action_type}`, 'Policy holds this action for a person to approve. It has not been done.', 'rule');
  for (const o of ops.filter((o) => o.status === 'unknown')) add(`check_${o.action_type}`, `Check whether "${ACTION_LABELS[o.action_type] ?? o.action_type}" went through before retrying`, 'The bank system did not confirm the outcome. Retrying blindly could do it twice.', 'confirmed');
  if (op('block_card')?.status === 'failed') add('manual_block', 'Block the card manually or escalate to card security now', 'The automatic block failed, so the card is still active.', 'confirmed');
  if (x.conflicts.length) add('resolve_conflict', 'Confirm the right details with the customer', `The customer’s details differ from the bank record (${x.conflicts[0]}).`, 'confirmed');
  if ((c.issue_type === 'unrecognised_transaction' || c.issue_type === 'wrong_or_duplicate_charge') && x.identity === 'verified' && !meta.facts.transaction) {
    add('request_detail', 'Ask the customer for the date or amount of the charge', 'No single transaction has been matched yet. Ask only for the missing detail.', 'rule');
  }
  const dispute = op('submit_dispute');
  if (dispute && ['submitted', 'succeeded'].includes(dispute.status)) add('follow_dispute', 'Follow the approved dispute process and update the customer', dispute.status === 'succeeded' ? `The dispute was received (ref ${dispute.external_ref}). A decision is still to come.` : 'The dispute was sent but not yet acknowledged.', 'confirmed');
  else if (x.eligibility?.eligible && !dispute) add('offer_dispute', 'Offer the fraud dispute the customer is eligible for', `Eligible under rule ${x.eligibility.ruleCode}, and no dispute has been filed.`, 'rule');
  else if (x.eligibility && !x.eligibility.eligible) add('explain_ineligible', 'Explain why an automatic dispute isn’t possible and offer an investigation', x.eligibility.reasons.join(' ') || 'The dispute rules were not met.', 'rule');
  if ((c.issue_type === 'lost_stolen_card' || c.issue_type === 'unrecognised_transaction' || flags.includes('fraud_alert')) && card?.status === 'active' && op('block_card')?.status !== 'succeeded' && x.identity === 'verified') {
    add('recommend_block', `Recommend blocking the card ${card.masked}`, c.issue_type === 'lost_stolen_card' ? 'The customer reported the card lost or stolen and it is still active.' : 'Suspected fraud on an active card. Blocking needs the customer’s consent.', 'rule');
  }
  if (op('block_card')?.status === 'succeeded' && op('order_replacement')?.status === 'succeeded') add('confirm_replacement', 'Confirm the replacement card delivery with the customer', `Card blocked and replacement ordered (ref ${op('order_replacement')!.external_ref}).`, 'confirmed');
  if (c.issue_type === 'payment_not_showing') add('explain_payment', 'Explain the payment status and when it should appear', 'Use the payment system’s status. Do not promise a posting date it has not given.', 'rule');
  if (c.issue_type === 'card_declined') add('explain_decline', 'Explain the decline reason and the options', 'The authorisation record gives the reason. No change has been made to the card.', 'confirmed');
  if (c.issue_type === 'fee_query' && !op('reverse_fee')) add('review_fee', 'Review the fee against the fee policy', x.eligibility?.eligible === false ? x.eligibility.reasons.join(' ') : 'The fee policy decides whether a reversal is allowed.', 'rule');
  const complaint = all<{ type: string }>("SELECT type FROM case_tickets WHERE case_id = ? AND status IN ('open','in_progress')", [c.id]).some((t) => t.type === 'complaint');
  if (!complaint && (ctx.sentiment?.sentiment === 'frustrated' || c.recurring_issue)) add('offer_complaint', 'Offer to log a formal complaint', c.recurring_issue ? 'The customer has called before about the same unresolved issue.' : 'The customer sounded frustrated (indicative only).', c.recurring_issue ? 'confirmed' : 'customer');
  if (meta.handoff && ['queued', 'requested'].includes(meta.handoff.status)) add('accept_handover', 'Accept the handover and greet the customer by name', `Reason: ${HANDOFF_REASON_LABELS[meta.handoff.reason] ?? meta.handoff.reason}. The customer has not been asked to repeat anything.`, 'confirmed');
  if (meta.handoff?.status === 'connected') {
    if (x.identity !== 'verified') add('verify_then_help', 'Verify the customer, then ask how you can help', c.issue_type ? 'Identity was not verified on the call. Everything the customer said is in the summary, so don’t ask them to repeat it.' : 'The customer asked for a person before explaining the problem.', 'confirmed');
    else add('continue_from_brief', 'Pick up from the summary; don’t ask the customer to repeat anything', 'The customer is verified and the case holds what was said and checked.', 'confirmed');
  }
  if (!out.length) {
    const next = c.next_steps ?? (s?.ended_at ? 'No follow-up needed unless the customer calls back.' : 'Wait for the call to reach a decision.');
    add('next_step', next, 'From the recorded case outcome.', 'confirmed');
  }

  const decided = all<{ kind: string; status: Rec['status']; edited_text: string | null; decided_by: string; decided_at: string }>('SELECT kind, status, edited_text, decided_by, decided_at FROM case_recommendations WHERE case_id = ?', [c.id]);
  return out.map((r) => {
    const d = decided.find((x) => x.kind === r.kind);
    return { ...r, status: d?.status ?? 'suggested', editedText: d?.edited_text ?? null, decidedBy: d ? staffName(d.decided_by) : null, decidedAt: d?.decided_at ?? null };
  });
}

export const RecommendationDecision = z.object({ decision: z.enum(['accept', 'reject', 'edit']), text: z.string().trim().min(3).max(500).optional() }).strict()
  .refine((v) => v.decision !== 'edit' || !!v.text, 'Edited suggestions need the new text.');

export function decideRecommendation(caseId: string, kind: string, actor: StaffActor, raw: unknown) {
  const body = RecommendationDecision.parse(raw);
  const c = get<CaseRow>('SELECT * FROM cases WHERE id = ?', [caseId]);
  if (!c) throw new AppError('NOT_FOUND', 'Case not found.');
  const w = caseWorkspace(caseId, actor);
  const rec = w.recommendations.find((r) => r.kind === kind);
  if (!rec) throw new AppError('CONFLICT', 'That suggestion no longer applies to this case. Reload to see the current one.');
  const status = body.decision === 'accept' ? 'accepted' : body.decision === 'reject' ? 'rejected' : 'edited';
  const ts = nowIso();
  run(
    `INSERT INTO case_recommendations (id, case_id, kind, title, reason, status, edited_text, decided_by, decided_at) VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(case_id, kind) DO UPDATE SET status = excluded.status, edited_text = excluded.edited_text, decided_by = excluded.decided_by, decided_at = excluded.decided_at, title = excluded.title, reason = excluded.reason`,
    [newId('REC'), caseId, kind, rec.title, rec.reason, status, body.text ? redactText(body.text) : null, actor.id, ts],
  );
  caseEvent(caseId, `recommendation_${status}`, { kind, title: rec.title });
  audit({ actor, event: `crm.recommendation_${status}`, status: 'ok', resourceType: 'case', resourceId: caseId, sessionId: c.session_id, metadata: { kind } });
  return caseWorkspace(caseId, actor);
}

/* ================================================================== agent edits */

const opt = <T extends readonly [string, ...string[]]>(values: T) => z.enum(values).nullable().optional();
export const CasePatch = z
  .object({
    overrides: z
      .object({
        category: opt(CATEGORIES),
        issueType: opt(ISSUE_TYPES),
        priority: opt(PRIORITIES),
        status: opt(STATUSES),
        resolutionType: opt(RESOLUTION_TYPES),
        escalationReason: opt(ESCALATION_REASONS),
      })
      .strict()
      .optional(),
    notes: z.string().trim().max(3000).optional(),
    version: z.number().int().min(0),
  })
  .strict()
  .refine((v) => v.overrides !== undefined || v.notes !== undefined, 'Nothing to update.');

export function editCase(caseId: string, actor: StaffActor, raw: unknown) {
  const body = CasePatch.parse(raw);
  const result = tx(() => {
    const c = get<CaseRow>('SELECT * FROM cases WHERE id = ?', [caseId]);
    if (!c) throw new AppError('NOT_FOUND', 'Case not found.');
    const ov = parseJson<Overrides>(c.agent_overrides_json, {});
    if ((ov.version ?? 0) !== body.version) throw new AppError('CONFLICT', 'Someone else changed this case. Reload to see the latest before saving.');
    const changed: string[] = [];
    const next: Overrides = { ...ov };
    for (const [k, v] of Object.entries(body.overrides ?? {}) as [keyof Overrides, string | null | undefined][]) {
      if (v === undefined) continue;
      if (v === null) { if (k in next) { delete next[k]; changed.push(k); } continue; }
      if (next[k] !== v) { (next as Record<string, unknown>)[k] = v; changed.push(k); }
    }
    const notesChanged = body.notes !== undefined && body.notes !== (c.agent_notes ?? '');
    if (!changed.length && !notesChanged) return { c, changed, notesChanged };
    next.version = (ov.version ?? 0) + 1;
    next.by = actor.id;
    next.at = nowIso();
    run('UPDATE cases SET agent_overrides_json = ?, agent_notes = ?, updated_at = ? WHERE id = ?', [JSON.stringify(next), notesChanged ? redactText(body.notes!) : c.agent_notes, nowIso(), caseId]);
    // An agent marking the case resolved closes it for the customer too, so both sides show one status.
    if (changed.includes('status') && next.status === 'resolved' && !['resolved', 'closed'].includes(c.status)) updateCase(caseId, { status: 'resolved' });
    if (changed.includes('status') && next.status && next.status !== 'resolved' && c.status === 'resolved') updateCase(caseId, { status: 'pending' });
    return { c, changed, notesChanged };
  });
  if (result.changed.length || result.notesChanged) {
    caseEvent(caseId, 'agent_edited', { fields: result.changed, notes: result.notesChanged });
    audit({ actor, event: 'crm.case_edited', status: 'ok', resourceType: 'case', resourceId: caseId, sessionId: result.c.session_id, metadata: { fields: result.changed, notesChanged: result.notesChanged } });
    emitTimeline(result.c.session_id, { type: 'case.agent_updated', stage: 'record', title: 'Agent updated the case details', detail: result.changed.length ? `Changed: ${result.changed.join(', ')}` : 'Notes updated', status: 'info', source: 'agent workspace', ref: caseId });
  }
  return caseWorkspace(caseId, actor);
}

/* ================================================================== tickets */

function ticketBrief(t: TicketRow) {
  return {
    id: t.id,
    caseId: t.case_id,
    type: t.type,
    typeLabel: t.type === 'complaint' ? 'Complaint' : 'Escalation',
    category: t.category,
    reason: t.reason,
    originalConcern: t.original_concern,
    summary: t.summary,
    confirmedDetails: parseJson<string[]>(t.confirmed_details_json, []),
    stepsTaken: parseJson<string[]>(t.steps_taken_json, []),
    evidence: parseJson<string[]>(t.evidence_json, []),
    outstandingAction: t.outstanding_action,
    priority: t.priority,
    status: t.status,
    team: t.team,
    owner: staffName(t.owner_id),
    createdBy: t.created_by === 'hear-it-once-assistant' ? 'Lily (automatic)' : staffName(t.created_by) ?? t.created_by,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

export const TicketCreate = z
  .object({
    type: z.enum(['complaint', 'escalation']),
    reason: z.string().trim().min(3).max(300),
    team: z.enum(TEAMS).optional(),
    priority: z.enum(PRIORITIES).optional(),
    requestKey: z.string().trim().min(8).max(80).regex(/^[A-Za-z0-9:_-]+$/),
  })
  .strict();

/**
 * Create a complaint or escalation ticket from the case's recorded state. Idempotent: the same
 * request key, or a second open ticket of the same type on the case, returns the existing ticket.
 */
export function createTicket(caseId: string, actor: Actor, raw: unknown): { ticket: ReturnType<typeof ticketBrief>; duplicate: boolean } {
  const body = TicketCreate.parse(raw);
  const byKey = get<TicketRow>('SELECT * FROM case_tickets WHERE request_key = ?', [body.requestKey]);
  if (byKey) {
    if (byKey.case_id !== caseId) throw new AppError('CONFLICT', 'That request key was already used for another case.');
    return { ticket: ticketBrief(byKey), duplicate: true };
  }
  const c = get<CaseRow>('SELECT * FROM cases WHERE id = ?', [caseId]);
  if (!c) throw new AppError('NOT_FOUND', 'Case not found.');
  const open = get<TicketRow>("SELECT * FROM case_tickets WHERE case_id = ? AND type = ? AND status IN ('open','in_progress')", [caseId, body.type]);
  if (open) {
    run('INSERT INTO ticket_events (ticket_id, event, detail, actor_id, created_at) VALUES (?,?,?,?,?)', [open.id, 'duplicate_request', 'A second request was made; the open ticket was reused.', actor.id, nowIso()]);
    return { ticket: ticketBrief(open), duplicate: true };
  }
  const s = get<SessionRow>('SELECT * FROM call_sessions WHERE id = ?', [c.session_id]);
  const meta = computeMeta(c, s);
  const res = s ? buildResolution(s.id) : null;
  const cust = customerForCase(c, s);
  const facts = meta.facts;
  const confirmed = [
    ...(facts.transaction?.status === 'confirmed' ? [`Transaction: ${facts.transaction.value}`] : []),
    ...(res?.verifiedFacts ?? []).slice(0, 5),
  ];
  const steps = [
    `Identity: ${c.verification_outcome === 'verified' ? 'verified' : c.verification_outcome === 'failed' ? 'failed the security check' : 'not verified'}`,
    ...(res?.actions ?? []).map((a) => `${a.label}: ${ACTION_STATE_LABEL[actionState(a.status)]}${a.reference ? ` (ref ${a.reference})` : ''}`),
    ...(meta.handoff ? [`Handed to an agent: ${HANDOFF_REASON_LABELS[meta.handoff.reason] ?? meta.handoff.reason}`] : []),
  ];
  const evidence = [
    ...all<{ id: string; external_ref: string | null }>('SELECT id, external_ref FROM disputes WHERE case_id = ?', [caseId]).map((d) => `Dispute ${d.id}${d.external_ref ? ` (intake ref ${d.external_ref})` : ''}`),
    ...parseJson<string[]>(c.transaction_refs_json, []).map((t) => `Transaction record ${t}`),
    `Call transcript ${c.session_id}`,
  ];
  const outstanding = (res?.unresolved ?? [])[0] ?? res?.nextStep ?? null;
  const reported = real(c.customer_reported) ?? real(s?.issue_statement ?? null) ?? facts.issue?.value ?? null;
  const team = body.team ?? (body.type === 'complaint' ? 'Complaints' : meta.team);
  const priority: Priority = body.priority ?? (body.type === 'complaint' && meta.effective.priority === 'normal' ? 'high' : meta.effective.priority);
  const id = newId('TCK', 8);
  const ts = nowIso();
  const summary = [
    `${meta.effective.issueType} (${meta.effective.category}).`,
    reported ? `Customer said: “${redactText(reported).slice(0, 240)}”.` : null,
    res?.headline ? `Status at creation: ${res.headline}.` : null,
  ].filter(Boolean).join(' ');
  try {
    run(
      `INSERT INTO case_tickets (id, case_id, customer_id, type, category, reason, original_concern, summary, confirmed_details_json, steps_taken_json, evidence_json, outstanding_action, priority, status, team, owner_id, request_key, created_by, data_origin, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'open', ?, NULL, ?, ?, ?, ?, ?)`,
      [id, caseId, cust.id, body.type, meta.effective.category, redactText(body.reason), reported ? redactText(reported) : null, redactText(summary), JSON.stringify(confirmed.map(redactText)), JSON.stringify(steps.map(redactText)), JSON.stringify(evidence), outstanding ? redactText(outstanding) : null, priority, team, body.requestKey, actor.id, c.data_origin, ts, ts],
    );
  } catch (e) {
    // A concurrent identical request won the race: return the ticket it created.
    const again = get<TicketRow>("SELECT * FROM case_tickets WHERE request_key = ? OR (case_id = ? AND type = ? AND status IN ('open','in_progress'))", [body.requestKey, caseId, body.type]);
    if (again) return { ticket: ticketBrief(again), duplicate: true };
    throw e;
  }
  run('INSERT INTO ticket_events (ticket_id, event, detail, actor_id, created_at) VALUES (?,?,?,?,?)', [id, 'created', `${body.type === 'complaint' ? 'Complaint' : 'Escalation'} ticket created for ${team}.`, actor.id, ts]);
  caseEvent(caseId, 'ticket_created', { ticketId: id, type: body.type });
  audit({ actor, event: 'crm.ticket_created', status: 'ok', resourceType: 'ticket', resourceId: id, sessionId: c.session_id, metadata: { type: body.type, caseId } });
  emitTimeline(c.session_id, { type: 'ticket.created', stage: 'record', title: `${body.type === 'complaint' ? 'Complaint' : 'Escalation'} ticket ${id} created`, detail: `Assigned to ${team}. ${redactText(body.reason)}`, status: 'ok', source: 'case management', ref: id });
  return { ticket: ticketBrief(get<TicketRow>('SELECT * FROM case_tickets WHERE id = ?', [id])!), duplicate: false };
}

const TICKET_FLOW: Record<string, string[]> = { open: ['in_progress', 'resolved', 'closed'], in_progress: ['resolved', 'closed'], resolved: ['closed', 'in_progress'], closed: [] };
export const TicketPatch = z.object({ status: z.enum(['open', 'in_progress', 'resolved', 'closed']), note: z.string().trim().max(500).optional() }).strict();

export function updateTicket(ticketId: string, actor: StaffActor, raw: unknown) {
  const body = TicketPatch.parse(raw);
  const t = get<TicketRow>('SELECT * FROM case_tickets WHERE id = ?', [ticketId]);
  if (!t) throw new AppError('NOT_FOUND', 'Ticket not found.');
  if (t.status === body.status) return caseWorkspace(t.case_id, actor);
  if (!TICKET_FLOW[t.status]?.includes(body.status)) throw new AppError('CONFLICT', `A ${t.status.replace('_', ' ')} ticket can’t be moved to ${body.status.replace('_', ' ')}.`);
  const upd = run('UPDATE case_tickets SET status = ?, owner_id = COALESCE(owner_id, ?), updated_at = ? WHERE id = ? AND status = ?', [body.status, actor.id, nowIso(), ticketId, t.status]);
  if (upd.changes !== 1) throw new AppError('CONFLICT', 'The ticket changed while you were updating it. Reload and try again.');
  run('INSERT INTO ticket_events (ticket_id, event, detail, actor_id, created_at) VALUES (?,?,?,?,?)', [ticketId, `status_${body.status}`, body.note ? redactText(body.note) : null, actor.id, nowIso()]);
  caseEvent(t.case_id, 'ticket_updated', { ticketId, status: body.status });
  audit({ actor, event: 'crm.ticket_updated', status: 'ok', resourceType: 'ticket', resourceId: ticketId, metadata: { from: t.status, to: body.status } });
  return caseWorkspace(t.case_id, actor);
}

/* ================================================================== timeline */

/** Call events that matter to an agent, plus CRM events. Internal plumbing (tool calls, voice link, KB hits) is left out. */
const HIDDEN = /^(tool\.|voice\.|kb\.|input\.|account\.read|verification\.(readback|timing|started|card_noted)|tags\.updated|call\.tagged|analysis\.|summary\.generated|disclosure\.|demo\.)/;
/** Only these events carry a detail line an agent needs; the rest show their title alone. */
const DETAIL_OK = /^(verification\.(failed|retry)|facts\.|eligibility\.|actions?\.|consent\.|handoff\.(prepared|queued|no_agent|completed)|ticket\.|safety\.|case\.|systems\.conflict|source\.completed)/;
function buildTimeline(c: CaseRow, s: SessionRow | undefined) {
  const call = s
    ? listTimeline(s.id).filter((e) => !HIDDEN.test(e.type) && !(e.type === 'source.completed' && e.status === 'ok')).map((e) => ({ at: e.at, kind: e.type.split('.')[0], title: e.title, detail: DETAIL_OK.test(e.type) ? e.detail : null, status: e.status }))
    : [];
  const caseEv = all<{ event_type: string; detail_json: string; created_at: string }>("SELECT event_type, detail_json, created_at FROM case_events WHERE case_id = ? AND (event_type LIKE 'recommendation_%' OR event_type = 'ticket_updated')", [c.id]).map((e) => {
    const d = parseJson<Record<string, string>>(e.detail_json, {});
    const title = e.event_type.startsWith('recommendation_') ? `Agent ${e.event_type.replace('recommendation_', '')} the suggestion “${d.title ?? d.kind}”` : `Ticket ${d.ticketId} moved to ${String(d.status).replace('_', ' ')}`;
    return { at: e.created_at, kind: 'agent', title, detail: null as string | null, status: 'info' };
  });
  const out = [...call, ...caseEv].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (!out.length) out.push({ at: c.created_at, kind: 'case', title: 'Case opened', detail: null, status: 'info' });
  return out;
}
