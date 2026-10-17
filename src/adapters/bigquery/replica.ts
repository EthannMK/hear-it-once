/**
 * LOCAL WORKING COPY of the BigQuery bank tables (ADAPTER_MODE=bigquery).
 *
 * During a call every lookup goes to BigQuery live. The app still keeps its own copy of the bank
 * rows because its records point at them: a dispute row references the card and transaction it
 * disputes, the CRM shows a customer's cards, and the judge panel shows the demo card numbers.
 * At start-up the copy is replaced with what BigQuery holds, so record ids match on both sides.
 * Demo card numbers never come from BigQuery (it holds only their hashes); they are kept locally.
 */
import { all, db, run } from '../../db/db.ts';
import { log } from '../../lib/logger.ts';
import { bigQuery, T, type BqClient } from './client.ts';
import { metaCte, sh } from './readers.ts';

const COLS: Record<string, { local: string; select: (c: BqClient) => string; cols: string[] }> = {
  customers: {
    local: 'bank_customers',
    select: (c) => `WITH ${metaCte(c)} SELECT customer_id AS id, customer_number, full_name, dob_hash, phone_hash, phone_masked, email_masked, segment, account_standing,
      ${sh('contact_changed_at')} AS contact_changed_at, CURRENT_TIMESTAMP() AS profile_as_of, ${sh('created_at')} AS created_at FROM ${T(c, 'customers')} CROSS JOIN meta`,
    cols: ['id', 'customer_number', 'full_name', 'dob_hash', 'phone_hash', 'phone_masked', 'email_masked', 'segment', 'account_standing', 'contact_changed_at', 'profile_as_of', 'created_at'],
  },
  cards: {
    local: 'bank_cards',
    select: (c) => `SELECT card_id AS id, customer_id, last4, network, product, holder_role, holder_name, status, status_reason, CURRENT_TIMESTAMP() AS status_as_of, CURRENT_TIMESTAMP() AS created_at FROM ${T(c, 'cards')}`,
    cols: ['id', 'customer_id', 'last4', 'network', 'product', 'holder_role', 'holder_name', 'status', 'status_reason', 'status_as_of', 'created_at'],
  },
  transactions: {
    local: 'bank_transactions',
    select: (c) => `WITH ${metaCte(c)} SELECT transaction_id AS id, customer_id, card_id, kind, merchant_name, merchant_category, amount_minor, currency, ${sh('txn_at')} AS txn_at,
      ${sh('posted_at')} AS posted_at, status, entry_mode, auth_code, related_payment_id, CURRENT_TIMESTAMP() AS created_at FROM ${T(c, 'transactions')} CROSS JOIN meta`,
    cols: ['id', 'customer_id', 'card_id', 'kind', 'merchant_name', 'merchant_category', 'amount_minor', 'currency', 'txn_at', 'posted_at', 'status', 'entry_mode', 'auth_code', 'related_payment_id', 'created_at'],
  },
  fraud_alerts: {
    local: 'bank_fraud_alerts',
    select: (c) => `WITH ${metaCte(c)} SELECT alert_id AS id, customer_id, card_id, transaction_id, alert_type, risk_level, status, reported_card_status, reported_amount_minor, ${sh('created_at')} AS created_at FROM ${T(c, 'fraud_alerts')} CROSS JOIN meta`,
    cols: ['id', 'customer_id', 'card_id', 'transaction_id', 'alert_type', 'risk_level', 'status', 'reported_card_status', 'reported_amount_minor', 'created_at'],
  },
  payments: {
    local: 'bank_payments',
    select: (c) => `WITH ${metaCte(c)} SELECT payment_id AS id, customer_id, amount_minor, currency, ${sh('initiated_at')} AS initiated_at, channel, source_account_masked, status, status_detail,
      ${sh('posted_at')} AS posted_at, CAST(expected_posting_date AS STRING) AS expected_posting_date, ${sh('status_as_of')} AS status_as_of, CURRENT_TIMESTAMP() AS created_at FROM ${T(c, 'payments')} CROSS JOIN meta`,
    cols: ['id', 'customer_id', 'amount_minor', 'currency', 'initiated_at', 'channel', 'source_account_masked', 'status', 'status_detail', 'posted_at', 'expected_posting_date', 'status_as_of', 'created_at'],
  },
  fees: {
    local: 'bank_fees',
    select: (c) => `WITH ${metaCte(c)} SELECT fee_id AS id, customer_id, transaction_id, fee_type, amount_minor, currency, ${sh('charged_at')} AS charged_at, ${sh('reversed_at')} AS reversed_at, reversal_reason, CURRENT_TIMESTAMP() AS created_at FROM ${T(c, 'fees')} CROSS JOIN meta`,
    cols: ['id', 'customer_id', 'transaction_id', 'fee_type', 'amount_minor', 'currency', 'charged_at', 'reversed_at', 'reversal_reason', 'created_at'],
  },
  declines: {
    local: 'bank_declines',
    select: (c) => `WITH ${metaCte(c)} SELECT decline_id AS id, customer_id, card_id, merchant_name, amount_minor, currency, ${sh('declined_at')} AS declined_at, reason_code, customer_action, CURRENT_TIMESTAMP() AS created_at FROM ${T(c, 'declines')} CROSS JOIN meta`,
    cols: ['id', 'customer_id', 'card_id', 'merchant_name', 'amount_minor', 'currency', 'declined_at', 'reason_code', 'customer_action', 'created_at'],
  },
};

