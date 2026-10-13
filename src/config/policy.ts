/**
 * CENTRAL POLICY CONFIGURATION.
 *
 * Every action permission, limit and eligibility parameter lives here, not in the UI,
 * prompts or workflow code. All values are PROTOTYPE ASSUMPTIONS for a mock-only demo
 * and are NOT approved bank policy (see docs/DECISIONS.md). Fraud, disputes, risk and
 * compliance owners must approve real values before any pilot.
 */
import { env } from './env.ts';

export type ActionType =
  | 'block_card'
  | 'order_replacement'
  | 'submit_dispute'
  | 'reverse_fee'
  | 'create_case'
  | 'initiate_handoff';

export type ActorType = 'customer_session' | 'agent' | 'system';

export type SourceName =
  | 'customer_profile'
  | 'card_status'
  | 'transactions'
  | 'fraud_alerts'
  | 'prior_cases'
  | 'dispute_rules'
  | 'payment_status'
  | 'fee_policy';

export type IssueType =
  | 'unrecognised_transaction'
  | 'lost_stolen_card'
  | 'wrong_or_duplicate_charge'
  | 'payment_not_showing'
  | 'fee_query';

export interface ActionPolicy {
  /** Verification level the session must have reached. */
  requiredVerification: 'standard';
  /** Customer must explicitly consent to a proposal that includes this action. */
  requiresConsent: boolean;
  /** A human agent must approve before submission to the (mock) bank system. */
  requiresHumanApproval: boolean;
  /** Which actor types may request this action at all (least privilege). */
  allowedActors: ActorType[];
  /** Sources that must be fresh, successful and conflict-free at decision time. */
  requiredSources: SourceName[];
  /** Is the downstream operation idempotent by key (safe to resubmit after reconciliation)? */
  downstreamIdempotent: boolean;
}

export interface PolicyConfig {
  profile: 'prototype-mock' | 'pilot-conservative';
  verification: {
    maxDobAttempts: number;
    maxOtpAttempts: number;
    otpTtlSeconds: number;
    otpLength: number;
  };
  retrieval: {
    /** Data older than this (seconds) is "stale" and cannot support a write. */
    maxStalenessSeconds: Partial<Record<SourceName, number>>;
    /** Decisions must be made on a snapshot no older than this. */
    snapshotMaxAgeSeconds: number;
    circuitBreaker: { failureThreshold: number; cooldownMs: number };
  };
  requiredSourcesByIssue: Record<IssueType, SourceName[]>;
  actions: Record<ActionType, ActionPolicy>;
  disputes: { transactionLookbackDays: number };
  duplicate: { maxHoursBetween: number };
  feeReversal: { maxAmountMinor: number; maxReversalsPer12Months: number };
  consent: { ttlSeconds: number };
  conversation: {
    maxSilenceReprompts: number;
    minIntentConfidence: number;
    maxIssueClarifications: number;
    asrMinConfidence: number;
    duplicateUtteranceWindowMs: number;
  };
  handoff: { targetAgentJoinSeconds: number; maxQueueWaitSeconds: number };
}

const DEFAULT_ACTIONS: Record<ActionType, ActionPolicy> = {
  block_card: {
    requiredVerification: 'standard',
    requiresConsent: true,
    requiresHumanApproval: false,
    allowedActors: ['customer_session', 'agent'],
    requiredSources: ['customer_profile', 'card_status'],
    downstreamIdempotent: true,
  },
  order_replacement: {
    requiredVerification: 'standard',
    requiresConsent: true,
    requiresHumanApproval: false,
    allowedActors: ['customer_session', 'agent'],
    requiredSources: ['customer_profile', 'card_status'],
    downstreamIdempotent: true,
  },
  submit_dispute: {
    requiredVerification: 'standard',
    requiresConsent: true,
    requiresHumanApproval: false,
    allowedActors: ['customer_session', 'agent'],
    requiredSources: ['customer_profile', 'card_status', 'transactions', 'prior_cases', 'dispute_rules'],
    downstreamIdempotent: true,
  },
  reverse_fee: {
    requiredVerification: 'standard',
    requiresConsent: true,
    requiresHumanApproval: false,
    allowedActors: ['customer_session', 'agent'],
    requiredSources: ['customer_profile', 'fee_policy'],
    downstreamIdempotent: true,
  },
  create_case: {
    requiredVerification: 'standard',
    requiresConsent: false,
    requiresHumanApproval: false,
    allowedActors: ['customer_session', 'agent', 'system'],
    requiredSources: [],
    downstreamIdempotent: true,
  },
  initiate_handoff: {
    requiredVerification: 'standard',
    requiresConsent: false,
    requiresHumanApproval: false,
    allowedActors: ['customer_session', 'agent', 'system'],
    requiredSources: [],
    downstreamIdempotent: true,
  },
};

export function buildPolicy(profile: PolicyConfig['profile']): PolicyConfig {
  const actions = structuredClone(DEFAULT_ACTIONS);
  if (profile === 'pilot-conservative') {
    // Conservative default for any pilot: every consequential card action needs a human.
    for (const t of ['block_card', 'order_replacement', 'submit_dispute', 'reverse_fee'] as const) {
      actions[t].requiresHumanApproval = true;
    }
  }
  return {
    profile,
    verification: { maxDobAttempts: 3, maxOtpAttempts: 3, otpTtlSeconds: 300, otpLength: 6 },
    retrieval: {
      maxStalenessSeconds: {
        card_status: 120,
        transactions: 900,
        fraud_alerts: 300,
        payment_status: 900,
        fee_policy: 3600,
        customer_profile: 3600,
        prior_cases: 900,
        dispute_rules: 86400,
      },
      snapshotMaxAgeSeconds: 900,
      circuitBreaker: { failureThreshold: 3, cooldownMs: 30_000 },
    },
    requiredSourcesByIssue: {
      unrecognised_transaction: ['customer_profile', 'card_status', 'transactions', 'fraud_alerts', 'prior_cases', 'dispute_rules'],
      lost_stolen_card: ['customer_profile', 'card_status'],
      wrong_or_duplicate_charge: ['customer_profile', 'card_status', 'transactions', 'prior_cases', 'dispute_rules'],
      payment_not_showing: ['customer_profile', 'payment_status', 'transactions'],
      fee_query: ['customer_profile', 'fee_policy'],
    },
    actions,
    disputes: { transactionLookbackDays: 120 },
    duplicate: { maxHoursBetween: 24 },
    feeReversal: { maxAmountMinor: 4000, maxReversalsPer12Months: 1 },
    consent: { ttlSeconds: 600 },
    conversation: {
      maxSilenceReprompts: 2,
      minIntentConfidence: 0.6,
      maxIssueClarifications: 1,
      asrMinConfidence: 0.55,
      duplicateUtteranceWindowMs: 3000,
    },
    handoff: { targetAgentJoinSeconds: 30, maxQueueWaitSeconds: 120 },
  };
}

let cachedPolicy: PolicyConfig | null = null;

/**
 * Resolve the active policy. Safety rule: any adapter mode other than "mock" forces the
 * conservative profile, so real integrations can never inherit prototype autonomy.
 */
export function policy(): PolicyConfig {
  if (cachedPolicy) return cachedPolicy;
  const e = env();
  const profile = e.ADAPTER_MODE !== 'mock' ? 'pilot-conservative' : e.POLICY_PROFILE;
  cachedPolicy = buildPolicy(profile);
  return cachedPolicy;
}

export function setPolicyForTests(p: PolicyConfig | null): void {
  cachedPolicy = p;
}
