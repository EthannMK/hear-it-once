/**
 * BIGQUERY write adapters (ADAPTER_MODE=bigquery). Account changes are recorded as events in
 * BigQuery (card_status_events, replacement_orders, dispute_submissions, fee_reversals) and every
 * request is kept in `operations` by idempotency key, so the application can look up an unknown
 * outcome exactly as it does with the mock. The same change is mirrored into the app's local copy
 * of the bank tables so the CRM shows it without another round trip.
 *
 * Streaming inserts are visible to queries straight away, which is what the next lookup needs.
 */
import { run } from '../../db/db.ts';
import { newId, stableHash } from '../../lib/ids.ts';
import { nowIso } from '../../lib/clock.ts';
import { activeFaults, mockTiming } from '../mock/faults.ts';
import {
  SourceUnavailableError,
  type AdapterContext,
  type CardControlWriteAdapter,
  type DisputeIntakeWriteAdapter,
  type FeeLedgerWriteAdapter,
  type OperationLookup,
  type ReplacementWriteAdapter,
  type WriteResult,
} from '../types.ts';
import { bigQuery, T, type BqClient } from './client.ts';
import { CARDS_SQL, metaCte, resetCte, sh } from './readers.ts';

interface OpRow { op_id: string; status: 'succeeded' | 'failed' | 'pending'; failure_code: string | null; payload_hash: string; downstream_status: string | null }
const toResult = (r: OpRow): WriteResult => ({ outcome: r.status, externalRef: r.status === 'failed' ? null : r.op_id, failureCode: r.failure_code, downstreamStatus: r.downstream_status });

async function findOp(c: BqClient, system: string, key: string): Promise<OpRow | null> {
  const [r] = await c.query<OpRow>(`SELECT op_id, status, failure_code, payload_hash, downstream_status FROM ${T(c, 'operations')} WHERE system = @system AND idempotency_key = @key ORDER BY created_at LIMIT 1`, { system, key });
  return r ?? null;
}

/** Idempotent write: the same key returns the first outcome; a different payload under one key is refused. */
async function bqWrite(system: string, operation: string, ctx: AdapterContext, key: string, payload: unknown, effect: (c: BqClient, opId: string) => Promise<WriteResult>): Promise<WriteResult> {
  const faults = activeFaults(system, ctx);
  if (faults.has('unavailable')) throw new SourceUnavailableError(system); // request never received
  const c = bigQuery();
  const payloadHash = stableHash(payload);
  let result: WriteResult;
  try {
    const existing = await findOp(c, system, key);
    if (existing) return existing.payload_hash === payloadHash ? toResult(existing) : { outcome: 'failed', externalRef: null, failureCode: 'IDEMPOTENCY_PAYLOAD_MISMATCH' };
    const opId = newId(system.toUpperCase().replace(/_/g, '').slice(0, 6));
    let r: WriteResult;
    if (faults.has('fail')) r = { outcome: 'failed', externalRef: null, failureCode: 'DOWNSTREAM_REJECTED' };
    else if (faults.has('pending')) r = { outcome: 'pending', externalRef: null, failureCode: null, downstreamStatus: 'queued_not_acknowledged' };
    else r = await effect(c, opId);
    await c.insert('operations', [{
      op_id: opId, system, operation, idempotency_key: key, payload_hash: payloadHash, status: r.outcome, failure_code: r.failureCode,
      downstream_status: r.downstreamStatus ?? null, session_id: ctx.sessionId ?? null, customer_id: ctx.customerId ?? null, created_at: nowIso(),
    }]);
    result = { ...r, externalRef: r.outcome === 'failed' ? null : opId };
  } catch (e) {
    if (e instanceof SourceUnavailableError) throw e;
    // BigQuery itself failed: nothing confirmed. The action service treats this as not received.
    throw new SourceUnavailableError(system, 'SOURCE_ERROR');
  }
  if (faults.has('timeout_after_submit')) await new Promise((r) => setTimeout(r, mockTiming.hangMs).unref());
  return result;
}

async function lookup(system: string, key: string): Promise<OperationLookup> {
  const r = await findOp(bigQuery(), system, key);
  return r ? { found: true, ...toResult(r) } : { found: false };
}

async function cardOf(c: BqClient, customerId: string, cardRef: string) {
  const rows = await c.query<{ card_id: string; status: string }>(CARDS_SQL(c), { customerId });
  return rows.find((r) => r.card_id === cardRef) ?? null;
}

