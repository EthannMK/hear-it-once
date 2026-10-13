/**
 * CENTRAL POLICY & AUTHORISATION ENGINE.
 *
 * Every consequential action passes through `authorizeAction` server-side, whatever the
 * entry point (conversation, agent console, direct API). It re-derives eligibility from
 * retrieved facts at execution time rather than trusting the proposal, the UI or a model.
 */
import { policy, type ActionType, type ActorType } from '../config/policy.ts';
import { get, parseJson } from '../db/db.ts';
import { nowIso } from '../lib/clock.ts';
import type { ErrorCode } from '../lib/errors.ts';
import { assessSources, loadSnapshot, sourceData, type Snapshot } from '../retrieval/retrieval.ts';
import { assessDuplicate, feeReversalEligibility, fraudDisputeEligibility, type EligibilityDecision, type RuleCheck } from './eligibility.ts';

export interface ActionRequest {
  type: ActionType;
  sessionId: string;
  caseId: string | null;
  customerId: string;
  targetRef: string;
  params: Record<string, unknown>;
  consentId: string | null;
  snapshotId: string | null;
  actor: { type: ActorType; id: string };
}

export interface PolicyDecision {
  allowed: boolean;
  requiresApproval: boolean;
  denialCode: ErrorCode | null;
  checks: RuleCheck[];
  profile: string;
  evaluatedAt: string;
  eligibility: EligibilityDecision | null;
}

export function activeDisputeTxnIds(customerId: string): string[] {
  const r = get<{ ids: string }>(
    "SELECT json_group_array(transaction_id) ids FROM disputes WHERE customer_id = ? AND status IN ('submitting','submitted','pending','needs_review','unknown')",
    [customerId],
  );
  return parseJson<string[]>(r?.ids, []);
}

/** Has a card been confirmed blocked (snapshot says blocked, or our confirmed block op)? */
export function cardConfirmedBlocked(snap: Snapshot | null, customerId: string, cardRef: string): boolean {
  const card = snap ? sourceData(snap, 'card_status')?.find((c) => c.cardRef === cardRef) : null;
  if (card?.status === 'blocked') return true;
  return !!get("SELECT 1 FROM action_operations WHERE action_type = 'block_card' AND customer_id = ? AND target_ref = ? AND status = 'succeeded'", [customerId, cardRef]);
}

