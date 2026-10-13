/**
 * ACTION EXECUTION SERVICE (BRD §8, FR-08, FR-17).
 *
 * Lifecycle:  requested → validated → awaiting_confirmation → (awaiting_approval) → submitted
 *             → succeeded | failed | unknown            (any pre-submit step may → rejected)
 *
 * Guarantees
 * - Every operation has a unique ID, an idempotency key (unique per action type), a validated
 *   parameter schema, a persisted policy decision, consent reference, audit trail and outcome.
 * - Submission uses an atomic compare-and-set on status, so duplicate or concurrent requests
 *   can never execute the same operation twice.
 * - The downstream call uses the operation ID as ITS idempotency key.
 * - A timeout after sending → `unknown`. Unknown operations are never retried blindly:
 *   they must be reconciled (status lookup) first. Retry is allowed only when reconciliation
 *   proves the downstream system never received the request.
 * - Success is reported only when the downstream service confirms it.
 */
import { z } from 'zod';
import { adapters } from '../adapters/registry.ts';
import { SourceUnavailableError, type AdapterContext, type WriteResult } from '../adapters/types.ts';
import { env } from '../config/env.ts';
import { policy, type ActionType, type ActorType } from '../config/policy.ts';
import { all, get, run, tx } from '../db/db.ts';
import { nowIso } from '../lib/clock.ts';
import { AppError } from '../lib/errors.ts';
import { newId, stableHash } from '../lib/ids.ts';
import { TimeoutError, withTimeout } from '../lib/resilience.ts';
import { audit, type Actor } from '../audit/audit.ts';
import { authorizeAction, type ActionRequest, type PolicyDecision } from '../policy/engine.ts';
import { loadSnapshot, sourceData } from '../retrieval/retrieval.ts';
import { applyDisputeOutcome } from '../disputes/dispute-service.ts';
import { caseEvent } from '../cases/case-service.ts';
import { log } from '../lib/logger.ts';

export type OpStatus = 'requested' | 'validated' | 'rejected' | 'awaiting_confirmation' | 'awaiting_approval' | 'submitted' | 'succeeded' | 'failed' | 'unknown';

export interface Operation {
  id: string;
  idempotency_key: string;
  action_type: ActionType;
  session_id: string;
  case_id: string | null;
  customer_id: string;
  target_ref: string;
  params_json: string;
  params_hash: string;
  consent_id: string | null;
  actor_type: ActorType;
  actor_id: string;
  policy_decision_json: string | null;
  status: OpStatus;
  external_ref: string | null;
  error_code: string | null;
  error_message: string | null;
  attempts: number;
  approved_by: string | null;
  requested_at: string;
  submitted_at: string | null;
  completed_at: string | null;
  last_reconciled_at: string | null;
}

const ParamSchemas: Record<ActionType, z.ZodType> = {
  block_card: z.object({ reason: z.enum(['lost', 'stolen', 'fraud']) }).strict(),
  order_replacement: z.object({ deliveryAddress: z.literal('address_on_file') }).strict(),
  submit_dispute: z.object({ disputeId: z.string().regex(/^DSP-[A-Z0-9]+$/) }).strict(),
  reverse_fee: z.object({ ruleCode: z.string().min(3).max(40) }).strict(),
  create_case: z.object({}).passthrough(),
  initiate_handoff: z.object({}).passthrough(),
};

const RETRYABLE_FAILURES = new Set(['NOT_RECEIVED', 'DOWNSTREAM_UNAVAILABLE']);

export interface PrepareInput extends Omit<ActionRequest, 'consentId'> {
  idempotencyKey: string;
  correlationId: string;
  scenarioId?: string | null;
}

export const getOp = (id: string) => get<Operation>('SELECT * FROM action_operations WHERE id = ?', [id]);
const opByKey = (type: string, key: string) => get<Operation>('SELECT * FROM action_operations WHERE action_type = ? AND idempotency_key = ?', [type, key]);

