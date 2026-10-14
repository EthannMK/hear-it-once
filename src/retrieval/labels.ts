import type { SourceName } from '../config/policy.ts';
/** Display names for the logical (simulated) systems. */
export const SOURCE_DISPLAY: Record<SourceName, string> = {
  customer_profile: 'Customer profile',
  card_status: 'Card status',
  transactions: 'Transactions',
  fraud_alerts: 'Fraud signals',
  prior_cases: 'Previous cases',
  dispute_rules: 'Dispute rules',
  payment_status: 'Payment status',
  fee_policy: 'Fee policy',
};
