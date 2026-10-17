/**
 * Export the SYNTHETIC Northstar seed as newline-delimited JSON, one file per BigQuery table.
 * Usage: npx tsx scripts/bigquery/export-seed.ts <out-dir>
 *
 * It builds the same seed the app builds (19 demo customers, 48 background customers with their
 * history) in a throw-away in-memory database and writes it out. Card numbers are never written:
 * cards carry only a SHA-256 of the demo number. dataset_meta.anchor_at records "now", which the
 * app uses as the demo clock (see src/adapters/bigquery/readers.ts).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

process.env.ADAPTER_MODE = 'mock';
process.env.NODE_ENV = process.env.NODE_ENV ?? 'development';
const { openDb, setDb, migrate, all } = await import('../../src/db/db.ts');
const { seedAll } = await import('../../src/db/seed.ts');
const { KB_ARTICLES } = await import('../../src/kb/kb.ts');
const { INFO, BRANCHES } = await import('../../src/kb/bank-info.ts');

const out = process.argv[2] ?? 'bq-export';
mkdirSync(out, { recursive: true });
const d = openDb(':memory:');
setDb(d);
migrate(d);
seedAll({ history: true });

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const json = (v: unknown) => (typeof v === 'string' && /^[[{]/.test(v) ? JSON.parse(v) : v);
function write(name: string, rows: Record<string, unknown>[]) {
  writeFileSync(join(out, `${name}.json`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(`${name}: ${rows.length} rows`);
}
const pick = (sql: string) => all<Record<string, unknown>>(sql);

write('dataset_meta', [{ anchor_at: new Date().toISOString(), generated_by: 'scripts/bigquery/export-seed.ts', note: 'Synthetic Northstar Bank demo data. Timestamps are shifted forward by (now - anchor_at) when read.' }]);
write('customers', pick(`SELECT id AS customer_id, customer_number, full_name, dob_hash, phone_hash, phone_masked, email_masked, segment, account_standing, contact_changed_at, created_at FROM bank_customers`));
write('cards', pick(`SELECT * FROM bank_cards`).map((c) => ({
  card_id: c.id, customer_id: c.customer_id, last4: c.last4, network: c.network, product: c.product, holder_role: c.holder_role, holder_name: c.holder_name,
  status: c.status, status_reason: c.status_reason, pan_sha256: c.demo_pan ? sha(String(c.demo_pan).replace(/\D/g, '')) : null, created_at: c.created_at,
})));
write('transactions', pick(`SELECT id AS transaction_id, customer_id, card_id, kind, merchant_name, merchant_category, amount_minor, currency, txn_at, posted_at, status, entry_mode, auth_code, related_payment_id FROM bank_transactions`)
  .map((t) => ({ ...t, source: 'northstar_seed', is_fraud_label: null })));
write('fraud_alerts', pick(`SELECT id AS alert_id, customer_id, card_id, transaction_id, alert_type, risk_level, status, reported_card_status, reported_amount_minor, created_at FROM bank_fraud_alerts`));
write('payments', pick(`SELECT id AS payment_id, customer_id, amount_minor, currency, initiated_at, channel, source_account_masked, status, status_detail, posted_at, expected_posting_date, status_as_of FROM bank_payments`));
write('fees', pick(`SELECT id AS fee_id, customer_id, transaction_id, fee_type, amount_minor, currency, charged_at, reversed_at, reversal_reason FROM bank_fees`));
write('declines', pick(`SELECT id AS decline_id, customer_id, card_id, merchant_name, amount_minor, currency, declined_at, reason_code, customer_action FROM bank_declines`));
write('dispute_rules', pick(`SELECT * FROM bank_dispute_rules`).map((r) => ({
  rule_code: r.rule_code, reason: r.reason, description: r.description, max_days_since_txn: r.max_days_since_txn, min_amount_minor: r.min_amount_minor,
  allowed_entry_modes: json(r.allowed_entry_modes), requires_card_block: !!r.requires_card_block, required_fields: json(r.required_fields), automatable: !!r.automatable, active: !!r.active, version: r.version,
})));
write('fee_policies', pick(`SELECT * FROM bank_fee_policies`).map((p) => ({ rule_code: p.rule_code, fee_type: p.fee_type, reversible: !!p.reversible, description: p.description, version: p.version })));
write('branches', BRANCHES.map((b, i) => ({ branch_id: `BR-${String(i + 1).padStart(2, '0')}`, ...b })));
write('kb_documents', [
  ...KB_ARTICLES.map((a) => ({ doc_id: a.id, source: 'northstar', title: a.title, content: [a.excerpt, ...a.steps].join('\n'), categories: a.categories, keywords: a.keywords, steps: a.steps, rule_refs: a.ruleRefs, intent: null, version: a.version, license: 'synthetic (this project)' })),
  ...INFO.map((e) => ({ doc_id: e.id, source: 'northstar_info', title: e.topic, content: e.answer, categories: ['general_information'], keywords: e.keywords, steps: [], rule_refs: [], intent: null, version: 'demo-2026.10', license: 'synthetic (this project)' })),
]);