/** Replace the local bank rows with BigQuery's. Returns row counts, or throws (the local copy is then left as it was). */
export async function syncReplicaFromBigQuery(): Promise<Record<string, number>> {
  const c = bigQuery();
  const fetched: Record<string, Record<string, unknown>[]> = {};
  await Promise.all(Object.entries(COLS).map(async ([k, d]) => { fetched[k] = await c.query(d.select(c)); }));
  if (!fetched.customers.length) throw new Error('BigQuery dataset has no customers; run scripts/bigquery/setup.sh first.');
  // Demo card numbers live only in the app (BigQuery has hashes), so keep them across the swap.
  const pans = new Map(all<{ id: string; demo_pan: string | null }>('SELECT id, demo_pan FROM bank_cards WHERE demo_pan IS NOT NULL').map((r) => [r.id, r.demo_pan]));
  const d = db();
  const counts: Record<string, number> = {};
  d.exec('PRAGMA foreign_keys = OFF');
  d.exec('BEGIN');
  try {
    for (const [, def] of Object.entries(COLS).reverse()) run(`DELETE FROM ${def.local}`);
    for (const [k, def] of Object.entries(COLS)) {
      const sql = `INSERT INTO ${def.local} (${def.cols.join(',')}) VALUES (${def.cols.map(() => '?').join(',')})`;
      for (const r of fetched[k]) run(sql, def.cols.map((col) => { const v = r[col]; return v == null ? null : typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'number' ? v : String(v); }));
      counts[k] = fetched[k].length;
    }
    for (const [id, pan] of pans) run('UPDATE bank_cards SET demo_pan = ? WHERE id = ?', [pan, id]);
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  } finally {
    d.exec('PRAGMA foreign_keys = ON');
  }
  log.info('local copy of the BigQuery bank tables refreshed', counts);
  return counts;
}

/** Lifetime view of a customer's account straight from BigQuery, for the CRM. */
export async function customerHistory(customerId: string) {
  const c = bigQuery();
  const [sum] = await c.query<Record<string, unknown>>(
    `WITH ${metaCte(c)}
     SELECT COUNT(*) AS n, SUM(IF(amount_minor > 0 AND kind = 'purchase', amount_minor, 0)) AS spend_minor,
            MIN(${sh('txn_at')}) AS first_at, MAX(${sh('txn_at')}) AS last_at, COUNTIF(source = 'kaggle_sparkov') AS from_kaggle
     FROM ${T(c, 'transactions')} CROSS JOIN meta WHERE customer_id = @customerId`, { customerId });
  const cats = await c.query<{ category: string; n: number; spend_minor: number }>(
    `SELECT IFNULL(merchant_category, 'other') AS category, COUNT(*) AS n, SUM(amount_minor) AS spend_minor
     FROM ${T(c, 'transactions')} WHERE customer_id = @customerId AND kind = 'purchase' GROUP BY category ORDER BY spend_minor DESC LIMIT 5`, { customerId });
  return {
    source: `BigQuery ${c.project}.${c.dataset}`,
    transactions: Number(sum?.n ?? 0),
    spendMinor: Number(sum?.spend_minor ?? 0),
    firstAt: (sum?.first_at as string) ?? null,
    lastAt: (sum?.last_at as string) ?? null,
    fromKaggle: Number(sum?.from_kaggle ?? 0),
    topCategories: cats.map((x) => ({ category: x.category.replace(/_/g, ' '), count: Number(x.n), spendMinor: Number(x.spend_minor) })),
  };
}