function transition(op: Operation, to: OpStatus, fields: Record<string, unknown> = {}, note?: string, onlyFrom?: OpStatus[]): boolean {
  const sets = ['status = ?', 'updated_at = ?', ...Object.keys(fields).map((k) => `${k} = ?`)];
  const guard = onlyFrom ? ` AND status IN (${onlyFrom.map(() => '?').join(',')})` : '';
  const r = run(`UPDATE action_operations SET ${sets.join(', ')} WHERE id = ?${guard}`, [to, nowIso(), ...Object.values(fields), op.id, ...(onlyFrom ?? [])]);
  if (r.changes === 1) {
    run('INSERT INTO action_status_history (operation_id, from_status, to_status, note, created_at) VALUES (?,?,?,?,?)', [op.id, op.status, to, note ?? null, nowIso()]);
    op.status = to;
    return true;
  }
  return false;
}

function auditOp(op: Operation, actor: Actor, event: string, status: 'ok' | 'denied' | 'failed' | 'unknown' | 'info', metadata: Record<string, unknown> = {}, correlationId?: string) {
  audit({ actor, event: `action.${event}`, status, resourceType: 'action_operation', resourceId: op.id, sessionId: op.session_id, correlationId, metadata: { type: op.action_type, target: op.target_ref, ...metadata } });
}

/**
 * Create (or idempotently return) an operation and pre-validate it. Ends in
 * `awaiting_confirmation` when consent is still needed, or `rejected`.
 */
export function prepareAction(input: PrepareInput): { op: Operation; created: boolean } {
  const schema = ParamSchemas[input.type];
  const parsed = schema.safeParse(input.params);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', 'Invalid action parameters.', { issues: parsed.error.issues.map((i) => i.message) });
  const paramsHash = stableHash({ type: input.type, target: input.targetRef, params: parsed.data, customer: input.customerId, session: input.sessionId });
  const actor: Actor = { type: input.actor.type === 'agent' ? 'agent' : input.actor.type, id: input.actor.id } as Actor;

  const res = tx(() => {
    const existing = opByKey(input.type, input.idempotencyKey);
    if (existing) {
      if (existing.params_hash !== paramsHash) throw new AppError('IDEMPOTENCY_MISMATCH', 'This idempotency key was already used with different parameters.', { operationId: existing.id });
      return { op: existing, created: false };
    }
    const id = newId('OP');
    const ts = nowIso();
    run(
      `INSERT INTO action_operations (id, idempotency_key, action_type, session_id, case_id, customer_id, target_ref, params_json, params_hash, actor_type, actor_id, status, requested_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, 'requested', ?, ?)`,
      [id, input.idempotencyKey, input.type, input.sessionId, input.caseId, input.customerId, input.targetRef, JSON.stringify(parsed.data), paramsHash, input.actor.type, input.actor.id, ts, ts],
    );
    run('INSERT INTO action_status_history (operation_id, from_status, to_status, created_at) VALUES (?, NULL, ?, ?)', [id, 'requested', ts]);
    return { op: getOp(id)!, created: true };
  });
  if (!res.created) {
    auditOp(res.op, actor, 'duplicate_request', 'info', { idempotencyKey: input.idempotencyKey, currentStatus: res.op.status }, input.correlationId);
    return res;
  }
  auditOp(res.op, actor, 'requested', 'ok', { idempotencyKey: input.idempotencyKey }, input.correlationId);

  // Pre-validation without consent: everything except the consent check must pass for the
  // operation to wait for confirmation. Dependency checks (e.g. "card blocked first") are
  // re-evaluated at confirmation time.
  const decision = authorizeAction({ ...input, consentId: null });
  const blocking = decision.checks.filter((c) => !c.passed && c.check !== 'consent' && !['card_blocked_first', 'dispute_eligible'].includes(c.check));
  const op = res.op;
  if (blocking.length) {
    const code = blocking[0].detail.split(':')[0];
    transition(op, 'rejected', { policy_decision_json: JSON.stringify(decision), error_code: code, error_message: blocking[0].detail.slice(code.length + 2), completed_at: nowIso() }, 'pre-validation failed');
    auditOp(op, actor, 'rejected', 'denied', { reason: code, checks: decision.checks }, input.correlationId);
    return { op: getOp(op.id)!, created: true };
  }
  transition(op, 'validated', { policy_decision_json: JSON.stringify(decision) });
  if (policy().actions[input.type].requiresConsent) transition(op, 'awaiting_confirmation');
  return { op: getOp(op.id)!, created: true };
}

