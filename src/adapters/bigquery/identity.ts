/**
 * BIGQUERY identity lookups (ADAPTER_MODE=bigquery). Who the caller is comes from the customers
 * and cards tables. BigQuery never holds a card number: cards carry `pan_sha256`, and the caller's
 * digits are hashed here before the query, so only pass/fail comes back. Dates of birth and phone
 * numbers are keyed hashes, as in the mock. One-time passcodes are the app's own short-lived
 * state, so they stay with the mock implementation.
 */
import { sha256 } from '../../lib/ids.ts';
import { hashDob, hashPhone, mockIdentity } from '../mock/identity.ts';
import type { IdentityVerificationAdapter } from '../types.ts';
import { bigQuery, T } from './client.ts';

const one = async (sql: string, params: Record<string, string>) => {
  const c = bigQuery();
  const [r] = await c.query<{ customer_id: string }>(sql.replace(/\{(\w+)\}/g, (_m, t: string) => T(c, t)), params);
  return r ? { customerId: r.customer_id } : null;
};

export const bqIdentity: IdentityVerificationAdapter = {
  identifyByAni: (_ctx, ani) => one('SELECT customer_id FROM {customers} WHERE phone_hash = @h LIMIT 1', { h: hashPhone(ani) }),
  identifyByCustomerNumber: (_ctx, n) => one('SELECT customer_id FROM {customers} WHERE customer_number = @n LIMIT 1', { n: n.replace(/\D/g, '') }),
  identifyByCardNumber: (_ctx, cardNumber) => one('SELECT customer_id FROM {cards} WHERE pan_sha256 = @h LIMIT 1', { h: sha256(cardNumber.replace(/\D/g, '')) }),
  async checkCardNumber(_ctx, customerId, cardNumber) {
    return !!(await one('SELECT customer_id FROM {cards} WHERE customer_id = @c AND pan_sha256 = @h LIMIT 1', { c: customerId, h: sha256(cardNumber.replace(/\D/g, '')) }));
  },
  async checkDateOfBirth(_ctx, customerId, isoDob) {
    return !!(await one('SELECT customer_id FROM {customers} WHERE customer_id = @c AND dob_hash = @h LIMIT 1', { c: customerId, h: hashDob(isoDob) }));
  },
  issueOtp: (ctx, customerId) => mockIdentity.issueOtp(ctx, customerId),
  checkOtp: (ctx, id, code) => mockIdentity.checkOtp(ctx, id, code),
};