export const bqCardControl: CardControlWriteAdapter = {
  blockCard: (ctx, req, key) =>
    bqWrite('card_control', 'block_card', ctx, key, req, async (c) => {
      const customerId = ctx.customerId ?? '';
      const card = await cardOf(c, customerId, req.cardRef);
      if (!card) return { outcome: 'failed', externalRef: null, failureCode: 'CARD_NOT_OWNED' };
      if (card.status === 'closed') return { outcome: 'failed', externalRef: null, failureCode: 'CARD_CLOSED' };
      const ts = nowIso();
      await c.insert('card_status_events', [{ event_id: newId('CSE'), customer_id: customerId, card_id: req.cardRef, status: 'blocked', reason: `reported_${req.reason}`, session_id: ctx.sessionId ?? null, created_at: ts }]);
      // Keep the app's local copy in step (CRM, test panel).
      run("UPDATE bank_cards SET status = 'blocked', status_reason = ?, status_as_of = ? WHERE id = ?", [`reported_${req.reason}`, ts, req.cardRef]);
      run("UPDATE bank_fraud_alerts SET reported_card_status = 'blocked' WHERE card_id = ?", [req.cardRef]);
      return { outcome: 'succeeded', externalRef: null, failureCode: null, detail: { previousStatus: card.status } };
    }),
  lookup: (_ctx, key) => lookup('card_control', key),
};

export const bqReplacement: ReplacementWriteAdapter = {
  orderReplacement: (ctx, req, key) =>
    bqWrite('replacement', 'order_replacement', ctx, key, req, async (c) => {
      const card = await cardOf(c, ctx.customerId ?? '', req.cardRef);
      if (!card) return { outcome: 'failed', externalRef: null, failureCode: 'CARD_NOT_FOUND' };
      if (card.status !== 'blocked') return { outcome: 'failed', externalRef: null, failureCode: 'CARD_NOT_BLOCKED' };
      await c.insert('replacement_orders', [{ order_id: newId('RPL'), customer_id: ctx.customerId ?? '', card_id: req.cardRef, delivery: req.deliveryAddress, session_id: ctx.sessionId ?? null, created_at: nowIso() }]);
      return { outcome: 'succeeded', externalRef: null, failureCode: null, detail: { delivery: 'address_on_file' } };
    }),
  lookup: (_ctx, key) => lookup('replacement', key),
};

export const bqDisputeIntake: DisputeIntakeWriteAdapter = {
  submitDispute: (ctx, req, key) =>
    bqWrite('dispute_intake', 'submit_dispute', ctx, key, req, async (c) => {
      const [t] = await c.query<{ customer_id: string }>(`SELECT customer_id FROM ${T(c, 'transactions')} WHERE transaction_id = @id`, { id: req.transactionId });
      if (!t || t.customer_id !== req.customerId) return { outcome: 'failed', externalRef: null, failureCode: 'TRANSACTION_NOT_FOUND' };
      await c.insert('dispute_submissions', [{
        submission_id: newId('DSB'), customer_id: req.customerId, card_id: req.cardRef, transaction_id: req.transactionId, merchant: req.merchant, amount_minor: req.amountMinor,
        currency: req.currency, transaction_date: req.transactionDate.slice(0, 10), reason_code: req.reasonCode, case_id: req.caseId, session_id: ctx.sessionId ?? null, created_at: nowIso(),
      }]);
      return { outcome: 'succeeded', externalRef: null, failureCode: null, downstreamStatus: 'received_pending_review' };
    }),
  lookup: (_ctx, key) => lookup('dispute_intake', key),
};

export const bqFeeLedger: FeeLedgerWriteAdapter = {
  reverseFee: (ctx, req, key) =>
    bqWrite('fee_ledger', 'reverse_fee', ctx, key, req, async (c) => {
      const [fee] = await c.query<{ customer_id: string; amount_minor: number; currency: string; reversed_at: string | null }>(
        `WITH ${metaCte(c)}, ${resetCte(c)},
              rev AS (SELECT fee_id, MAX(created_at) AS rev_at FROM ${T(c, 'fee_reversals')}, rst WHERE customer_id = @customerId AND created_at > rst.since_at GROUP BY fee_id)
         SELECT f.customer_id, f.amount_minor, f.currency, IFNULL(rev.rev_at, ${sh('f.reversed_at')}) AS reversed_at
         FROM ${T(c, 'fees')} f CROSS JOIN meta LEFT JOIN rev USING (fee_id) WHERE f.fee_id = @feeId`,
        { feeId: req.feeId, customerId: req.customerId },
      );
      if (!fee || fee.customer_id !== req.customerId) return { outcome: 'failed', externalRef: null, failureCode: 'FEE_NOT_FOUND' };
      if (fee.reversed_at) return { outcome: 'failed', externalRef: null, failureCode: 'ALREADY_REVERSED' };
      const ts = nowIso();
      await c.insert('fee_reversals', [{ reversal_id: newId('FRV'), fee_id: req.feeId, customer_id: req.customerId, rule_code: req.ruleCode, amount_minor: Number(fee.amount_minor), currency: fee.currency, session_id: ctx.sessionId ?? null, created_at: ts }]);
      run('UPDATE bank_fees SET reversed_at = ?, reversal_reason = ? WHERE id = ?', [ts, req.ruleCode, req.feeId]);
      return { outcome: 'succeeded', externalRef: null, failureCode: null };
    }),
  lookup: (_ctx, key) => lookup('fee_ledger', key),
};

/** Demo reset: events before this moment no longer count for the customer (see refreshDemoFixtures). */
export async function resetDemoCustomer(customerId: string): Promise<void> {
  const c = bigQuery();
  await c.insert('demo_resets', [{ customer_id: customerId, reset_at: nowIso() }]);
}