/**
 * Consent arrived (or is not required): run full authorisation, then submit.
 * Safe to call concurrently/duplicately — only one caller wins the CAS into `submitted`.
 */
export async function confirmAndExecute(opId: string, consentId: string | null, actor: Actor, correlationId: string): Promise<Operation> {
  const op = getOp(opId);
  if (!op) throw new AppError('NOT_FOUND', 'Operation not found.');
  if (!['awaiting_confirmation', 'validated'].includes(op.status)) {
    auditOp(op, actor, 'duplicate_confirmation', 'info', { currentStatus: op.status }, correlationId);
    return op; // already in flight or finished: never re-execute
  }
  const snapshotId = currentSnapshotId(op.session_id);
  const decision = authorizeAction(toRequest(op, consentId, snapshotId));
  // Only link a consent that actually exists (a forged/unknown id is recorded in the decision, not as a FK).
  const realConsent = consentId && get('SELECT 1 FROM consents WHERE id = ?', [consentId]) ? consentId : null;
  run('UPDATE action_operations SET consent_id = ?, policy_decision_json = ? WHERE id = ?', [realConsent, JSON.stringify({ ...decision, suppliedConsentId: consentId }), op.id]);
  op.consent_id = realConsent;
  if (!decision.allowed) {
    const failed = decision.checks.find((c) => !c.passed)!;
    transition(op, 'rejected', { error_code: decision.denialCode, error_message: failed.detail.replace(/^[A-Z_]+: /, ''), completed_at: nowIso() }, 'authorisation failed', ['awaiting_confirmation', 'validated']);
    auditOp(op, actor, 'rejected', 'denied', { reason: decision.denialCode, checks: decision.checks }, correlationId);
    if (op.action_type === 'submit_dispute') applyDisputeOutcome(JSON.parse(op.params_json).disputeId, { status: 'rejected' });
    return getOp(op.id)!;
  }
  if (decision.requiresApproval) {
    transition(op, 'awaiting_approval', {}, 'human approval required by policy', ['awaiting_confirmation', 'validated']);
    auditOp(op, actor, 'awaiting_approval', 'info', {}, correlationId);
    if (op.action_type === 'submit_dispute') applyDisputeOutcome(JSON.parse(op.params_json).disputeId, { status: 'awaiting_approval' });
    return getOp(op.id)!;
  }
  return submit(op, actor, correlationId, ['awaiting_confirmation', 'validated']);
}

/** One-shot request used by direct API / agent: prepare + confirm. */
export async function requestAction(input: PrepareInput & { consentId: string | null }, actor: Actor): Promise<{ op: Operation; created: boolean }> {
  const { op, created } = prepareAction(input);
  if (!created || op.status === 'rejected') return { op, created };
  return { op: await confirmAndExecute(op.id, input.consentId, actor, input.correlationId), created };
}

export function declineAction(opId: string, actor: Actor, correlationId: string): Operation | undefined {
  const op = getOp(opId);
  if (!op) return undefined;
  if (transition(op, 'rejected', { error_code: 'CUSTOMER_DECLINED', error_message: 'Customer declined the proposed action.', completed_at: nowIso() }, 'customer declined', ['awaiting_confirmation', 'validated', 'awaiting_approval'])) {
    auditOp(op, actor, 'declined', 'info', {}, correlationId);
  }
  return getOp(opId);
}

