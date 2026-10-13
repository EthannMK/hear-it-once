import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb } from '../helpers.ts';
import { fraudDisputeEligibility, assessDuplicate, feeReversalEligibility } from '../../src/policy/eligibility.ts';
import type { DisputeRule, Transaction, FeeData } from '../../src/adapters/types.ts';
import { freezeClock, resetClock } from '../../src/lib/clock.ts';

const NOW = new Date('2026-10-13T12:00:00Z');
const daysAgo = (d: number, h = 0) => new Date(NOW.getTime() - d * 86_400_000 - h * 3_600_000).toISOString();
const rules: DisputeRule[] = [
  { ruleCode: 'DR-FRAUD-01', reason: 'fraud_unrecognised', description: '', maxDaysSinceTxn: 120, minAmountMinor: 100, allowedEntryModes: ['ecommerce', 'contactless'], requiresCardBlock: true, requiredFields: [], automatable: true, version: 't' },
  { ruleCode: 'DR-DUP-01', reason: 'duplicate_charge', description: '', maxDaysSinceTxn: 120, minAmountMinor: 100, allowedEntryModes: ['chip'], requiresCardBlock: false, requiredFields: [], automatable: true, version: 't' },
];
const txn = (o: Partial<Transaction>): Transaction => ({
  transactionId: 'T1', cardRef: 'C1', kind: 'purchase', merchant: 'SHOP', merchantCategory: null, amountMinor: 5000, currency: 'USD', transactedAt: daysAgo(3), postedAt: daysAgo(2),
  status: 'posted', entryMode: 'ecommerce', authCode: 'A1', relatedPaymentId: null, ...o,
});
const card = { cardRef: 'C1', last4: '1234', network: 'Visa', product: 'x', holderRole: 'primary' as const, holderName: 'x', status: 'active' as const, statusReason: null };

beforeEach(() => {
  freshDb();
  freezeClock(NOW);
  return () => resetClock();
});

describe('fraud dispute eligibility', () => {
  it('eligible when every check positively passes', () => {
    const d = fraudDisputeEligibility({ txn: txn({}), rules, priorCases: [], activeDisputeTxnIds: [], card });
    expect(d.eligible).toBe(true);
    expect(d.ruleCode).toBe('DR-FRAUD-01');
  });
  it.each([
    ['pending', { status: 'pending' as const }, 'posted'],
    ['too old', { transactedAt: daysAgo(130) }, 'within_window'],
    ['below minimum', { amountMinor: 50 }, 'min_amount'],
    ['chip and PIN', { entryMode: 'chip_pin' }, 'entry_mode_automatable'],
    ['not a purchase', { kind: 'payment' as const }, 'is_purchase'],
  ])('ineligible: %s', (_n, o, failing) => {
    const d = fraudDisputeEligibility({ txn: txn(o), rules, priorCases: [], activeDisputeTxnIds: [], card });
    expect(d.eligible).toBe(false);
    expect(d.checks.find((c) => !c.passed)?.check).toBe(failing);
  });
  it('ineligible when already disputed or no rule exists (absence of error ≠ eligibility)', () => {
    expect(fraudDisputeEligibility({ txn: txn({}), rules, priorCases: [], activeDisputeTxnIds: ['T1'], card }).eligible).toBe(false);
    expect(fraudDisputeEligibility({ txn: txn({}), rules: [], priorCases: [], activeDisputeTxnIds: [], card }).eligible).toBe(false);
  });
});

describe('duplicate assessment', () => {
  const pair = (o2: Partial<Transaction> = {}) => [
    txn({ transactionId: 'A', merchant: 'Harbor Grill', amountMinor: 8640, transactedAt: daysAgo(2, 2), entryMode: 'chip', authCode: 'H1' }),
    txn({ transactionId: 'B', merchant: 'Harbor Grill', amountMinor: 8640, transactedAt: daysAgo(2, 1), entryMode: 'chip', authCode: 'H2', ...o2 }),
  ];
  it('confirmed duplicate: both posted, ≤24h, distinct auths, no credit', () => {
    const a = assessDuplicate({ txns: pair(), rules, merchantHint: 'Harbor Grill', amountMinor: null, activeDisputeTxnIds: [] });
    expect(a.status).toBe('confirmed_duplicate');
    expect(a.duplicate?.transactionId).toBe('B');
  });
  it('insufficient when one is pending', () => {
    expect(assessDuplicate({ txns: pair({ status: 'pending' }), rules, merchantHint: null, amountMinor: null, activeDisputeTxnIds: [] }).status).toBe('insufficient_evidence');
  });
  it('insufficient when far apart or same authorisation', () => {
    expect(assessDuplicate({ txns: pair({ transactedAt: daysAgo(0) }), rules, merchantHint: null, amountMinor: null, activeDisputeTxnIds: [] }).status).toBe('insufficient_evidence');
    expect(assessDuplicate({ txns: pair({ authCode: 'H1' }), rules, merchantHint: null, amountMinor: null, activeDisputeTxnIds: [] }).status).toBe('insufficient_evidence');
  });
  it('insufficient when the merchant already credited', () => {
    const txns = [...pair(), txn({ transactionId: 'R', kind: 'refund', merchant: 'Harbor Grill', amountMinor: -8640, transactedAt: daysAgo(1) })];
    expect(assessDuplicate({ txns, rules, merchantHint: null, amountMinor: null, activeDisputeTxnIds: [] }).status).toBe('insufficient_evidence');
  });
  it('no candidate when nothing matches', () => {
    expect(assessDuplicate({ txns: [txn({})], rules, merchantHint: null, amountMinor: null, activeDisputeTxnIds: [] }).status).toBe('no_candidate');
  });
});

describe('fee reversal eligibility + configured limits', () => {
  const data = (o: Partial<FeeData> = {}): FeeData => ({
    fees: [], policies: [{ ruleCode: 'FP-LATE-01', feeType: 'late_payment', reversible: true, description: 'x', version: 't' }, { ruleCode: 'FP-ANNUAL-01', feeType: 'annual_fee', reversible: false, description: 'Annual fees are not reversible', version: 't' }],
    reversalsLast12Months: 0, accountStanding: 'good', latePaymentsLast12Months: 1, ...o,
  });
  const fee = (o = {}) => ({ feeId: 'F1', transactionId: null, feeType: 'late_payment', amountMinor: 2900, currency: 'USD', chargedAt: daysAgo(3), reversedAt: null, ...o });
  it('eligible within limits', () => expect(feeReversalEligibility({ fee: fee(), data: data() }).eligible).toBe(true));
  it('limit: amount above configured maximum', () => expect(feeReversalEligibility({ fee: fee({ amountMinor: 4500 }), data: data() }).eligible).toBe(false));
  it('limit: one reversal per 12 months', () => expect(feeReversalEligibility({ fee: fee(), data: data({ reversalsLast12Months: 1 }) }).eligible).toBe(false));
  it('non-reversible fee type', () => expect(feeReversalEligibility({ fee: fee({ feeType: 'annual_fee' }), data: data() }).eligible).toBe(false));
  it('account not in good standing', () => expect(feeReversalEligibility({ fee: fee(), data: data({ accountStanding: 'delinquent' }) }).eligible).toBe(false));
  it('already reversed', () => expect(feeReversalEligibility({ fee: fee({ reversedAt: daysAgo(1) }), data: data() }).eligible).toBe(false));
});
