/**
 * BIGQUERY read adapters (ADAPTER_MODE=bigquery). Same contracts as the mock readers, so the
 * workflows, policy engine and retrieval layer do not change.
 *
 * Data model (dataset `northstar_bank`, see scripts/bigquery/schema.sql):
 *  - Reference tables loaded once: customers, cards, transactions, fraud_alerts, payments, fees,
 *    declines, dispute_rules, fee_policies. They hold SYNTHETIC Northstar data, plus transaction
 *    history derived from the public Kaggle "Sparkov" credit-card dataset.
 *  - Event tables written during calls: card_status_events, fee_reversals, demo_resets, ...
 *    The current state of a card or fee is the loaded row overlaid with the newest event after the
 *    customer's last demo reset, so a block made in one call shows up in the next lookup.
 *  - Demo clock: dataset_meta.anchor_at is when the data was generated. Loaded timestamps are
 *    shifted forward by (now - anchor_at), so "three days ago" stays three days ago.
 *
 * Prior cases are read from the application's own case store, as in mock mode: cases are the CRM's
 * records, not the bank's.
 */
import { activeFaults } from '../mock/faults.ts';
import { mockPriorCases } from '../mock/readers.ts';
import {
  SourceUnavailableError,
  type AdapterContext,
  type CardAdapter,
  type CardSummary,
  type CustomerProfileAdapter,
  type DeclineAdapter,
  type DeclineRecord,
  type DisputeRulesAdapter,
  type FeeAdapter,
  type FraudAdapter,
  type PaymentAdapter,
  type PriorCasesAdapter,
  type SourceData,
  type TransactionAdapter,
} from '../types.ts';
import { bigQuery, T, type BqClient, type Params } from './client.ts';
import { nowIso, nowMs } from '../../lib/clock.ts';
import { log } from '../../lib/logger.ts';

/** Shift a loaded timestamp column by the demo clock. */
export const sh = (col: string) => `TIMESTAMP_ADD(${col}, INTERVAL meta.s SECOND)`;
export const metaCte = (c: BqClient) => `meta AS (SELECT IFNULL(TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), MAX(anchor_at), SECOND), 0) AS s FROM ${T(c, 'dataset_meta')})`;
/** Latest demo reset for the customer (events before it are ignored). */
export const resetCte = (c: BqClient) => `rst AS (SELECT IFNULL(MAX(reset_at), TIMESTAMP '1970-01-01') AS since_at FROM ${T(c, 'demo_resets')} WHERE customer_id = @customerId)`;
/** Newest card status event per card since the last reset. */
export const cardEventsCte = (c: BqClient) =>
  `ev AS (SELECT card_id, ARRAY_AGG(STRUCT(status, reason, created_at) ORDER BY created_at DESC LIMIT 1)[OFFSET(0)] AS e
          FROM ${T(c, 'card_status_events')}, rst WHERE customer_id = @customerId AND created_at > rst.since_at GROUP BY card_id)`;

const daysAgoIso = (d: number) => new Date(nowMs() - d * 86_400_000).toISOString();

/** Faults configured for the demo still apply (they live in the app's own settings). */
async function read<T>(source: string, ctx: AdapterContext, produce: (c: BqClient) => Promise<T>): Promise<SourceData<T>> {
  const faults = activeFaults(source, ctx);
  if (faults.has('unavailable')) throw new SourceUnavailableError(source);
  if (faults.has('error')) throw new SourceUnavailableError(source, 'SOURCE_ERROR');
  let data: T;
  try {
    data = await produce(bigQuery());
  } catch (e) {
    if (e instanceof SourceUnavailableError) throw e;
    log.warn('BigQuery read failed', { source, error: (e as Error).message.slice(0, 300) });
    throw new SourceUnavailableError(source, 'SOURCE_ERROR');
  }
  const asOf = faults.has('stale') ? new Date(nowMs() - 6 * 3600_000).toISOString() : nowIso();
  return { data, asOf };
}

const q = <R>(c: BqClient, sql: string, params: Params) => c.query<R>(sql, params);
const str = (v: unknown) => (v == null ? null : String(v));

export const bqCustomerProfile: CustomerProfileAdapter = {
  getProfile: (ctx, customerId) =>
    read('customer_profile', ctx, async (c) => {
      const [r] = await q<Record<string, unknown>>(c,
        `WITH ${metaCte(c)}
         SELECT customer_id, full_name, account_standing, segment, phone_masked, ${sh('contact_changed_at')} AS contact_changed_at
         FROM ${T(c, 'customers')} CROSS JOIN meta WHERE customer_id = @customerId`, { customerId });
      if (!r) throw new SourceUnavailableError('customer_profile', 'NOT_FOUND');
      return {
        customerId: String(r.customer_id),
        firstName: String(r.full_name).split(' ')[0],
        fullName: String(r.full_name),
        standing: r.account_standing as 'good',
        segment: String(r.segment),
        phoneMasked: String(r.phone_masked),
        contactChangedAt: str(r.contact_changed_at),
      };
    }),
};