async function submit(op: Operation, actor: Actor, correlationId: string, from: OpStatus[]): Promise<Operation> {
  // Atomic compare-and-set: exactly one caller proceeds to the downstream call.
  const won = tx(() => transition(op, 'submitted', { submitted_at: nowIso(), attempts: op.attempts + 1 }, `attempt ${op.attempts + 1}`, from));
  if (!won) return getOp(op.id)!;
  auditOp(op, actor, 'submitted', 'ok', { attempt: op.attempts + 1 }, correlationId);
  const disputeId = op.action_type === 'submit_dispute' ? (JSON.parse(op.params_json).disputeId as string) : null;
  if (disputeId) run("UPDATE disputes SET status = 'submitting', operation_id = ?, updated_at = ? WHERE id = ?", [op.id, nowIso(), disputeId]);

  const ctx: AdapterContext = { correlationId, sessionId: op.session_id, customerId: op.customer_id, scenarioId: scenarioOf(op.session_id) };
  const started = Date.now();
  let result: WriteResult | null = null;
  try {
    result = await withTimeout(execute(op, ctx), env().ACTION_TIMEOUT_MS);
    applyResult(op, result, actor, correlationId);
  } catch (e) {
    if (e instanceof TimeoutError) {
      transition(op, 'unknown', { error_code: 'TIMEOUT_AFTER_SUBMIT', error_message: 'No confirmation received in time; outcome must be reconciled before any retry.' }, 'timeout after submission');
      auditOp(op, actor, 'outcome_unknown', 'unknown', { afterMs: e.afterMs }, correlationId);
    } else if (e instanceof SourceUnavailableError) {
      // Connection refused before the request was accepted: provably not received.
      transition(op, 'failed', { error_code: 'DOWNSTREAM_UNAVAILABLE', error_message: 'The service was unavailable; the request was not received.', completed_at: nowIso() }, 'downstream unavailable');
      auditOp(op, actor, 'failed', 'failed', { code: 'DOWNSTREAM_UNAVAILABLE' }, correlationId);
    } else {
      // Unexpected error after sending: we cannot know whether it applied.
      transition(op, 'unknown', { error_code: 'UNEXPECTED_ERROR', error_message: 'Outcome could not be confirmed.' }, 'unexpected error');
      auditOp(op, actor, 'outcome_unknown', 'unknown', { error: (e as Error).message }, correlationId);
      log.error('action.execute_error', { opId: op.id, err: (e as Error).message });
    }
  }
  run('INSERT INTO integration_calls (session_id, correlation_id, source, operation, direction, status, latency_ms, attempts, error_code, started_at) VALUES (?,?,?,?,\'write\',?,?,?,?,?)', [
    op.session_id, correlationId, writerFor(op.action_type), op.action_type,
    op.status === 'unknown' ? 'timeout' : op.status === 'failed' && op.error_code === 'DOWNSTREAM_UNAVAILABLE' ? 'unavailable' : op.status === 'failed' ? 'error' : 'ok',
    Date.now() - started, 1, getOp(op.id)!.error_code, nowIso(),
  ]);
  const final = getOp(op.id)!;
  if (disputeId) applyDisputeOutcome(disputeId, final, result);
  if (final.case_id) caseEvent(final.case_id, 'action_outcome', { operationId: final.id, type: final.action_type, status: final.status, externalRef: final.external_ref, errorCode: final.error_code });
  return final;
}

function applyResult(op: Operation, r: WriteResult, actor: Actor, correlationId: string): void {
  if (r.outcome === 'succeeded') {
    transition(op, 'succeeded', { external_ref: r.externalRef, error_code: null, error_message: null, completed_at: nowIso() }, 'confirmed by downstream service');
    auditOp(op, actor, 'succeeded', 'ok', { externalRef: r.externalRef }, correlationId);
  } else if (r.outcome === 'pending') {
    run('UPDATE action_operations SET error_code = ?, error_message = ? WHERE id = ?', ['PENDING_DOWNSTREAM', 'Accepted for processing but not yet confirmed by the downstream service.', op.id]);
    auditOp(op, actor, 'pending', 'info', { downstreamStatus: r.downstreamStatus }, correlationId);
  } else {
    transition(op, 'failed', { error_code: r.failureCode ?? 'DOWNSTREAM_FAILED', error_message: 'The service rejected the request.', completed_at: nowIso() }, 'rejected by downstream');
    auditOp(op, actor, 'failed', 'failed', { code: r.failureCode }, correlationId);
  }
}

