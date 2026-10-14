/**
 * Reproducible SYNTHETIC seed data. Dates are relative to "now" so the demo stays current.
 * Nothing here is real customer data. `resetDemoData()` wipes and re-seeds synthetic data
 * only (the database contains nothing else).
 */
import { db, run, get, all } from './db.ts';
import { nowIso, nowMs } from '../lib/clock.ts';
import { newId } from '../lib/ids.ts';
import { maskPhone } from '../lib/redact.ts';
import { hashDob, hashPhone } from '../adapters/mock/identity.ts';
import { seedRoles, createStaffUser } from '../auth/rbac.ts';
import { SCENARIOS, type ScenarioDef } from './scenarios.ts';
import { seedIllustrativeHistory } from './seed-history.ts';

const iso = (daysAgo: number, hour = 12, minute = 0) => {
  const d = new Date(nowMs() - daysAgo * 86_400_000);
  d.setUTCHours(hour, minute, 0, 0);
  if (d.getTime() > nowMs()) d.setTime(nowMs() - 60_000 * (minute + 1));
  return d.toISOString();
};

export const STAFF = [
  { id: 'STF-AGENT-1', name: 'Jordan Lee (demo agent)', role: 'agent' as const },
  { id: 'STF-AGENT-2', name: 'Sam Rivera (demo agent)', role: 'agent' as const },
  { id: 'STF-QA-1', name: 'Casey Morgan (demo QA)', role: 'qa' as const },
  { id: 'STF-ADMIN-1', name: 'Robin Patel (demo admin)', role: 'admin' as const },
];

export function insertCustomer(c: { id: string; number: string; name: string; dob: string; phone: string }, opts: { standing?: string; contactChangedDaysAgo?: number } = {}): void {
  run(
    `INSERT INTO bank_customers (id, customer_number, full_name, dob_hash, phone_hash, phone_masked, email_masked, segment, account_standing, contact_changed_at, profile_as_of, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [c.id, c.number, c.name, hashDob(c.dob), hashPhone(c.phone), maskPhone(c.phone), `${c.name[0].toLowerCase()}•••@example.test`, 'standard', opts.standing ?? 'good',
      opts.contactChangedDaysAgo != null ? iso(opts.contactChangedDaysAgo) : null, nowIso(), nowIso()],
  );
}

/** True when the digits pass the Luhn checksum (real card numbers do). */
export const luhnValid = (digits: string): boolean => {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
};

/**
 * A FICTIONAL 16-digit demo card number ending in `last4`. It deliberately FAILS the Luhn
 * checksum, so it can never be a real card number. Shown unmasked on the demo screens only.
 */
export function demoPan(n: number, last4: string): string {
  const head = `4999 ${String(n).padStart(2, '0')}`;
  for (let mid = 0; mid < 100; mid++) {
    const digits = `4999${String(n).padStart(2, '0')}${String(mid).padStart(2, '0')}${String(n * 37 % 10000).padStart(4, '0')}${last4}`;
    if (!luhnValid(digits)) return digits.replace(/(\d{4})(?=\d)/g, '$1 ');
  }
  return `${head}00 0000 ${last4}`;
}

export function insertCard(id: string, customerId: string, last4: string, holder: string, opts: { network?: string; role?: 'primary' | 'additional'; status?: string; pan?: string } = {}): void {
  run(
    `INSERT INTO bank_cards (id, customer_id, last4, network, product, holder_role, holder_name, status, status_as_of, created_at, demo_pan) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [id, customerId, last4, opts.network ?? 'Visa', 'Everyday Rewards Credit Card', opts.role ?? 'primary', holder, opts.status ?? 'active', nowIso(), nowIso(), opts.pan ?? null],
  );
}

interface TxnSpec {
  id?: string;
  card?: string | null;
  kind?: string;
  merchant: string | null;
  category?: string | null;
  amount: number; // minor units
  daysAgo: number;
  hour?: number;
  status?: 'pending' | 'posted' | 'reversed';
  mode?: string | null;
  auth?: string | null;
}

export function insertTxn(customerId: string, t: TxnSpec): string {
  const id = t.id ?? newId('TXN');
  const at = iso(t.daysAgo, t.hour ?? 14, 5);
  const status = t.status ?? 'posted';
  run(
    `INSERT INTO bank_transactions (id, customer_id, card_id, kind, merchant_name, merchant_category, amount_minor, currency, txn_at, posted_at, status, entry_mode, auth_code, created_at)
     VALUES (?,?,?,?,?,?,?,'USD',?,?,?,?,?,?)`,
    [id, customerId, t.card ?? null, t.kind ?? 'purchase', t.merchant, t.category ?? null, t.amount, at, status === 'posted' ? iso(Math.max(0, t.daysAgo - 1), 6) : null, status, t.mode ?? null, t.auth ?? null, nowIso()],
  );
  return id;
}

