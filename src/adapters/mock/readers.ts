/**
 * MOCK read adapters. SIMULATED: backed by local synthetic `bank_*` tables, with simulated
 * latency and injectable faults. Not connected to any real bank system.
 */
import { all, get, parseJson } from '../../db/db.ts';
import { nowIso, nowMs } from '../../lib/clock.ts';
import { maskPhone } from '../../lib/redact.ts';
import {
  SourceUnavailableError,
  type AdapterContext,
  type CardAdapter,
  type CardSummary,
  type CustomerProfileAdapter,
  type DisputeRulesAdapter,
  type FeeAdapter,
  type FraudAdapter,
  type PaymentAdapter,
  type PriorCasesAdapter,
  type SourceData,
  type TransactionAdapter,
} from '../types.ts';
import { activeFaults, mockTiming, simulatedLatency } from './faults.ts';

const daysAgoIso = (d: number) => new Date(nowMs() - d * 86_400_000).toISOString();

/** Apply latency and read-faults, then build the payload with a freshness timestamp. */
async function readWithFaults<T>(source: string, ctx: AdapterContext, baseLatency: number, produce: () => T, asOfOverride?: string): Promise<SourceData<T>> {
  const faults = activeFaults(source, ctx);
  if (faults.has('unavailable')) {
    await simulatedLatency(20, 20);
    throw new SourceUnavailableError(source);
  }
  if (faults.has('error')) {
    await simulatedLatency(20, 20);
    throw new SourceUnavailableError(source, 'SOURCE_ERROR');
  }
  if (faults.has('timeout')) {
    await new Promise((r) => setTimeout(r, mockTiming.hangMs).unref());
  }
  await simulatedLatency(baseLatency, baseLatency);
  const data = produce();
  const asOf = faults.has('stale') ? new Date(nowMs() - 6 * 3600_000).toISOString() : asOfOverride ?? nowIso();
  return { data, asOf };
}

export const mockCustomerProfile: CustomerProfileAdapter = {
  getProfile: (ctx, customerId) =>
    readWithFaults('customer_profile', ctx, 40, () => {
      const r = get<Record<string, string>>('SELECT * FROM bank_customers WHERE id = ?', [customerId]);
      if (!r) throw new SourceUnavailableError('customer_profile', 'NOT_FOUND');
      return {
        customerId: r.id,
        firstName: r.full_name.split(' ')[0],
        fullName: r.full_name,
        standing: r.account_standing as 'good',
        segment: r.segment,
        phoneMasked: r.phone_masked ?? maskPhone(''),
        contactChangedAt: r.contact_changed_at ?? null,
      };
    }),
};

export const mockCards: CardAdapter = {
  listCards: (ctx, customerId) =>
    readWithFaults('card_status', ctx, 60, () =>
      all<Record<string, string>>('SELECT * FROM bank_cards WHERE customer_id = ? ORDER BY holder_role, last4', [customerId]).map(
        (c): CardSummary => ({
          cardRef: c.id,
          last4: c.last4,
          network: c.network,
          product: c.product,
          holderRole: c.holder_role as 'primary',
          holderName: c.holder_name,
          status: c.status as 'active',
          statusReason: c.status_reason ?? null,
        }),
      ),
    ),
};

export const mockTransactions: TransactionAdapter = {
  listTransactions: (ctx, customerId, sinceDays) =>
    readWithFaults('transactions', ctx, 90, () =>
      all<Record<string, unknown>>('SELECT * FROM bank_transactions WHERE customer_id = ? AND txn_at >= ? ORDER BY txn_at DESC', [customerId, daysAgoIso(sinceDays)]).map((t) => ({
        transactionId: String(t.id),
        cardRef: (t.card_id as string) ?? null,
        kind: t.kind as 'purchase',
        merchant: (t.merchant_name as string) ?? null,
        merchantCategory: (t.merchant_category as string) ?? null,
        amountMinor: Number(t.amount_minor),
        currency: String(t.currency),
        transactedAt: String(t.txn_at),
        postedAt: (t.posted_at as string) ?? null,
        status: t.status as 'posted',
        entryMode: (t.entry_mode as string) ?? null,
        authCode: (t.auth_code as string) ?? null,
        relatedPaymentId: (t.related_payment_id as string) ?? null,
      })),
    ),
};

export const mockFraud: FraudAdapter = {
  listAlerts: (ctx, customerId) =>
    readWithFaults('fraud_alerts', ctx, 70, () =>
      all<Record<string, unknown>>('SELECT * FROM bank_fraud_alerts WHERE customer_id = ? ORDER BY created_at DESC', [customerId]).map((a) => ({
        alertId: String(a.id),
        cardRef: (a.card_id as string) ?? null,
        transactionId: (a.transaction_id as string) ?? null,
        alertType: String(a.alert_type),
        riskLevel: a.risk_level as 'low',
        status: a.status as 'open',
        reportedCardStatus: (a.reported_card_status as 'active') ?? null,
        reportedAmountMinor: a.reported_amount_minor == null ? null : Number(a.reported_amount_minor),
        createdAt: String(a.created_at),
      })),
    ),
};