function execute(op: Operation, ctx: AdapterContext): Promise<WriteResult> {
  const w = adapters().writers;
  const p = JSON.parse(op.params_json);
  switch (op.action_type) {
    case 'block_card':
      return w.card_control.blockCard(ctx, { cardRef: op.target_ref, reason: p.reason }, op.id);
    case 'order_replacement':
      return w.replacement.orderReplacement(ctx, { cardRef: op.target_ref, deliveryAddress: 'address_on_file' }, op.id);
    case 'reverse_fee':
      return w.fee_ledger.reverseFee(ctx, { feeId: op.target_ref, customerId: op.customer_id, ruleCode: p.ruleCode }, op.id);
    case 'submit_dispute': {
      const d = get<Record<string, unknown>>('SELECT * FROM disputes WHERE id = ?', [p.disputeId])!;
      return w.dispute_intake.submitDispute(
        ctx,
        {
          customerId: String(d.customer_id), cardRef: String(d.card_id), transactionId: String(d.transaction_id), merchant: String(d.merchant), amountMinor: Number(d.amount_minor),
          currency: String(d.currency), transactionDate: String(d.txn_date), reasonCode: String(d.reason_code), customerExplanation: String(d.customer_explanation ?? ''),
          evidence: JSON.parse(String(d.evidence_json)), caseId: String(d.case_id),
        },
        op.id,
      );
    }
    default:
      throw new AppError('VALIDATION_FAILED', `Action ${op.action_type} is not executable here.`);
  }
}

function writerFor(t: ActionType): 'card_control' | 'replacement' | 'dispute_intake' | 'fee_ledger' {
  return t === 'block_card' ? 'card_control' : t === 'order_replacement' ? 'replacement' : t === 'submit_dispute' ? 'dispute_intake' : 'fee_ledger';
}

/**
 * Reconcile an operation whose outcome is unknown or pending by asking the downstream
 * system for the status of OUR idempotency key. Never re-sends the request.
 */
export async function reconcile(opId: string, actor: Actor, correlationId: string): Promise<Operation> {
  const op = getOp(opId);
  if (!op) throw new AppError('NOT_FOUND', 'Operation not found.');
  if (!['unknown', 'submitted'].includes(op.status)) return op;
  const ctx: AdapterContext = { correlationId, sessionId: op.session_id, customerId: op.customer_id, scenarioId: scenarioOf(op.session_id) };
  const w = adapters().writers[writerFor(op.action_type)];
  const found = await withTimeout(w.lookup(ctx, op.id), env().ACTION_TIMEOUT_MS);
  run('UPDATE action_operations SET last_reconciled_at = ? WHERE id = ?', [nowIso(), op.id]);
  let result: WriteResult | null = null;
  if (!found.found) {
    transition(op, 'failed', { error_code: 'NOT_RECEIVED', error_message: 'Reconciliation: the service has no record of this request. It is safe to retry.', completed_at: nowIso() }, 'reconciled: not received', ['unknown', 'submitted']);
    auditOp(op, actor, 'reconciled', 'ok', { found: false }, correlationId);
  } else {
    result = found;
    if (found.outcome === 'succeeded')
      transition(op, 'succeeded', { external_ref: found.externalRef, error_code: null, error_message: null, completed_at: nowIso() }, 'reconciled: confirmed', ['unknown', 'submitted']);
    else if (found.outcome === 'failed')
      transition(op, 'failed', { error_code: found.failureCode ?? 'DOWNSTREAM_FAILED', error_message: 'Reconciliation: the service reports the request failed.', completed_at: nowIso() }, 'reconciled: failed', ['unknown', 'submitted']);
    else if (op.status === 'unknown') transition(op, 'submitted', { error_code: 'PENDING_DOWNSTREAM', error_message: 'Reconciliation: received, still pending.' }, 'reconciled: pending', ['unknown']);
    auditOp(op, actor, 'reconciled', 'ok', { found: true, outcome: found.outcome }, correlationId);
  }
  const final = getOp(op.id)!;
  if (final.action_type === 'submit_dispute') applyDisputeOutcome(JSON.parse(final.params_json).disputeId, final, result);
  if (final.case_id) caseEvent(final.case_id, 'action_reconciled', { operationId: final.id, status: final.status });
  return final;
}