export const CARDS_SQL = (c: BqClient) => `WITH ${resetCte(c)}, ${cardEventsCte(c)}
  SELECT k.card_id, k.last4, k.network, k.product, k.holder_role, k.holder_name,
         IFNULL(ev.e.status, k.status) AS status, IF(ev.e.status IS NULL, k.status_reason, ev.e.reason) AS status_reason
  FROM ${T(c, 'cards')} k LEFT JOIN ev USING (card_id) WHERE k.customer_id = @customerId ORDER BY k.holder_role, k.last4`;

export const bqCards: CardAdapter = {
  listCards: (ctx, customerId) =>
    read('card_status', ctx, async (c) =>
      (await q<Record<string, unknown>>(c, CARDS_SQL(c), { customerId })).map(
        (k): CardSummary => ({
          cardRef: String(k.card_id),
          last4: String(k.last4),
          network: String(k.network),
          product: String(k.product),
          holderRole: k.holder_role as 'primary',
          holderName: String(k.holder_name),
          status: k.status as 'active',
          statusReason: str(k.status_reason),
        }),
      ),
    ),
};

/** Transactions, plus the credits written by fee reversals since the last reset. */
export const TXN_SQL = (c: BqClient) => `WITH ${metaCte(c)}, ${resetCte(c)}
  SELECT * FROM (
    SELECT transaction_id, card_id, kind, merchant_name, merchant_category, amount_minor, currency,
           ${sh('txn_at')} AS txn_at, ${sh('posted_at')} AS posted_at, status, entry_mode, auth_code, related_payment_id
    FROM ${T(c, 'transactions')} CROSS JOIN meta WHERE customer_id = @customerId
    UNION ALL
    SELECT reversal_id, CAST(NULL AS STRING), 'credit', 'Fee reversal', CAST(NULL AS STRING), 0 - amount_minor, currency,
           created_at, CAST(NULL AS TIMESTAMP), 'pending', CAST(NULL AS STRING), CAST(NULL AS STRING), CAST(NULL AS STRING)
    FROM ${T(c, 'fee_reversals')}, rst WHERE customer_id = @customerId AND created_at > rst.since_at
  ) WHERE txn_at >= TIMESTAMP(@since) ORDER BY txn_at DESC LIMIT 500`;

export const bqTransactions: TransactionAdapter = {
  listTransactions: (ctx, customerId, sinceDays) =>
    read('transactions', ctx, async (c) =>
      (await q<Record<string, unknown>>(c, TXN_SQL(c), { customerId, since: daysAgoIso(sinceDays) })).map((t) => ({
        transactionId: String(t.transaction_id),
        cardRef: str(t.card_id),
        kind: t.kind as 'purchase',
        merchant: str(t.merchant_name),
        merchantCategory: str(t.merchant_category),
        amountMinor: Number(t.amount_minor),
        currency: String(t.currency),
        transactedAt: String(t.txn_at),
        postedAt: str(t.posted_at),
        status: t.status as 'posted',
        entryMode: str(t.entry_mode),
        authCode: str(t.auth_code),
        relatedPaymentId: str(t.related_payment_id),
      })),
    ),
};

export const bqFraud: FraudAdapter = {
  listAlerts: (ctx, customerId) =>
    read('fraud_alerts', ctx, async (c) =>
      (await q<Record<string, unknown>>(c,
        `WITH ${metaCte(c)}, ${resetCte(c)}, ${cardEventsCte(c)}
         SELECT a.alert_id, a.card_id, a.transaction_id, a.alert_type, a.risk_level, a.status,
                -- The fraud system mirrors a block made by card control, as in the mock.
                IF(ev.e.status = 'blocked', 'blocked', a.reported_card_status) AS reported_card_status,
                a.reported_amount_minor, ${sh('a.created_at')} AS created_at
         FROM ${T(c, 'fraud_alerts')} a CROSS JOIN meta LEFT JOIN ev USING (card_id)
         WHERE a.customer_id = @customerId ORDER BY created_at DESC`, { customerId })).map((a) => ({
        alertId: String(a.alert_id),
        cardRef: str(a.card_id),
        transactionId: str(a.transaction_id),
        alertType: String(a.alert_type),
        riskLevel: a.risk_level as 'low',
        status: a.status as 'open',
        reportedCardStatus: (a.reported_card_status as 'active') ?? null,
        reportedAmountMinor: a.reported_amount_minor == null ? null : Number(a.reported_amount_minor),
        createdAt: String(a.created_at),
      })),
    ),
};

export const bqPriorCases: PriorCasesAdapter = mockPriorCases;

export const bqDisputeRules: DisputeRulesAdapter = {
  getRules: (ctx) =>
    read('dispute_rules', ctx, async (c) =>
      (await q<Record<string, unknown>>(c, `SELECT * FROM ${T(c, 'dispute_rules')} WHERE active`, {})).map((r) => ({
        ruleCode: String(r.rule_code),
        reason: r.reason as 'fraud_unrecognised',
        description: String(r.description),
        maxDaysSinceTxn: Number(r.max_days_since_txn),
        minAmountMinor: Number(r.min_amount_minor),
        allowedEntryModes: (r.allowed_entry_modes as string[]) ?? [],
        requiresCardBlock: Boolean(r.requires_card_block),
        requiredFields: (r.required_fields as string[]) ?? [],
        automatable: Boolean(r.automatable),
        version: String(r.version),
      })),
    ),
};

