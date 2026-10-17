/** BigQuery adapter registry (ADAPTER_MODE=bigquery). */
import type { AdapterRegistry } from '../types.ts';
import { bqIdentity } from './identity.ts';
import { bqCards, bqCustomerProfile, bqDeclines, bqDisputeRules, bqFees, bqFraud, bqPayments, bqPriorCases, bqTransactions } from './readers.ts';
import { bqCardControl, bqDisputeIntake, bqFeeLedger, bqReplacement, resetDemoCustomer } from './writers.ts';

export const bigQueryRegistry: AdapterRegistry = {
  mode: 'bigquery',
  identity: bqIdentity,
  readers: {
    customer_profile: bqCustomerProfile,
    card_status: bqCards,
    transactions: bqTransactions,
    fraud_alerts: bqFraud,
    prior_cases: bqPriorCases,
    dispute_rules: bqDisputeRules,
    payment_status: bqPayments,
    fee_policy: bqFees,
    card_declines: bqDeclines,
  },
  writers: {
    card_control: bqCardControl,
    replacement: bqReplacement,
    dispute_intake: bqDisputeIntake,
    fee_ledger: bqFeeLedger,
  },
  resetDemoCustomer,
};
