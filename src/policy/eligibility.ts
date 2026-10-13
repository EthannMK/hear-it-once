/**
 * DETERMINISTIC ELIGIBILITY RULES. Pure functions over retrieved facts. Every decision
 * carries the rule code/version it was based on and plain-language reasons. Absence of an
 * error is never treated as eligibility: each rule must positively pass.
 */
import type { CardSummary, DisputeRule, FeeData, FeeRecord, PriorCase, Transaction } from '../adapters/types.ts';
import { policy } from '../config/policy.ts';
import { nowMs } from '../lib/clock.ts';
import { normaliseMerchant } from '../ai/parsers.ts';

export interface RuleCheck {
  check: string;
  passed: boolean;
  detail: string;
}

export interface EligibilityDecision {
  eligible: boolean;
  ruleCode: string | null;
  ruleVersion: string | null;
  checks: RuleCheck[];
  /** Plain-language reasons for an ineligible decision (customer-facing). */
  reasons: string[];
  /** An agent may still help (e.g. investigation) even though automation is not allowed. */
  agentCanHelp: boolean;
}

const DAY = 86_400_000;
const daysSince = (iso: string) => Math.floor((nowMs() - Date.parse(iso)) / DAY);

function decide(rule: DisputeRule | null, checks: RuleCheck[], agentCanHelp = true): EligibilityDecision {
  return {
    eligible: !!rule && checks.length > 0 && checks.every((c) => c.passed),
    ruleCode: rule?.ruleCode ?? null,
    ruleVersion: rule?.version ?? null,
    checks,
    reasons: checks.filter((c) => !c.passed).map((c) => c.detail),
    agentCanHelp,
  };
}

/** Fraud / unrecognised-transaction dispute eligibility (DR-FRAUD-01). */
export function fraudDisputeEligibility(input: {
  txn: Transaction;
  rules: DisputeRule[];
  priorCases: PriorCase[];
  activeDisputeTxnIds: string[];
  card: CardSummary | null;
}): EligibilityDecision {
  const rule = input.rules.find((r) => r.reason === 'fraud_unrecognised') ?? null;
  if (!rule) return decide(null, [{ check: 'rule_available', passed: false, detail: 'No dispute rule is available for this reason.' }]);
  const t = input.txn;
  const age = daysSince(t.transactedAt);
  const checks: RuleCheck[] = [
    { check: 'is_purchase', passed: t.kind === 'purchase' || t.kind === 'cash_advance', detail: 'Only purchases or cash advances can be disputed this way.' },
    { check: 'posted', passed: t.status === 'posted', detail: 'The transaction is still pending, so it cannot be disputed until it posts.' },
    { check: 'within_window', passed: age <= rule.maxDaysSinceTxn, detail: `The transaction is ${age} days old; the limit is ${rule.maxDaysSinceTxn} days.` },
    { check: 'min_amount', passed: t.amountMinor >= rule.minAmountMinor, detail: 'The amount is below the minimum for a dispute.' },
    { check: 'entry_mode_automatable', passed: !!t.entryMode && rule.allowedEntryModes.includes(t.entryMode), detail: 'This transaction type (for example chip and PIN) needs a specialist investigation rather than an automated dispute.' },
    { check: 'not_already_disputed', passed: !input.activeDisputeTxnIds.includes(t.transactionId), detail: 'There is already an active dispute for this transaction.' },
    { check: 'card_on_account', passed: !!input.card && input.card.cardRef === t.cardRef, detail: 'The transaction could not be linked to a card on this account.' },
    { check: 'rule_automatable', passed: rule.automatable, detail: 'This dispute type must be handled by an agent.' },
  ];
  return decide(rule, checks);
}

export interface DuplicateAssessment {
  status: 'confirmed_duplicate' | 'insufficient_evidence' | 'no_candidate';
  original: Transaction | null;
  duplicate: Transaction | null;
  evidence: string[];
  decision: EligibilityDecision;
}