export const bqPayments: PaymentAdapter = {
  listPayments: (ctx, customerId, sinceDays) =>
    read('payment_status', ctx, async (c) =>
      (await q<Record<string, unknown>>(c,
        `WITH ${metaCte(c)}
         SELECT payment_id, amount_minor, currency, ${sh('initiated_at')} AS initiated_at, channel, source_account_masked, status, status_detail,
                ${sh('posted_at')} AS posted_at, expected_posting_date, ${sh('status_as_of')} AS status_as_of
         FROM ${T(c, 'payments')} CROSS JOIN meta WHERE customer_id = @customerId AND ${sh('initiated_at')} >= TIMESTAMP(@since) ORDER BY initiated_at DESC`,
        { customerId, since: daysAgoIso(sinceDays) })).map((p) => ({
        paymentId: String(p.payment_id),
        amountMinor: Number(p.amount_minor),
        currency: String(p.currency),
        initiatedAt: String(p.initiated_at),
        channel: String(p.channel),
        sourceAccountMasked: String(p.source_account_masked),
        status: p.status as 'pending',
        statusDetail: str(p.status_detail),
        postedAt: str(p.posted_at),
        expectedPostingDate: str(p.expected_posting_date),
        statusAsOf: String(p.status_as_of),
      })),
    ),
};

export const bqFees: FeeAdapter = {
  getFeeData: (ctx, customerId) =>
    read('fee_policy', ctx, async (c) => {
      const [fees, policies, cust] = await Promise.all([
        q<Record<string, unknown>>(c,
          `WITH ${metaCte(c)}, ${resetCte(c)},
                rev AS (SELECT fee_id, MAX(created_at) AS rev_at FROM ${T(c, 'fee_reversals')}, rst WHERE customer_id = @customerId AND created_at > rst.since_at GROUP BY fee_id)
           SELECT f.fee_id, f.transaction_id, f.fee_type, f.amount_minor, f.currency, ${sh('f.charged_at')} AS charged_at,
                  IFNULL(rev.rev_at, ${sh('f.reversed_at')}) AS reversed_at
           FROM ${T(c, 'fees')} f CROSS JOIN meta LEFT JOIN rev USING (fee_id) WHERE f.customer_id = @customerId ORDER BY charged_at DESC`, { customerId }),
        q<Record<string, unknown>>(c, `SELECT * FROM ${T(c, 'fee_policies')}`, {}),
        q<{ account_standing: string }>(c, `SELECT account_standing FROM ${T(c, 'customers')} WHERE customer_id = @customerId`, { customerId }),
      ]);
      const list = fees.map((f) => ({
        feeId: String(f.fee_id),
        transactionId: str(f.transaction_id),
        feeType: String(f.fee_type),
        amountMinor: Number(f.amount_minor),
        currency: String(f.currency),
        chargedAt: String(f.charged_at),
        reversedAt: str(f.reversed_at),
      }));
      const yearAgo = daysAgoIso(365);
      return {
        fees: list,
        policies: policies.map((p) => ({ ruleCode: String(p.rule_code), feeType: String(p.fee_type), reversible: Boolean(p.reversible), description: String(p.description), version: String(p.version) })),
        reversalsLast12Months: list.filter((f) => f.reversedAt && f.reversedAt >= yearAgo).length,
        accountStanding: (cust[0]?.account_standing ?? 'good') as 'good',
        latePaymentsLast12Months: list.filter((f) => f.feeType === 'late_payment' && f.chargedAt >= yearAgo).length,
      };
    }),
};

export const bqDeclines: DeclineAdapter = {
  listDeclines: (ctx, customerId, sinceDays) =>
    read('card_declines', ctx, async (c) =>
      (await q<Record<string, unknown>>(c,
        `WITH ${metaCte(c)}
         SELECT decline_id, card_id, merchant_name, amount_minor, currency, ${sh('declined_at')} AS declined_at, reason_code, customer_action
         FROM ${T(c, 'declines')} CROSS JOIN meta WHERE customer_id = @customerId AND ${sh('declined_at')} >= TIMESTAMP(@since) ORDER BY declined_at DESC`,
        { customerId, since: daysAgoIso(sinceDays) })).map(
        (d): DeclineRecord => ({
          declineId: String(d.decline_id),
          cardRef: str(d.card_id),
          merchant: String(d.merchant_name),
          amountMinor: Number(d.amount_minor),
          currency: String(d.currency),
          declinedAt: String(d.declined_at),
          reasonCode: d.reason_code as DeclineRecord['reasonCode'],
          suggestedAction: str(d.customer_action),
        }),
      ),
    ),
};
