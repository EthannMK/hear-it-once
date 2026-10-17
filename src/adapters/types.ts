/**
 * TYPED INTEGRATION CONTRACTS for the logical bank systems (BRD §9.1).
 *
 * These are logical boundaries. In this prototype every implementation is a MOCK backed by
 * the local SQLite `bank_*` tables; none is a real bank integration. Replacing a mock with
 * an approved provider means implementing the same interface — workflows do not change.
 */
import type { SourceName } from '../config/policy.ts';

export interface AdapterContext {
  correlationId: string;
  sessionId?: string | null;
  scenarioId?: string | null;
  customerId?: string | null;
}

/** Every read returns data plus the source's own freshness timestamp. */
export interface SourceData<T> {
  data: T;
  /** When the source says this data was current (freshness). */
  asOf: string;
}

/* ---------------------------------------------------------------- 1. Customer & identity */
export interface CustomerProfile {
  customerId: string;
  firstName: string;
  fullName: string;
  standing: 'good' | 'delinquent' | 'closed';
  segment: string;
  phoneMasked: string;
  contactChangedAt: string | null;
}
export interface CustomerProfileAdapter {
  getProfile(ctx: AdapterContext, customerId: string): Promise<SourceData<CustomerProfile>>;
}

export interface IdentityVerificationAdapter {
  /** Identification only (who the caller claims to be). Never proof of identity. */
  identifyByAni(ctx: AdapterContext, ani: string): Promise<{ customerId: string } | null>;
  identifyByCustomerNumber(ctx: AdapterContext, customerNumber: string): Promise<{ customerId: string } | null>;
  /** Demo: find the customer who holds this full card number. Used when the caller is not pre-identified. */
  identifyByCardNumber(ctx: AdapterContext, cardNumber: string): Promise<{ customerId: string } | null>;
  /** Demo knowledge factor: the full card number. Returns only pass/fail, never the expected value. */
  checkCardNumber(ctx: AdapterContext, customerId: string, cardNumber: string): Promise<boolean>;
  /** Knowledge factor. */
  checkDateOfBirth(ctx: AdapterContext, customerId: string, isoDob: string): Promise<boolean>;
  /** Possession factor: one-time passcode sent to the registered device. */
  issueOtp(ctx: AdapterContext, customerId: string): Promise<{ challengeId: string; deliveredTo: string; demoCode: string | null; expiresAt: string }>;
  checkOtp(ctx: AdapterContext, challengeId: string, code: string): Promise<'passed' | 'failed' | 'expired' | 'locked'>;
}

/* ---------------------------------------------------------------- 2. Card status & controls */
export type CardStatus = 'active' | 'blocked' | 'closed';
export interface CardSummary {
  cardRef: string;
  last4: string;
  network: string;
  product: string;
  holderRole: 'primary' | 'additional';
  holderName: string;
  status: CardStatus;
  statusReason: string | null;
}
export interface CardAdapter {
  listCards(ctx: AdapterContext, customerId: string): Promise<SourceData<CardSummary[]>>;
}

/* ---------------------------------------------------------------- 3. Transactions */
export interface Transaction {
  transactionId: string;
  cardRef: string | null;
  kind: 'purchase' | 'payment' | 'fee' | 'refund' | 'credit' | 'cash_advance';
  merchant: string | null;
  merchantCategory: string | null;
  amountMinor: number;
  currency: string;
  transactedAt: string;
  postedAt: string | null;
  status: 'pending' | 'posted' | 'reversed';
  entryMode: string | null;
  authCode: string | null;
  relatedPaymentId: string | null;
}
export interface TransactionAdapter {
  listTransactions(ctx: AdapterContext, customerId: string, sinceDays: number): Promise<SourceData<Transaction[]>>;
}

/* ---------------------------------------------------------------- 4. Fraud alerts */
export interface FraudAlert {
  alertId: string;
  cardRef: string | null;
  transactionId: string | null;
  alertType: string;
  riskLevel: 'low' | 'medium' | 'high';
  status: 'open' | 'closed';
  reportedCardStatus: CardStatus | null;
  reportedAmountMinor: number | null;
  createdAt: string;
}
export interface FraudAdapter {
  listAlerts(ctx: AdapterContext, customerId: string): Promise<SourceData<FraudAlert[]>>;
}

/* ---------------------------------------------------------------- 5. Prior cases */
export interface PriorCase {
  caseId: string;
  issueType: string | null;
  status: string;
  resolutionStatus: string | null;
  summary: string | null;
  transactionRefs: string[];
  createdAt: string;
  updatedAt: string;
}
export interface PriorCasesAdapter {
  listCases(ctx: AdapterContext, customerId: string, sinceDays: number): Promise<SourceData<PriorCase[]>>;
}

/* ---------------------------------------------------------------- 6. Dispute rules & intake */
export interface DisputeRule {
  ruleCode: string;
  reason: 'fraud_unrecognised' | 'duplicate_charge' | 'incorrect_amount';
  description: string;
  maxDaysSinceTxn: number;
  minAmountMinor: number;
  allowedEntryModes: string[];
  requiresCardBlock: boolean;
  requiredFields: string[];
  automatable: boolean;
  version: string;
}
export interface DisputeRulesAdapter {
  getRules(ctx: AdapterContext): Promise<SourceData<DisputeRule[]>>;
}

export interface DisputeSubmission {
  customerId: string;
  cardRef: string;
  transactionId: string;
  merchant: string;
  amountMinor: number;
  currency: string;
  transactionDate: string;
  reasonCode: string;
  customerExplanation: string;
  evidence: { type: string; description: string }[];
  caseId: string;
}