export function authorizeAction(req: ActionRequest): PolicyDecision {
  const cfg = policy();
  const ap = cfg.actions[req.type];
  const checks: RuleCheck[] = [];
  let eligibility: EligibilityDecision | null = null;
  const add = (check: string, passed: boolean, detail: string, code: ErrorCode) => checks.push({ check, passed, detail: passed ? 'ok' : `${code}: ${detail}` });

  // 1. Least privilege: actor type.
  add('actor_allowed', ap.allowedActors.includes(req.actor.type), `Actor type ${req.actor.type} may not request ${req.type}.`, 'FORBIDDEN');

  // 2. Verified session bound to this customer.
  const sess = get<{ verification_status: string; verification_level: string | null; customer_id: string | null }>(
    'SELECT verification_status, verification_level, customer_id FROM call_sessions WHERE id = ?',
    [req.sessionId],
  );
  const verified = !!sess && sess.verification_status === 'verified' && sess.verification_level === ap.requiredVerification && sess.customer_id === req.customerId;
  add('session_verified', verified, 'The caller has not completed identity verification for this customer.', 'VERIFICATION_REQUIRED');

  // 3. Explicit consent linked to a proposal that contains this exact action.
  if (ap.requiresConsent) {
    const c = req.consentId
      ? get<{ decision: string; session_id: string; expires_at: string; proposal_id: string }>('SELECT decision, session_id, expires_at, proposal_id FROM consents WHERE id = ?', [req.consentId])
      : undefined;
    const prop = c ? get<{ actions_json: string; status: string }>('SELECT actions_json, status FROM proposals WHERE id = ?', [c.proposal_id]) : undefined;
    const actions = parseJson<{ type: string; targetRef: string }[]>(prop?.actions_json, []);
    const ok =
      !!c && c.decision === 'accepted' && c.session_id === req.sessionId && c.expires_at > nowIso() && prop?.status === 'accepted' && actions.some((a) => a.type === req.type && a.targetRef === req.targetRef);
    add('consent', ok, c ? 'Consent is missing, declined, expired, or does not cover this action.' : 'Explicit customer consent is required for this action.', 'CONSENT_REQUIRED');
  }

  // 4. Fresh, available, conflict-free required sources.
  const snap = req.snapshotId ? loadSnapshot(req.snapshotId) : null;
  if (ap.requiredSources.length) {
    if (!snap || snap.sessionId !== req.sessionId) add('sources', false, 'No retrieval snapshot for this session.', 'SOURCE_DATA_UNSAFE');
    else {
      const s = assessSources(snap, ap.requiredSources);
      add(
        'sources',
        s.safe,
        `Required data is not safe to act on (unavailable: ${s.unavailable.join(', ') || 'none'}; stale: ${s.stale.join(', ') || 'none'}; conflicts: ${s.conflicting.map((c) => c.type).join(', ') || 'none'}${s.snapshotTooOld ? '; snapshot too old' : ''}).`,
        'SOURCE_DATA_UNSAFE',
      );
    }
  }

  // 5. Action-specific deterministic checks (re-derived, not trusted from the proposal).
  // (consent is evaluated independently so pre-validation can still check ownership/eligibility)
  if (snap && checks.filter((c) => c.check !== 'consent').every((c) => c.passed)) {
    const cards = sourceData(snap, 'card_status') ?? [];
    const card = cards.find((c) => c.cardRef === req.targetRef) ?? null;
    switch (req.type) {
      case 'block_card':
        add('card_owned', !!card, 'The card is not on this verified customer’s account.', 'POLICY_DENIED');
        add('card_blockable', !!card && card.status !== 'closed', 'The card is closed.', 'POLICY_DENIED');
        break;
      case 'order_replacement':
        add('card_owned', !!card, 'The card is not on this verified customer’s account.', 'POLICY_DENIED');
        add('card_blocked_first', cardConfirmedBlocked(snap, req.customerId, req.targetRef), 'A replacement can only be ordered after the card block is confirmed.', 'POLICY_DENIED');
        break;
      case 'submit_dispute': {
        const d = get<{ customer_id: string; card_id: string; transaction_id: string; reason_code: string; status: string; missing_fields_json: string; session_id: string }>(
          'SELECT customer_id, card_id, transaction_id, reason_code, status, missing_fields_json, session_id FROM disputes WHERE id = ?',
          [String(req.params.disputeId ?? '')],
        );
        add('dispute_record', !!d && d.customer_id === req.customerId && d.transaction_id === req.targetRef && d.session_id === req.sessionId, 'Dispute record does not match this customer and transaction.', 'POLICY_DENIED');
        if (d) {
          add('dispute_complete', d.status === 'draft' && parseJson<string[]>(d.missing_fields_json, []).length === 0, 'The dispute is missing required information.', 'POLICY_DENIED');
          const txns = sourceData(snap, 'transactions') ?? [];
          const rules = sourceData(snap, 'dispute_rules') ?? [];
          const txn = txns.find((t) => t.transactionId === d.transaction_id);
          const active = activeDisputeTxnIds(req.customerId);
          if (d.reason_code === 'fraud_unrecognised' && txn) {
            eligibility = fraudDisputeEligibility({ txn, rules, priorCases: sourceData(snap, 'prior_cases') ?? [], activeDisputeTxnIds: active, card: cards.find((c) => c.cardRef === txn.cardRef) ?? null });
            const rule = rules.find((r) => r.ruleCode === eligibility!.ruleCode);
            if (rule?.requiresCardBlock) add('card_blocked_first', cardConfirmedBlocked(snap, req.customerId, d.card_id), 'This dispute type requires the card to be blocked first.', 'POLICY_DENIED');
          } else if (d.reason_code === 'duplicate_charge' && txn) {
            eligibility = assessDuplicate({ txns, rules, merchantHint: txn.merchant, amountMinor: txn.amountMinor, activeDisputeTxnIds: active }).decision;
          }
          add('dispute_eligible', !!eligibility?.eligible, eligibility ? eligibility.reasons.join(' ') || 'Not eligible.' : 'No automatable rule applies.', 'POLICY_DENIED');
        }
        break;
      }
      case 'reverse_fee': {
        const feeData = sourceData(snap, 'fee_policy');
        const fee = feeData?.fees.find((f) => f.feeId === req.targetRef) ?? null;
        add('fee_on_account', !!fee, 'The fee is not on this verified customer’s account.', 'POLICY_DENIED');
        if (fee && feeData) {
          eligibility = feeReversalEligibility({ fee, data: feeData });
          add('fee_eligible', eligibility.eligible, eligibility.reasons.join(' '), 'POLICY_DENIED');
        }
        break;
      }
      default:
        break;
    }
  }

  const failed = checks.find((c) => !c.passed);
  const denialCode = failed ? (failed.detail.split(':')[0] as ErrorCode) : null;
  return {
    allowed: !failed,
    requiresApproval: !failed && ap.requiresHumanApproval,
    denialCode,
    checks,
    profile: cfg.profile,
    evaluatedAt: nowIso(),
    eligibility,
  };
}
