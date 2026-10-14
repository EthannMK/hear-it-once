/**
 * Adapter registry. Only the mock implementation exists in this prototype; a real provider
 * would be added here behind ADAPTER_MODE without changing workflows.
 */
import { env } from '../config/env.ts';
import type { AdapterRegistry } from './types.ts';
import { mockIdentity } from './mock/identity.ts';
import { mockCardControl, mockDisputeIntake, mockFeeLedger, mockReplacement } from './mock/writers.ts';
import { mockCards, mockCustomerProfile, mockDeclines, mockDisputeRules, mockFees, mockFraud, mockPayments, mockPriorCases, mockTransactions } from './mock/readers.ts';

export const mockRegistry: AdapterRegistry = {
  mode: 'mock',
  identity: mockIdentity,
  readers: {
    customer_profile: mockCustomerProfile,
    card_status: mockCards,
    transactions: mockTransactions,
    fraud_alerts: mockFraud,
    prior_cases: mockPriorCases,
    dispute_rules: mockDisputeRules,
    payment_status: mockPayments,
    fee_policy: mockFees,
    card_declines: mockDeclines,
  },
  writers: {
    card_control: mockCardControl,
    replacement: mockReplacement,
    dispute_intake: mockDisputeIntake,
    fee_ledger: mockFeeLedger,
  },
};

let current: AdapterRegistry | null = null;

export function adapters(): AdapterRegistry {
  if (current) return current;
  const mode = env().ADAPTER_MODE;
  if (mode !== 'mock') {
    throw new Error(`ADAPTER_MODE=${mode} is not available: no approved real integrations exist in this prototype.`);
  }
  current = mockRegistry;
  return current;
}

export function setAdapters(r: AdapterRegistry | null): void {
  current = r;
}