function baseline(customerId: string, card: string): void {
  insertTxn(customerId, { card, merchant: 'Greenway Grocers', category: 'grocery', amount: 6412, daysAgo: 9, mode: 'chip_pin', auth: 'A10021' });
  insertTxn(customerId, { card, merchant: 'Metro Fuel', category: 'fuel', amount: 4850, daysAgo: 6, mode: 'contactless', auth: 'A10022' });
  insertTxn(customerId, { card, merchant: 'City Pharmacy', category: 'health', amount: 1899, daysAgo: 4, mode: 'contactless', auth: 'A10023' });
  insertTxn(customerId, { card, merchant: 'Bookhaven Online', category: 'retail', amount: 2750, daysAgo: 12, mode: 'ecommerce', auth: 'A10024' });
  const pay = newId('PAY');
  run(
    `INSERT INTO bank_payments (id, customer_id, amount_minor, initiated_at, channel, source_account_masked, status, posted_at, status_as_of, created_at)
     VALUES (?,?,?,?,?,?, 'posted', ?, ?, ?)`,
    [pay, customerId, 35000, iso(34), 'online_banking', 'Checking ••••6612', iso(33), nowIso(), nowIso()],
  );
  insertTxn(customerId, { kind: 'payment', merchant: 'Payment — thank you', amount: -35000, daysAgo: 33 });
}

function addFault(s: ScenarioDef): void {
  for (const f of s.faults ?? []) {
    const scope = f.scope ?? 'customer';
    run('INSERT OR IGNORE INTO mock_faults (scope, scope_ref, target, fault, enabled, note) VALUES (?,?,?,?,1,?)', [
      scope,
      scope === 'scenario' ? s.id : s.customer.id,
      f.target,
      f.fault,
      `Demo scenario ${s.id}: ${s.title}`,
    ]);
  }
}

function insertFee(customerId: string, type: string, amount: number, daysAgo: number, reversedDaysAgo?: number): string {
  const txn = insertTxn(customerId, { kind: 'fee', merchant: type === 'late_payment' ? 'Late payment fee' : 'Fee', amount, daysAgo });
  const id = newId('FEE');
  run('INSERT INTO bank_fees (id, customer_id, transaction_id, fee_type, amount_minor, charged_at, reversed_at, reversal_reason, created_at) VALUES (?,?,?,?,?,?,?,?,?)', [
    id, customerId, txn, type, amount, iso(daysAgo), reversedDaysAgo != null ? iso(reversedDaysAgo) : null, reversedDaysAgo != null ? 'FP-LATE-01' : null, nowIso(),
  ]);
  return id;
}

function seedReferenceData(): void {
  const rules = [
    ['DR-FRAUD-01', 'fraud_unrecognised', 'Unrecognised (fraud) card-not-present or swiped transaction within 120 days. Card must be blocked. Chip-and-PIN transactions require agent investigation.', 120, 100, ['ecommerce', 'manual', 'recurring', 'swipe', 'contactless'], 1,
      ['cardRef', 'transactionId', 'merchant', 'amountMinor', 'currency', 'transactionDate', 'reasonCode', 'customerExplanation'], 1],
    ['DR-DUP-01', 'duplicate_charge', 'Duplicate charge: two POSTED transactions, same merchant and amount, within 24 hours, no merchant credit. Evidence: duplicate transaction reference.', 120, 100, ['ecommerce', 'manual', 'recurring', 'swipe', 'contactless', 'chip', 'chip_pin'], 0,
      ['cardRef', 'transactionId', 'merchant', 'amountMinor', 'currency', 'transactionDate', 'reasonCode', 'customerExplanation', 'evidence:duplicate_transaction_ref'], 1],
    ['DR-AMT-01', 'incorrect_amount', 'Incorrect amount: requires receipt or merchant documentation; agent-assisted only.', 120, 100, ['ecommerce', 'manual', 'recurring', 'swipe', 'contactless', 'chip', 'chip_pin'], 0,
      ['cardRef', 'transactionId', 'merchant', 'amountMinor', 'currency', 'transactionDate', 'reasonCode', 'customerExplanation', 'evidence:receipt'], 0],
  ] as const;
  for (const r of rules) {
    run(
      `INSERT INTO bank_dispute_rules (rule_code, reason, description, max_days_since_txn, min_amount_minor, allowed_entry_modes, requires_card_block, required_fields, automatable, version)
       VALUES (?,?,?,?,?,?,?,?,?,'2026.10-demo')`,
      [r[0], r[1], r[2], r[3], r[4], JSON.stringify(r[5]), r[6], JSON.stringify(r[7]), r[8]],
    );
  }
  const fees = [
    ['FP-LATE-01', 'late_payment', 1, 'One courtesy late-payment fee reversal per 12 months for accounts in good standing, up to the configured limit.'],
    ['FP-ANNUAL-01', 'annual_fee', 0, 'Annual fees are not reversible by the assistant; agent review only.'],
    ['FP-FX-01', 'foreign_transaction', 0, 'Foreign transaction fees are not reversible by the assistant.'],
    ['FP-CASH-01', 'cash_advance', 0, 'Cash advance fees are not reversible by the assistant.'],
  ] as const;
  for (const f of fees) run("INSERT INTO bank_fee_policies (rule_code, fee_type, reversible, description, version) VALUES (?,?,?,?,'2026.10-demo')", [...f]);
}