/* ---------------------------------------------------------------- 7. Payment posting */
export interface PaymentRecord {
  paymentId: string;
  amountMinor: number;
  currency: string;
  initiatedAt: string;
  channel: string;
  sourceAccountMasked: string;
  status: 'pending' | 'posted' | 'returned' | 'failed';
  statusDetail: string | null;
  postedAt: string | null;
  /** Present ONLY when the payment system itself supplies it. Never inferred. */
  expectedPostingDate: string | null;
  statusAsOf: string;
}
export interface PaymentAdapter {
  listPayments(ctx: AdapterContext, customerId: string, sinceDays: number): Promise<SourceData<PaymentRecord[]>>;
}

/* ---------------------------------------------------------------- 7b. Card authorisations (declines) */
export interface DeclineRecord {
  declineId: string;
  cardRef: string | null;
  merchant: string;
  amountMinor: number;
  currency: string;
  declinedAt: string;
  reasonCode: 'travel_security_rule' | 'insufficient_available_credit' | 'card_blocked' | 'card_expired' | 'merchant_category_restricted';
  suggestedAction: string | null;
}
export interface DeclineAdapter {
  listDeclines(ctx: AdapterContext, customerId: string, sinceDays: number): Promise<SourceData<DeclineRecord[]>>;
}

/* ---------------------------------------------------------------- 8. Fees & reversal rules */
export interface FeeRecord {
  feeId: string;
  transactionId: string | null;
  feeType: string;
  amountMinor: number;
  currency: string;
  chargedAt: string;
  reversedAt: string | null;
}
export interface FeePolicyRule {
  ruleCode: string;
  feeType: string;
  reversible: boolean;
  description: string;
  version: string;
}
export interface FeeData {
  fees: FeeRecord[];
  policies: FeePolicyRule[];
  reversalsLast12Months: number;
  accountStanding: 'good' | 'delinquent' | 'closed';
  latePaymentsLast12Months: number;
}
export interface FeeAdapter {
  getFeeData(ctx: AdapterContext, customerId: string): Promise<SourceData<FeeData>>;
}

/* ---------------------------------------------------------------- Writes (all systems) */
export type WriteOutcome = 'succeeded' | 'failed' | 'pending';
export interface WriteResult {
  outcome: WriteOutcome;
  externalRef: string | null;
  failureCode: string | null;
  /** Simulated downstream status (disputes) — never a final ruling. */
  downstreamStatus?: string | null;
  detail?: Record<string, unknown>;
}
/** Reconciliation lookup. 'not_found' means the system never received the request. */
export type OperationLookup = { found: false } | ({ found: true } & WriteResult);

export interface CardControlWriteAdapter {
  blockCard(ctx: AdapterContext, req: { cardRef: string; reason: 'lost' | 'stolen' | 'fraud' }, idempotencyKey: string): Promise<WriteResult>;
  lookup(ctx: AdapterContext, idempotencyKey: string): Promise<OperationLookup>;
}
export interface ReplacementWriteAdapter {
  orderReplacement(ctx: AdapterContext, req: { cardRef: string; deliveryAddress: 'address_on_file' }, idempotencyKey: string): Promise<WriteResult>;
  lookup(ctx: AdapterContext, idempotencyKey: string): Promise<OperationLookup>;
}
export interface DisputeIntakeWriteAdapter {
  submitDispute(ctx: AdapterContext, req: DisputeSubmission, idempotencyKey: string): Promise<WriteResult>;
  lookup(ctx: AdapterContext, idempotencyKey: string): Promise<OperationLookup>;
}
export interface FeeLedgerWriteAdapter {
  reverseFee(ctx: AdapterContext, req: { feeId: string; customerId: string; ruleCode: string }, idempotencyKey: string): Promise<WriteResult>;
  lookup(ctx: AdapterContext, idempotencyKey: string): Promise<OperationLookup>;
}

/** Registry of all adapters (dependency-injected so tests and real providers can swap them). */
export interface AdapterRegistry {
  /** "mock": synthetic tables in the local database. "bigquery": synthetic bank dataset in BigQuery. */
  mode: 'mock' | 'bigquery';
  /** Optional: put a demo customer's changeable bank state back to its seeded values (see refreshDemoFixtures). */
  resetDemoCustomer?(customerId: string): Promise<void>;
  identity: IdentityVerificationAdapter;
  readers: {
    customer_profile: CustomerProfileAdapter;
    card_status: CardAdapter;
    transactions: TransactionAdapter;
    fraud_alerts: FraudAdapter;
    prior_cases: PriorCasesAdapter;
    dispute_rules: DisputeRulesAdapter;
    payment_status: PaymentAdapter;
    fee_policy: FeeAdapter;
    card_declines: DeclineAdapter;
  };
  writers: {
    card_control: CardControlWriteAdapter;
    replacement: ReplacementWriteAdapter;
    dispute_intake: DisputeIntakeWriteAdapter;
    fee_ledger: FeeLedgerWriteAdapter;
  };
}

export type ReaderName = keyof AdapterRegistry['readers'];
const _check: Record<ReaderName, SourceName> = {
  customer_profile: 'customer_profile',
  card_status: 'card_status',
  transactions: 'transactions',
  fraud_alerts: 'fraud_alerts',
  prior_cases: 'prior_cases',
  dispute_rules: 'dispute_rules',
  payment_status: 'payment_status',
  fee_policy: 'fee_policy',
  card_declines: 'card_declines',
};
void _check;

export class SourceUnavailableError extends Error {
  constructor(readonly source: string, readonly code = 'SOURCE_UNAVAILABLE') {
    super(`${source} unavailable`);
  }
}
