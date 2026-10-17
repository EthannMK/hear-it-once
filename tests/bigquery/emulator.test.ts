/**
 * BIGQUERY MODE against a local BigQuery emulator (goccy/bigquery-emulator).
 *
 * Skipped unless BQ_EMULATOR is set, e.g.
 *   ./bigquery-emulator --project=hear-it-once --dataset=northstar_bank --port=9050 &
 *   BQ_EMULATOR=http://localhost:9050 npx vitest run tests/bigquery
 *
 * It loads the real schema and the exported synthetic seed into the emulator, then drives the
 * BigQuery adapters and a full call through the HTTP API. Vector search and ML.GENERATE_EMBEDDING
 * do not exist in the emulator, so knowledge search is tested in keyword mode here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { setup, Caller } from '../e2e/harness.ts';
import { env, setEnvForTests } from '../../src/config/env.ts';
import { setPolicyForTests } from '../../src/config/policy.ts';
import { adapters, setAdapters } from '../../src/adapters/registry.ts';
import { bigQuery } from '../../src/adapters/bigquery/client.ts';
import { syncReplicaFromBigQuery, customerHistory } from '../../src/adapters/bigquery/replica.ts';
import { knowledgeBase, setKnowledgeBaseForTests } from '../../src/kb/kb.ts';
import { all, get } from '../../src/db/db.ts';
import { refreshDemoFixtures } from '../../src/db/seed.ts';
import { allProfileCards } from '../../src/live/profiles.ts';

const EMU = process.env.BQ_EMULATOR;
const P = 'hear-it-once';
const D = 'northstar_bank';
const ctx = { correlationId: 'test' };
const original = { ...env() };
let app: FastifyInstance;
let exportDir = '';

async function loadSchema() {
  const c = bigQuery();
  const sql = readFileSync('scripts/bigquery/schema.sql', 'utf8').replace(/PROJECT_ID/g, P).replace(/\.DATASET\./g, `.${D}.`);
  const statements = sql.split(/;\s*\n/).map((s) => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean)
    // The emulator does not support clustering or table options; BigQuery does.
    .map((s) => s.replace(/\)\s*CLUSTER BY[^\n]*?(?=\s*(OPTIONS|$))/s, ')').replace(/\s*OPTIONS\s*\([^)]*\)\s*$/s, ''));
  for (const s of statements) {
    const name = s.match(/`[^`]+\.([a-z_]+)`/)![1];
    await c.query(`DROP TABLE IF EXISTS \`${P}.${D}.${name}\``).catch(() => undefined);
    await c.query(s.replace('IF NOT EXISTS ', ''));
  }
}

async function loadExport() {
  const c = bigQuery();
  for (const f of readdirSync(exportDir).filter((x) => x.endsWith('.json'))) {
    const rows = readFileSync(join(exportDir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    for (let i = 0; i < rows.length; i += 200) await c.insert(f.replace('.json', ''), rows.slice(i, i + 200));
  }
  // One Bitext-style FAQ document, for the keyword search path.
  await c.insert('kb_documents', [{ doc_id: 'FAQ-recover_swallowed_card-1', source: 'bitext', title: 'Recover swallowed card', content: 'If a cash machine swallowed your card, block it in the Northstar app and ask the branch that runs the machine whether it can be returned.', categories: ['atm'], keywords: [], steps: [], rule_refs: [], intent: 'recover_swallowed_card', sample_questions: ['the machine swallowed my card'], version: 'bitext', license: 'CDLA-Sharing-1.0 (Bitext)' }]);
}

describe.skipIf(!EMU)('BigQuery adapters (emulator)', () => {
  beforeAll(async () => {
    exportDir = mkdtempSync(join(tmpdir(), 'bq-export-'));
    execFileSync('npx', ['tsx', '--disable-warning=ExperimentalWarning', 'scripts/bigquery/export-seed.ts', exportDir], { stdio: 'ignore' });
    app = await setup();
    setEnvForTests({ ADAPTER_MODE: 'bigquery', BQ_PROJECT: P, BQ_DATASET: D, BQ_LOCATION: 'US', BQ_API_ENDPOINT: EMU, BQ_EMBEDDING_MODEL: 'off', ADAPTER_TIMEOUT_MS: 8000, ACTION_TIMEOUT_MS: 12000 });
    setPolicyForTests(null);
    setAdapters(null);
    await loadSchema();
    await loadExport();
    expect(adapters().mode).toBe('bigquery');
    await syncReplicaFromBigQuery();
  }, 120_000);
  afterAll(async () => {
    setEnvForTests(original);
    setAdapters(null);
    setKnowledgeBaseForTests(null);
    await app?.close();
  });

  it('reads customer, cards, transactions, alerts, payments, fees, declines and rules from BigQuery', async () => {
    const r = adapters().readers;
    expect((await r.customer_profile.getProfile(ctx, 'CUS-1001')).data.fullName).toBe('Alex Morgan');
    const cards = (await r.card_status.listCards(ctx, 'CUS-1001')).data;
    expect(cards[0]).toMatchObject({ cardRef: 'CRD-1001A', status: 'active' });
    const txns = (await r.transactions.listTransactions(ctx, 'CUS-1001', 120)).data;
    expect(txns.some((t) => t.merchant === 'NOVAPLAY DIGITAL' && t.amountMinor === 24900)).toBe(true);
    expect((await r.fraud_alerts.listAlerts(ctx, 'CUS-1001')).data[0]).toMatchObject({ status: 'open', reportedCardStatus: 'active' });
    expect((await r.payment_status.listPayments(ctx, 'CUS-1004', 60)).data.some((p) => p.status === 'pending')).toBe(true);
    const fees = (await r.fee_policy.getFeeData(ctx, 'CUS-1005')).data;
    expect(fees.fees.some((f) => f.feeType === 'late_payment' && !f.reversedAt)).toBe(true);
    expect(fees.policies.length).toBe(4);
    expect((await r.card_declines.listDeclines(ctx, 'CUS-1019', 30)).data[0].reasonCode).toBe('travel_security_rule');
    const rules = (await r.dispute_rules.getRules(ctx)).data;
    expect(rules.find((x) => x.ruleCode === 'DR-FRAUD-01')!.allowedEntryModes).toContain('ecommerce');
    await expect(r.customer_profile.getProfile(ctx, 'CUS-NOPE')).rejects.toThrow();
  });

  it('checks identity against hashes only: card numbers never reach BigQuery', async () => {
    const pan = allProfileCards().find((p) => p.id === 'alex-morgan')!.cardNumber!;
    const id = adapters().identity;
    expect(await id.checkCardNumber(ctx, 'CUS-1001', pan)).toBe(true);
    expect(await id.checkCardNumber(ctx, 'CUS-1001', pan.replace(/\d$/, (d) => String((Number(d) + 1) % 10)))).toBe(false);
    expect(await id.identifyByCardNumber(ctx, pan)).toEqual({ customerId: 'CUS-1001' });
    const stored = await bigQuery().query<{ n: number }>(`SELECT COUNT(*) AS n FROM \`${P}.${D}.cards\` WHERE pan_sha256 IS NOT NULL`);
    expect(Number(stored[0].n)).toBeGreaterThan(0);
    expect(readFileSync(join(exportDir, 'cards.json'), 'utf8')).not.toContain(pan.replace(/\D/g, ''));
  });

  it('keeps the local copy in step with BigQuery ids, and keeps the demo card numbers local', async () => {
    const bqIds = (await bigQuery().query<{ transaction_id: string }>(`SELECT transaction_id FROM \`${P}.${D}.transactions\` WHERE customer_id = 'CUS-1001'`)).map((r) => r.transaction_id).sort();
    const localIds = all<{ id: string }>("SELECT id FROM bank_transactions WHERE customer_id = 'CUS-1001'").map((r) => r.id).sort();
    expect(localIds).toEqual(bqIds);
    expect(get<{ demo_pan: string | null }>("SELECT demo_pan FROM bank_cards WHERE id = 'CRD-1001A'")!.demo_pan).toBeTruthy();
  });

  it('a whole call: lookups and the block, replacement and dispute are written to BigQuery', async () => {
    const pan = allProfileCards().find((p) => p.id === 'alex-morgan')!.cardNumber!;
    const c = new Caller(app);
    await c.start(undefined, { profileId: 'alex-morgan' });
    await c.say("There's a Novaplay charge for $249 I didn't make");
    await c.say(pan);
    await c.say('yes');
    expect(c.view.proposal?.actions?.length).toBeGreaterThan(0);
    await c.consent('accept');
    const done = c.ops().filter((o: any) => o.status === 'succeeded').map((o: any) => o.action_type).sort();
    expect(done).toEqual(['block_card', 'order_replacement', 'submit_dispute']);
    const q = (t: string) => bigQuery().query<Record<string, unknown>>(`SELECT * FROM \`${P}.${D}.${t}\` WHERE customer_id = 'CUS-1001'`);
    expect((await q('card_status_events')).some((e) => e.status === 'blocked')).toBe(true);
    expect(await q('replacement_orders')).toHaveLength(1);
    expect((await q('dispute_submissions'))[0]).toMatchObject({ merchant: 'NOVAPLAY DIGITAL', amount_minor: 24900 });
    expect((await q('operations')).filter((o) => o.status === 'succeeded')).toHaveLength(3);
    // The next lookup sees the block; the fraud system mirrors it.
    expect((await adapters().readers.card_status.listCards(ctx, 'CUS-1001')).data[0].status).toBe('blocked');
    expect((await adapters().readers.fraud_alerts.listAlerts(ctx, 'CUS-1001')).data[0].reportedCardStatus).toBe('blocked');
    // The timeline names BigQuery as the source of the lookups.
    expect(all<{ source: string }>("SELECT source FROM timeline_events WHERE session_id = ? AND type = 'source.completed'", [c.sessionId]).some((e) => /BigQuery/.test(e.source))).toBe(true);
    await c.input({ kind: 'hangup' });
    // A demo reset puts the card back for the next tester, in BigQuery too.
    expect(refreshDemoFixtures('CUS-1001')).toBe(true);
    await new Promise((r) => setTimeout(r, 1500));
    expect((await adapters().readers.card_status.listCards(ctx, 'CUS-1001')).data[0].status).toBe('active');
  }, 120_000);

  it('writes are idempotent by key, and a fee reversal is recorded once', async () => {
    const w = adapters().writers;
    const c1 = { correlationId: 'x', customerId: 'CUS-1005', sessionId: 'S-test' };
    const fee = (await adapters().readers.fee_policy.getFeeData(c1, 'CUS-1005')).data.fees.find((f) => f.feeType === 'late_payment')!;
    const a = await w.fee_ledger.reverseFee(c1, { feeId: fee.feeId, customerId: 'CUS-1005', ruleCode: 'FP-LATE-01' }, 'key-fee-1');
    const b = await w.fee_ledger.reverseFee(c1, { feeId: fee.feeId, customerId: 'CUS-1005', ruleCode: 'FP-LATE-01' }, 'key-fee-1');
    expect(a.outcome).toBe('succeeded');
    expect(b.externalRef).toBe(a.externalRef);
    const again = await w.fee_ledger.reverseFee(c1, { feeId: fee.feeId, customerId: 'CUS-1005', ruleCode: 'FP-LATE-01' }, 'key-fee-2');
    expect(again.failureCode).toBe('ALREADY_REVERSED');
    expect(await w.fee_ledger.lookup(c1, 'key-fee-1')).toMatchObject({ found: true, outcome: 'succeeded' });
    expect(await w.fee_ledger.lookup(c1, 'never-sent')).toEqual({ found: false });
    const txns = (await adapters().readers.transactions.listTransactions(c1, 'CUS-1005', 30)).data;
    expect(txns.some((t) => t.kind === 'credit' && t.merchant === 'Fee reversal')).toBe(true);
  }, 60_000);

  it('answers knowledge questions from BigQuery: curated guidance, bank information and the FAQ', async () => {
    const kb = knowledgeBase();
    expect(kb.name).toMatch(/BigQuery/);
    expect((await kb.search({ issueType: 'lost_stolen_card', text: 'I lost my card', context: [] }))[0].article.id).toBe('KB-102');
    const faq = await kb.search({ issueType: null, text: 'the machine kept my card overnight, it swallowed it', context: [] });
    expect(faq[0]?.article.id).toBe('FAQ-recover_swallowed_card-1');
    expect(faq[0]?.reason).toMatch(/BigQuery/);
    expect(kb.get('FAQ-recover_swallowed_card-1')?.title).toBe('Recover swallowed card');
  });

  it('gives the CRM a lifetime history read from BigQuery', async () => {
    const h = await customerHistory('CUS-1001');
    expect(h.transactions).toBeGreaterThan(3);
    expect(h.source).toMatch(/northstar_bank/);
  });
});