function seedScenarioCustomers(): void {
  for (const s of SCENARIOS) seedScenario(s);
}

/** Seed one scenario's synthetic customer, card, transactions, faults and special fixtures. */
export function seedScenario(s: ScenarioDef): void {
  {
    const cu = s.customer;
    insertCustomer(cu);
    const card = `CRD-${cu.id.slice(4)}A`;
    const last4 = String(4000 + Number(cu.id.slice(4)) * 7).slice(-4);
    insertCard(card, cu.id, last4, cu.name, { network: Number(cu.id.slice(4)) % 2 ? 'Visa' : 'Mastercard', pan: demoPan(Number(cu.id.slice(4)) - 1000, last4) });
    baseline(cu.id, card);
    addFault(s);

    switch (s.id) {
      case 'S01': {
        const t = insertTxn(cu.id, { card, merchant: 'NOVAPLAY DIGITAL', category: 'digital_goods', amount: 24900, daysAgo: 3, mode: 'ecommerce', auth: 'N77310' });
        insertTxn(cu.id, { card, merchant: 'CITYLINK RIDES', category: 'transport', amount: 8450, daysAgo: 4, hour: 23, mode: 'ecommerce', auth: 'C40812' });
        run(`INSERT INTO bank_fraud_alerts (id, customer_id, card_id, transaction_id, alert_type, risk_level, status, reported_card_status, reported_amount_minor, created_at)
             VALUES (?,?,?,?, 'suspicious_ecommerce', 'medium', 'open', 'active', 24900, ?)`, [newId('FRA'), cu.id, card, t, iso(3, 15)]);
        break;
      }
      case 'S03':
        insertTxn(cu.id, { card, merchant: 'Harbor Grill', category: 'restaurant', amount: 8640, daysAgo: 2, hour: 20, mode: 'chip', auth: 'H55101' });
        insertTxn(cu.id, { card, merchant: 'Harbor Grill', category: 'restaurant', amount: 8640, daysAgo: 2, hour: 21, status: 'pending', mode: 'chip', auth: 'H55102' });
        break;
      case 'S04':
        run(`INSERT INTO bank_payments (id, customer_id, amount_minor, initiated_at, channel, source_account_masked, status, status_detail, status_as_of, created_at)
             VALUES (?,?,50000,?, 'online_banking', 'Checking ••••6612', 'pending', 'received_awaiting_settlement', ?, ?)`, [newId('PAY'), cu.id, iso(2, 9), nowIso(), nowIso()]);
        break;
      case 'S19':
        run(`INSERT INTO bank_declines (id, customer_id, card_id, merchant_name, amount_minor, declined_at, reason_code, customer_action, created_at)
             VALUES (?,?,?,?,?,?, 'travel_security_rule', 'Confirm the trip with an agent so a travel note can be added.', ?)`, [newId('DEC'), cu.id, card, 'EuroRail Booking', 18900, iso(0, 8), nowIso()]);
        break;
      case 'S05':
      case 'S18':
        insertFee(cu.id, 'late_payment', 2900, 5);
        break;
      case 'S06':
        insertFee(cu.id, 'late_payment', 2900, 4);
        insertFee(cu.id, 'late_payment', 2900, 130, 128);
        break;
      case 'S07': {
        run(`INSERT INTO bank_payments (id, customer_id, amount_minor, initiated_at, channel, source_account_masked, status, status_detail, status_as_of, created_at)
             VALUES (?,?,30000,?, 'bank_transfer', 'Savings ••••2209', 'pending', 'under_investigation_trace_requested', ?, ?)`, [newId('PAY'), cu.id, iso(8, 10), nowIso(), nowIso()]);
        seedPriorCase(cu.id);
        break;
      }
      case 'S11':
        insertTxn(cu.id, { card, merchant: 'QUICKSTREAM MEDIA', category: 'digital_goods', amount: 5999, daysAgo: 2, mode: 'recurring', auth: 'Q22001' });
        break;
      case 'S12': {
        const t = insertTxn(cu.id, { card, merchant: 'ORBIT ELECTRONICS', category: 'electronics', amount: 124900, daysAgo: 1, mode: 'ecommerce', auth: 'O90001' });
        // Fraud system's view of the card status disagrees with the card system (active).
        run(`INSERT INTO bank_fraud_alerts (id, customer_id, card_id, transaction_id, alert_type, risk_level, status, reported_card_status, reported_amount_minor, created_at)
             VALUES (?,?,?,?, 'high_value_ecommerce', 'high', 'open', 'blocked', 124900, ?)`, [newId('FRA'), cu.id, card, t, iso(1, 16)]);
        break;
      }
      case 'S16':
        insertTxn(cu.id, { card, merchant: 'LUMEN TRAVEL', category: 'travel', amount: 41250, daysAgo: 5, mode: 'ecommerce', auth: 'L31007' });
        break;
      default:
        break;
    }
    seedCrossTopic(s, card);
  }
}