/** Prior cases are read from the application's own case store (the case-management system). */
export const mockPriorCases: PriorCasesAdapter = {
  listCases: (ctx, customerId, sinceDays) =>
    readWithFaults('prior_cases', ctx, 50, () =>
      all<Record<string, unknown>>(
        `SELECT id, issue_type, status, resolution_status, summary, transaction_refs_json, created_at, updated_at
         FROM cases WHERE customer_id = ? AND created_at >= ? AND (? IS NULL OR session_id != ?) ORDER BY created_at DESC LIMIT 20`,
        [customerId, daysAgoIso(sinceDays), ctx.sessionId ?? null, ctx.sessionId ?? null],
      ).map((c) => ({
        caseId: String(c.id),
        issueType: (c.issue_type as string) ?? null,
        status: String(c.status),
        resolutionStatus: (c.resolution_status as string) ?? null,
        summary: (c.summary as string) ?? null,
        transactionRefs: parseJson<string[]>(c.transaction_refs_json, []),
        createdAt: String(c.created_at),
        updatedAt: String(c.updated_at),
      })),
    ),
};

export const mockDisputeRules: DisputeRulesAdapter = {
  getRules: (ctx) =>
    readWithFaults('dispute_rules', ctx, 30, () =>
      all<Record<string, unknown>>('SELECT * FROM bank_dispute_rules WHERE active = 1').map((r) => ({
        ruleCode: String(r.rule_code),
        reason: r.reason as 'fraud_unrecognised',
        description: String(r.description),
        maxDaysSinceTxn: Number(r.max_days_since_txn),
        minAmountMinor: Number(r.min_amount_minor),
        allowedEntryModes: parseJson<string[]>(r.allowed_entry_modes, []),
        requiresCardBlock: Boolean(r.requires_card_block),
        requiredFields: parseJson<string[]>(r.required_fields, []),
        automatable: Boolean(r.automatable),
        version: String(r.version),
      })),
    ),
};

export const mockPayments: PaymentAdapter = {
  listPayments: (ctx, customerId, sinceDays) =>
    readWithFaults('payment_status', ctx, 80, () =>
      all<Record<string, unknown>>('SELECT * FROM bank_payments WHERE customer_id = ? AND initiated_at >= ? ORDER BY initiated_at DESC', [customerId, daysAgoIso(sinceDays)]).map((p) => ({
        paymentId: String(p.id),
        amountMinor: Number(p.amount_minor),
        currency: String(p.currency),
        initiatedAt: String(p.initiated_at),
        channel: String(p.channel),
        sourceAccountMasked: String(p.source_account_masked),
        status: p.status as 'pending',
        statusDetail: (p.status_detail as string) ?? null,
        postedAt: (p.posted_at as string) ?? null,
        expectedPostingDate: (p.expected_posting_date as string) ?? null,
        statusAsOf: String(p.status_as_of),
      })),
    ),
};

export const mockFees: FeeAdapter = {
  getFeeData: (ctx, customerId) =>
    readWithFaults('fee_policy', ctx, 45, () => {
      const fees = all<Record<string, unknown>>('SELECT * FROM bank_fees WHERE customer_id = ? ORDER BY charged_at DESC', [customerId]).map((f) => ({
        feeId: String(f.id),
        transactionId: (f.transaction_id as string) ?? null,
        feeType: String(f.fee_type),
        amountMinor: Number(f.amount_minor),
        currency: String(f.currency),
        chargedAt: String(f.charged_at),
        reversedAt: (f.reversed_at as string) ?? null,
      }));
      const policies = all<Record<string, unknown>>('SELECT * FROM bank_fee_policies').map((p) => ({
        ruleCode: String(p.rule_code),
        feeType: String(p.fee_type),
        reversible: Boolean(p.reversible),
        description: String(p.description),
        version: String(p.version),
      }));
      const yearAgo = daysAgoIso(365);
      const reversals = fees.filter((f) => f.reversedAt && f.reversedAt >= yearAgo).length;
      const lateFees = fees.filter((f) => f.feeType === 'late_payment' && f.chargedAt >= yearAgo).length;
      const cust = get<{ account_standing: string }>('SELECT account_standing FROM bank_customers WHERE id = ?', [customerId]);
      return {
        fees,
        policies,
        reversalsLast12Months: reversals,
        accountStanding: (cust?.account_standing ?? 'good') as 'good',
        latePaymentsLast12Months: lateFees,
      };
    }),
};
