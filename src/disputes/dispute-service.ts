/**
 * STRUCTURED DISPUTE WORKFLOW (FR-10).
 * Draft → validated against the rule's required fields → submitted only through the action
 * service → status reflects the dispute-intake service's real response. "Submitted" means
 * the intake system acknowledged it; it is never presented as acceptance by the network.
 */
import type { CardSummary, DisputeRule, Transaction, WriteResult } from '../adapters/types.ts';
import { get, parseJson, run } from '../db/db.ts';
import { nowIso } from '../lib/clock.ts';
import { newId } from '../lib/ids.ts';
import { redactText } from '../lib/redact.ts';
import { formatDate, formatMoney } from '../conversation/format.ts';

export type DisputeStatus = 'draft' | 'validation_failed' | 'submitting' | 'submitted' | 'pending' | 'rejected' | 'needs_review' | 'failed' | 'unknown';

export interface DisputeDraftInput {
  caseId: string;
  sessionId: string;
  customerId: string;
  txn: Transaction;
  card: CardSummary | null;
  rule: DisputeRule;
  customerExplanation: string;
  evidence: { type: string; description: string }[];
  priorCaseRefs: string[];
}

export function validateDispute(fields: Record<string, unknown>, evidence: { type: string }[], rule: DisputeRule): { missing: string[]; checks: Record<string, boolean> } {
  const checks: Record<string, boolean> = {};
  for (const f of rule.requiredFields) {
    if (f.startsWith('evidence:')) checks[f] = evidence.some((e) => e.type === f.slice('evidence:'.length));
    else {
      const v = fields[f];
      checks[f] = v !== undefined && v !== null && v !== '' && !(typeof v === 'number' && Number.isNaN(v));
    }
  }
  return { missing: Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k), checks };
}

export function createDisputeDraft(input: DisputeDraftInput): { id: string; missing: string[] } {
  // Reuse an existing open draft for the same transaction in this session (idempotent drafting).
  const existing = get<{ id: string; missing_fields_json: string }>(
    "SELECT id, missing_fields_json FROM disputes WHERE session_id = ? AND transaction_id = ? AND status IN ('draft','validation_failed')",
    [input.sessionId, input.txn.transactionId],
  );
  if (existing) return { id: existing.id, missing: parseJson(existing.missing_fields_json, []) };

  const fields: Record<string, unknown> = {
    cardRef: input.card?.cardRef ?? input.txn.cardRef,
    transactionId: input.txn.transactionId,
    merchant: input.txn.merchant,
    amountMinor: input.txn.amountMinor,
    currency: input.txn.currency,
    transactionDate: input.txn.transactedAt.slice(0, 10),
    reasonCode: input.rule.reason,
    customerExplanation: redactText(input.customerExplanation).slice(0, 500),
  };
  const v = validateDispute(fields, input.evidence, input.rule);
  const id = newId('DSP');
  const ts = nowIso();
  const summary = `${input.rule.reason === 'duplicate_charge' ? 'Duplicate charge' : 'Unrecognised transaction'} dispute: ${formatMoney(input.txn.amountMinor, input.txn.currency)} at ${input.txn.merchant} on ${formatDate(input.txn.transactedAt)}, card ending ${input.card?.last4 ?? 'unknown'}. Rule ${input.rule.ruleCode} (${input.rule.version}).`;
  run(
    `INSERT INTO disputes (id, case_id, session_id, customer_id, card_id, transaction_id, merchant, amount_minor, currency, txn_date, reason_code, rule_code,
       customer_explanation, evidence_json, validation_json, missing_fields_json, prior_case_refs_json, status, summary, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id, input.caseId, input.sessionId, input.customerId, fields.cardRef, input.txn.transactionId, input.txn.merchant ?? '', input.txn.amountMinor, input.txn.currency,
      fields.transactionDate, input.rule.reason, input.rule.ruleCode, fields.customerExplanation, JSON.stringify(input.evidence), JSON.stringify(v.checks),
      JSON.stringify(v.missing), JSON.stringify(input.priorCaseRefs), v.missing.length ? 'validation_failed' : 'draft', summary, ts, ts,
    ],
  );
  return { id, missing: v.missing };
}

/** Map the intake service's response onto the dispute record. Never invents "accepted". */
export function applyDisputeOutcome(disputeId: string, op: { status: string; error_code?: string | null }, result?: WriteResult | null): DisputeStatus {
  let status: DisputeStatus;
  switch (op.status) {
    case 'succeeded':
      status = 'submitted';
      break;
    case 'submitted':
      status = 'pending';
      break;
    case 'unknown':
      status = 'unknown';
      break;
    case 'failed':
      status = op.error_code === 'DOWNSTREAM_REJECTED' ? 'rejected' : 'failed';
      break;
    case 'awaiting_approval':
      status = 'needs_review';
      break;
    case 'rejected':
      status = 'draft';
      break;
    default:
      status = 'submitting';
  }
  run('UPDATE disputes SET status = ?, external_ref = COALESCE(?, external_ref), downstream_status = COALESCE(?, downstream_status), updated_at = ? WHERE id = ?', [
    status, result?.externalRef ?? null, result?.downstreamStatus ?? null, nowIso(), disputeId,
  ]);
  return status;
}

export function getDispute(id: string) {
  const d = get<Record<string, unknown>>('SELECT * FROM disputes WHERE id = ?', [id]);
  return d ? { ...d, evidence: parseJson(d.evidence_json, []), missingFields: parseJson(d.missing_fields_json, []), validation: parseJson(d.validation_json, {}) } : null;
}