/**
 * The Northstar demo profiles are not locked to one story: every profile also has an ordinary
 * late fee and a recent decline, so a caller can change topic and still get a real lookup.
 */
const CROSS_TOPIC: Record<string, { fee: boolean; decline?: { merchant: string; amount: number; reason: string; action: string } }> = {
  S01: { fee: true, decline: { merchant: 'Skyline Cinemas', amount: 3200, reason: 'insufficient_available_credit', action: 'Make a payment to restore available credit, then try again.' } },
  S02: { fee: true, decline: { merchant: 'Fresh Basket Market', amount: 5480, reason: 'merchant_category_restricted', action: 'Ask an agent whether the merchant category restriction can be reviewed.' } },
  S05: { fee: false, decline: { merchant: 'Metro Fuel', amount: 7600, reason: 'insufficient_available_credit', action: 'Make a payment to restore available credit, then try again.' } },
  S08: { fee: true, decline: { merchant: 'Pacific Air', amount: 42100, reason: 'travel_security_rule', action: 'Confirm the trip with an agent so a travel note can be added.' } },
  S19: { fee: true },
};

function seedCrossTopic(s: ScenarioDef, card: string): void {
  const x = CROSS_TOPIC[s.id];
  if (!x) return;
  if (x.fee) insertFee(s.customer.id, 'late_payment', 2900, 40);
  if (x.decline) {
    run(`INSERT INTO bank_declines (id, customer_id, card_id, merchant_name, amount_minor, declined_at, reason_code, customer_action, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      [newId('DEC'), s.customer.id, card, x.decline.merchant, x.decline.amount, iso(1, 10), x.decline.reason, x.decline.action, nowIso()]);
  }
}

function seedPriorCase(customerId: string): void {
  const sid = newId('SES');
  const at = iso(3, 10);
  run(
    `INSERT INTO call_sessions (id, correlation_id, channel, data_origin, scenario_id, state, customer_id, verification_status, verification_level, eligible, outcome, resolution_status,
       issue_type, issue_statement, answered_at, verified_at, case_created_at, ended_at, created_at, updated_at)
     VALUES (?,?, 'text_simulator', 'seeded_illustrative', 'S07-prior', 'ended', ?, 'verified', 'standard', 1, 'ended_unresolved', 'unresolved', 'payment_not_showing',
       'I paid $300 last week and it is not on my card.', ?, ?, ?, ?, ?, ?)`,
    [sid, newId('COR'), customerId, at, at, at, at, at, at],
  );
  run(
    `INSERT INTO cases (id, session_id, customer_id, issue_type, status, resolution_status, verification_outcome, customer_reported, summary, next_steps, data_origin, created_at, updated_at)
     VALUES (?,?,?, 'payment_not_showing', 'open', 'unresolved', 'verified', ?, ?, ?, 'seeded_illustrative', ?, ?)`,
    [newId('CASE'), sid, customerId, 'Customer paid $300.00 by bank transfer and it is not showing on the card account.',
      'Customer reported: $300.00 payment not showing. Bank systems confirmed: payment record exists with status pending; no posting date supplied by the payment system. Actions completed: none. Status: unresolved.',
      'Payment operations to trace the transfer. Customer to be updated when the trace completes.', at, at],
  );
}

export function seedAll(opts: { history?: boolean } = {}): void {
  const d = db();
  d.exec('BEGIN');
  try {
    seedRoles();
    for (const s of STAFF) createStaffUser(s.id, s.name, s.role);
    seedReferenceData();
    seedScenarioCustomers();
    run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('seeded_at', ?)", [nowIso()]);
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
  if (opts.history !== false) seedIllustrativeHistory();
}

const DATA_TABLES = [
  'qa_reviews', 'session_events', 'hold_intervals', 'handoffs', 'disputes', 'action_status_history', 'action_operations', 'consents', 'proposals',
  'case_events', 'cases', 'integration_calls', 'retrieval_snapshots', 'otp_challenges', 'verification_attempts', 'conversation_turns', 'call_sessions',
  'audit_events', 'bank_operations', 'bank_declines', 'bank_fees', 'bank_payments', 'bank_fraud_alerts', 'bank_transactions', 'bank_cards', 'bank_customers',
  'bank_dispute_rules', 'bank_fee_policies', 'mock_faults', 'staff_users', 'role_permissions', 'roles', 'app_settings',
];

/** Wipe and re-seed. The database holds synthetic demo data only, so this is safe by design. */
export function resetDemoData(opts: { history?: boolean } = {}): void {
  const d = db();
  d.exec('PRAGMA foreign_keys = OFF');
  d.exec('BEGIN');
  try {
    for (const t of DATA_TABLES) d.exec(`DELETE FROM ${t}`);
    d.exec("DELETE FROM sqlite_sequence");
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  } finally {
    d.exec('PRAGMA foreign_keys = ON');
  }
  seedAll(opts);
}

/**
 * Reset ONE demo scenario so it can be replayed: removes every call, case, action, dispute and
 * handoff for that synthetic customer and re-seeds its fixtures and default faults. Audit
 * events are kept (they are an append-only record). Synthetic data only.
 */
export function resetScenario(id: string): boolean {
  const sc = SCENARIOS.find((x) => x.id === id);
  if (!sc) return false;
  const cid = sc.customer.id;
  const d = db();
  d.exec('BEGIN');
  try {
    const sessions = all<{ id: string }>("SELECT id FROM call_sessions WHERE customer_id = ? OR scenario_id IN (?, ?)", [cid, id, `${id}-prior`]).map((r) => r.id);
    const inList = sessions.map(() => '?').join(',') || "''";
    run(`DELETE FROM disputes WHERE customer_id = ? OR session_id IN (${inList})`, [cid, ...sessions]);
    run(`DELETE FROM handoffs WHERE session_id IN (${inList})`, sessions);
    run(`DELETE FROM action_operations WHERE customer_id = ? OR session_id IN (${inList})`, [cid, ...sessions]);
    run(`DELETE FROM consents WHERE session_id IN (${inList})`, sessions);
    run(`DELETE FROM proposals WHERE session_id IN (${inList})`, sessions);
    run(`DELETE FROM cases WHERE customer_id = ? OR session_id IN (${inList})`, [cid, ...sessions]);
    run(`DELETE FROM call_sessions WHERE id IN (${inList})`, sessions);
    run('DELETE FROM bank_declines WHERE customer_id = ?', [cid]);
    run('DELETE FROM bank_fees WHERE customer_id = ?', [cid]);
    run('DELETE FROM bank_payments WHERE customer_id = ?', [cid]);
    run('DELETE FROM bank_fraud_alerts WHERE customer_id = ?', [cid]);
    run('DELETE FROM bank_transactions WHERE customer_id = ?', [cid]);
    run('DELETE FROM bank_cards WHERE customer_id = ?', [cid]);
    run('DELETE FROM bank_customers WHERE id = ?', [cid]);
    run("DELETE FROM mock_faults WHERE (scope = 'customer' AND scope_ref = ?) OR (scope = 'scenario' AND scope_ref = ?)", [cid, id]);
    seedScenario(sc);
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
  return true;
}

export function isSeeded(): boolean {
  return !!get("SELECT value FROM app_settings WHERE key = 'seeded_at'");
}