/** Duplicate-charge assessment (DR-DUP-01). Never concludes "duplicate" from a model. */
export function assessDuplicate(input: { txns: Transaction[]; rules: DisputeRule[]; merchantHint: string | null; amountMinor: number | null; activeDisputeTxnIds: string[] }): DuplicateAssessment {
  const rule = input.rules.find((r) => r.reason === 'duplicate_charge') ?? null;
  const purchases = input.txns.filter((t) => t.kind === 'purchase' && t.merchant);
  const groups = new Map<string, Transaction[]>();
  for (const t of purchases) {
    const k = `${normaliseMerchant(t.merchant!)}|${t.amountMinor}`;
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  let candidates = [...groups.values()].filter((g) => g.length >= 2);
  if (input.merchantHint) {
    const h = normaliseMerchant(input.merchantHint);
    const narrowed = candidates.filter((g) => normaliseMerchant(g[0].merchant!).includes(h) || h.includes(normaliseMerchant(g[0].merchant!)));
    if (narrowed.length) candidates = narrowed;
  }
  if (input.amountMinor) {
    const narrowed = candidates.filter((g) => g[0].amountMinor === input.amountMinor);
    if (narrowed.length) candidates = narrowed;
  }
  if (candidates.length !== 1) {
    return {
      status: 'no_candidate',
      original: null,
      duplicate: null,
      evidence: candidates.length > 1 ? ['More than one possible pair of matching charges was found.'] : ['No two charges with the same merchant and amount were found.'],
      decision: decide(rule, [{ check: 'single_candidate_pair', passed: false, detail: 'I could not identify a single pair of matching charges.' }]),
    };
  }
  const pair = [...candidates[0]].sort((a, b) => Date.parse(a.transactedAt) - Date.parse(b.transactedAt)).slice(-2);
  const [a, b] = pair;
  const hours = Math.abs(Date.parse(b.transactedAt) - Date.parse(a.transactedAt)) / 3_600_000;
  const credit = input.txns.some(
    (t) => (t.kind === 'refund' || t.kind === 'credit') && t.merchant && normaliseMerchant(t.merchant) === normaliseMerchant(a.merchant!) && Date.parse(t.transactedAt) >= Date.parse(a.transactedAt),
  );
  const maxH = policy().duplicate.maxHoursBetween;
  const checks: RuleCheck[] = [
    { check: 'both_posted', passed: a.status === 'posted' && b.status === 'posted', detail: 'One of the two charges is still pending. Pending authorisations often drop off by themselves, so it is too early to treat it as a duplicate.' },
    { check: 'within_hours', passed: hours <= maxH, detail: `The charges are ${Math.round(hours)} hours apart, which could be two separate purchases.` },
    { check: 'no_merchant_credit', passed: !credit, detail: 'The merchant has already issued a credit.' },
    { check: 'distinct_authorisations', passed: !!a.authCode && !!b.authCode && a.authCode !== b.authCode, detail: 'The two records may be the same authorisation.' },
    { check: 'not_already_disputed', passed: !input.activeDisputeTxnIds.includes(b.transactionId), detail: 'There is already an active dispute for this charge.' },
    { check: 'rule_available', passed: !!rule && rule.automatable, detail: 'No automated duplicate-charge rule is available.' },
  ];
  const decision = decide(rule, checks);
  const evidence = [
    `Two charges at ${a.merchant} for the same amount, ${hours < 1 ? 'less than an hour' : `about ${Math.round(hours)} hour${Math.round(hours) === 1 ? '' : 's'}`} apart.`,
    `First: ${a.status}, authorisation ${a.authCode ?? 'n/a'}. Second: ${b.status}, authorisation ${b.authCode ?? 'n/a'}.`,
  ];
  return { status: decision.eligible ? 'confirmed_duplicate' : 'insufficient_evidence', original: a, duplicate: b, evidence, decision };
}

/** Fee reversal eligibility (FP-* rules + configured limits). */
export function feeReversalEligibility(input: { fee: FeeRecord; data: FeeData }): EligibilityDecision {
  const cfg = policy().feeReversal;
  const pol = input.data.policies.find((p) => p.feeType === input.fee.feeType) ?? null;
  const asRule = pol ? ({ ruleCode: pol.ruleCode, version: pol.version } as DisputeRule) : null;
  if (!pol) return decide(null, [{ check: 'policy_available', passed: false, detail: 'No reversal policy exists for this fee type.' }]);
  const checks: RuleCheck[] = [
    { check: 'fee_reversible', passed: pol.reversible, detail: `${pol.description}` },
    { check: 'not_already_reversed', passed: !input.fee.reversedAt, detail: 'This fee has already been reversed.' },
    { check: 'within_amount_limit', passed: input.fee.amountMinor <= cfg.maxAmountMinor, detail: 'The fee is above the amount the assistant is allowed to reverse.' },
    { check: 'reversal_frequency', passed: input.data.reversalsLast12Months < cfg.maxReversalsPer12Months, detail: `A courtesy reversal has already been given in the last 12 months (limit ${cfg.maxReversalsPer12Months}).` },
    { check: 'good_standing', passed: input.data.accountStanding === 'good', detail: 'The account is not in good standing.' },
  ];
  return decide(asRule, checks);
}
