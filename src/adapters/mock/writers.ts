/**
 * MOCK write adapters (card control, card issuing, dispute intake, fee ledger).
 * SIMULATED: they change only synthetic `bank_*` rows. Each is idempotent by key and keeps
 * its own operation record (bank_operations) so the application can reconcile unknown
 * outcomes, exactly as it would against a real system that supports status lookup.
 */
import { get, run, tx } from '../../db/db.ts';
import { newId, stableHash } from '../../lib/ids.ts';
import { nowIso } from '../../lib/clock.ts';
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
import { activeFaults, mockTiming, simulatedLatency } from './faults.ts';

type Effect = () => WriteResult;

interface OpRow {
  id: string;
  status: 'succeeded' | 'failed' | 'pending';
  failure_code: string | null;
  payload_hash: string;
  downstream_status: string | null;
}

function toResult(r: OpRow): WriteResult {
  return { outcome: r.status, externalRef: r.status === 'failed' ? null : r.id, failureCode: r.failure_code, downstreamStatus: r.downstream_status };
}

async function mockWrite(system: string, operation: string, ctx: AdapterContext, key: string, payload: unknown, effect: Effect): Promise<WriteResult> {
  const faults = activeFaults(system, ctx);
  await simulatedLatency(80, 120);
  if (faults.has('unavailable')) throw new SourceUnavailableError(system); // request never received

  const payloadHash = stableHash(payload);
  const result = tx((): WriteResult => {
    const existing = get<OpRow>('SELECT * FROM bank_operations WHERE system = ? AND idempotency_key = ?', [system, key]);
    if (existing) {
      if (existing.payload_hash !== payloadHash) return { outcome: 'failed', externalRef: null, failureCode: 'IDEMPOTENCY_PAYLOAD_MISMATCH' };
      return toResult(existing);
    }
    let r: WriteResult;
    if (faults.has('fail')) r = { outcome: 'failed', externalRef: null, failureCode: 'DOWNSTREAM_REJECTED' };
    else if (faults.has('pending')) r = { outcome: 'pending', externalRef: null, failureCode: null, downstreamStatus: 'queued_not_acknowledged' };
    else r = effect();
    const id = newId(system.toUpperCase().replace(/_/g, '').slice(0, 6));
    const ts = nowIso();
    run(
      `INSERT INTO bank_operations (id, system, operation, idempotency_key, payload_hash, status, failure_code, downstream_status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, system, operation, key, payloadHash, r.outcome, r.failureCode, r.downstreamStatus ?? null, ts, ts],
    );
    return { ...r, externalRef: r.outcome === 'failed' ? null : id };
  });

  if (faults.has('timeout_after_submit')) {
    // The downstream system has applied the change but its reply never arrives in time.
    await new Promise((r) => setTimeout(r, mockTiming.hangMs).unref());
  }
  return result;
}

async function lookup(system: string, key: string): Promise<OperationLookup> {
  await simulatedLatency(30, 30);
  const r = get<OpRow>('SELECT * FROM bank_operations WHERE system = ? AND idempotency_key = ?', [system, key]);
  return r ? { found: true, ...toResult(r) } : { found: false };
}

export const mockCardControl: CardControlWriteAdapter = {
  blockCard: (ctx, req, key) =>
    mockWrite('card_control', 'block_card', ctx, key, req, () => {
      const card = get<{ status: string; customer_id: string }>('SELECT status, customer_id FROM bank_cards WHERE id = ?', [req.cardRef]);
      if (!card) return { outcome: 'failed', externalRef: null, failureCode: 'CARD_NOT_FOUND' };
      if (card.customer_id !== ctx.customerId) return { outcome: 'failed', externalRef: null, failureCode: 'CARD_NOT_OWNED' };
      if (card.status === 'closed') return { outcome: 'failed', externalRef: null, failureCode: 'CARD_CLOSED' };
      run("UPDATE bank_cards SET status = 'blocked', status_reason = ?, status_as_of = ? WHERE id = ?", [`reported_${req.reason}`, nowIso(), req.cardRef]);
      return { outcome: 'succeeded', externalRef: null, failureCode: null, detail: { previousStatus: card.status } };
    }),
  lookup: (_ctx, key) => lookup('card_control', key),
};

export const mockReplacement: ReplacementWriteAdapter = {
  orderReplacement: (ctx, req, key) =>
    mockWrite('replacement', 'order_replacement', ctx, key, req, () => {
      const card = get<{ status: string; customer_id: string }>('SELECT status, customer_id FROM bank_cards WHERE id = ?', [req.cardRef]);
      if (!card || card.customer_id !== ctx.customerId) return { outcome: 'failed', externalRef: null, failureCode: 'CARD_NOT_FOUND' };
      if (card.status !== 'blocked') return { outcome: 'failed', externalRef: null, failureCode: 'CARD_NOT_BLOCKED' };
      return { outcome: 'succeeded', externalRef: null, failureCode: null, detail: { delivery: 'address_on_file' } };
    }),
  lookup: (_ctx, key) => lookup('replacement', key),
};

export const mockDisputeIntake: DisputeIntakeWriteAdapter = {
  submitDispute: (ctx, req, key) =>
    mockWrite('dispute_intake', 'submit_dispute', ctx, key, req, () => {
      const txn = get<{ customer_id: string }>('SELECT customer_id FROM bank_transactions WHERE id = ?', [req.transactionId]);
      if (!txn || txn.customer_id !== req.customerId) return { outcome: 'failed', externalRef: null, failureCode: 'TRANSACTION_NOT_FOUND' };
      // Submission received. Downstream review status is SIMULATED and is never a final ruling.
      return { outcome: 'succeeded', externalRef: null, failureCode: null, downstreamStatus: 'received_pending_review' };
    }),
  lookup: (_ctx, key) => lookup('dispute_intake', key),
};

export const mockFeeLedger: FeeLedgerWriteAdapter = {
  reverseFee: (ctx, req, key) =>
    mockWrite('fee_ledger', 'reverse_fee', ctx, key, req, () => {
      const fee = get<{ customer_id: string; reversed_at: string | null; amount_minor: number; currency: string }>(
        'SELECT customer_id, reversed_at, amount_minor, currency FROM bank_fees WHERE id = ?',
        [req.feeId],
      );
      if (!fee || fee.customer_id !== req.customerId) return { outcome: 'failed', externalRef: null, failureCode: 'FEE_NOT_FOUND' };
      if (fee.reversed_at) return { outcome: 'failed', externalRef: null, failureCode: 'ALREADY_REVERSED' };
      const ts = nowIso();
      run('UPDATE bank_fees SET reversed_at = ?, reversal_reason = ? WHERE id = ?', [ts, req.ruleCode, req.feeId]);
      run(
        `INSERT INTO bank_transactions (id, customer_id, card_id, kind, merchant_name, amount_minor, currency, txn_at, posted_at, status, created_at)
         VALUES (?, ?, NULL, 'credit', 'Fee reversal', ?, ?, ?, NULL, 'pending', ?)`,
        [newId('TXN'), req.customerId, -fee.amount_minor, fee.currency, ts, ts],
      );
      return { outcome: 'succeeded', externalRef: null, failureCode: null };
    }),
  lookup: (_ctx, key) => lookup('fee_ledger', key),
};