/** Retry only when it is provably safe: failed AND the downstream never received it. */
export async function retryAction(opId: string, actor: Actor, correlationId: string): Promise<Operation> {
  const op = getOp(opId);
  if (!op) throw new AppError('NOT_FOUND', 'Operation not found.');
  if (op.status === 'unknown') throw new AppError('OPERATION_OUTCOME_UNKNOWN', 'The outcome is unknown. Reconcile the operation before retrying.');
  if (op.status !== 'failed' || !RETRYABLE_FAILURES.has(op.error_code ?? '')) throw new AppError('CONFLICT', 'This operation cannot be retried safely.', { status: op.status, errorCode: op.error_code });
  const decision = authorizeAction(toRequest(op, op.consent_id, currentSnapshotId(op.session_id)));
  if (!decision.allowed) throw new AppError(decision.denialCode ?? 'POLICY_DENIED', 'The action is no longer authorised.', { checks: decision.checks });
  return submit(op, actor, correlationId, ['failed']);
}

/** Human approval (agent) for an operation held by policy. */
export async function approveAction(opId: string, approver: Actor, correlationId: string): Promise<Operation> {
  const op = getOp(opId);
  if (!op) throw new AppError('NOT_FOUND', 'Operation not found.');
  if (op.status !== 'awaiting_approval') throw new AppError('CONFLICT', `Operation is ${op.status}, not awaiting approval.`);
  const decision = authorizeAction(toRequest(op, op.consent_id, currentSnapshotId(op.session_id)));
  if (!decision.allowed) throw new AppError(decision.denialCode ?? 'POLICY_DENIED', 'The action is no longer authorised.', { checks: decision.checks });
  run('UPDATE action_operations SET approved_by = ? WHERE id = ?', [approver.id, op.id]);
  auditOp(op, approver, 'approved', 'ok', {}, correlationId);
  return submit(op, approver, correlationId, ['awaiting_approval']);
}

export function rejectApproval(opId: string, approver: Actor, correlationId: string, reason: string): Operation {
  const op = getOp(opId);
  if (!op || op.status !== 'awaiting_approval') throw new AppError('CONFLICT', 'Operation is not awaiting approval.');
  transition(op, 'rejected', { error_code: 'AGENT_REJECTED', error_message: reason.slice(0, 200), approved_by: approver.id, completed_at: nowIso() }, 'agent rejected', ['awaiting_approval']);
  auditOp(op, approver, 'approval_rejected', 'info', { reason }, correlationId);
  return getOp(opId)!;
}

function toRequest(op: Operation, consentId: string | null, snapshotId: string | null): ActionRequest {
  return {
    type: op.action_type,
    sessionId: op.session_id,
    caseId: op.case_id,
    customerId: op.customer_id,
    targetRef: op.target_ref,
    params: JSON.parse(op.params_json),
    consentId,
    snapshotId,
    actor: { type: op.actor_type, id: op.actor_id },
  };
}

export function currentSnapshotId(sessionId: string): string | null {
  return get<{ id: string }>('SELECT id FROM retrieval_snapshots WHERE session_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1', [sessionId])?.id ?? null;
}

function scenarioOf(sessionId: string): string | null {
  return get<{ scenario_id: string | null }>('SELECT scenario_id FROM call_sessions WHERE id = ?', [sessionId])?.scenario_id ?? null;
}

export function opsForSession(sessionId: string): Operation[] {
  return all<Operation>('SELECT * FROM action_operations WHERE session_id = ? ORDER BY requested_at, rowid', [sessionId]);
}

export function opHistory(opId: string) {
  return all('SELECT from_status, to_status, note, created_at FROM action_status_history WHERE operation_id = ? ORDER BY id', [opId]);
}

export function policyDecisionOf(op: Operation): PolicyDecision | null {
  return op.policy_decision_json ? (JSON.parse(op.policy_decision_json) as PolicyDecision) : null;
}

/** Utility for workflows: the card a snapshot knows about. */
export function snapshotCard(sessionId: string, cardRef: string) {
  const id = currentSnapshotId(sessionId);
  const snap = id ? loadSnapshot(id) : null;
  return snap ? sourceData(snap, 'card_status')?.find((c) => c.cardRef === cardRef) ?? null : null;
}
