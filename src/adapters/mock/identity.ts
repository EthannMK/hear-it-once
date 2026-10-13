/**
 * MOCK identity-verification provider. SIMULATED, DEMO ONLY.
 *
 * Knowledge factor: date of birth (compared as a keyed hash; plaintext never stored).
 * Possession factor: one-time passcode "sent" to the registered device. In DEMO_MODE the
 * code is shown in the simulator's clearly labelled "simulated device" panel.
 * A real deployment must replace this with the bank-approved identity method.
 */
import { get, run } from '../../db/db.ts';
import { env } from '../../config/env.ts';
import { policy } from '../../config/policy.ts';
import { hmac, newId, randomDigits, safeEqual, sha256 } from '../../lib/ids.ts';
import { nowIso, nowMs } from '../../lib/clock.ts';
import type { IdentityVerificationAdapter } from '../types.ts';
import { simulatedLatency } from './faults.ts';

/** Fixed key for hashing SYNTHETIC identity attributes in the mock bank tables. */
const MOCK_IDENTITY_PEPPER = 'hio-mock-identity-pepper-synthetic-data-only';

export const hashDob = (isoDob: string) => hmac(MOCK_IDENTITY_PEPPER, `dob:${isoDob}`);
export const normalisePhone = (p: string) => p.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
export const hashPhone = (p: string) => hmac(MOCK_IDENTITY_PEPPER, `phone:${normalisePhone(p)}`);

export const mockIdentity: IdentityVerificationAdapter = {
  async identifyByAni(_ctx, ani) {
    await simulatedLatency(20, 20);
    const r = get<{ id: string }>('SELECT id FROM bank_customers WHERE phone_hash = ?', [hashPhone(ani)]);
    return r ? { customerId: r.id } : null;
  },
  async identifyByCustomerNumber(_ctx, n) {
    await simulatedLatency(20, 20);
    const r = get<{ id: string }>('SELECT id FROM bank_customers WHERE customer_number = ?', [n.replace(/\D/g, '')]);
    return r ? { customerId: r.id } : null;
  },
  async checkDateOfBirth(_ctx, customerId, isoDob) {
    await simulatedLatency(30, 30);
    const r = get<{ dob_hash: string }>('SELECT dob_hash FROM bank_customers WHERE id = ?', [customerId]);
    return !!r && safeEqual(r.dob_hash, hashDob(isoDob));
  },
  async issueOtp(ctx, customerId) {
    await simulatedLatency(30, 30);
    const cfg = policy().verification;
    const code = randomDigits(cfg.otpLength);
    const id = newId('OTP');
    const expiresAt = new Date(nowMs() + cfg.otpTtlSeconds * 1000).toISOString();
    const demo = env().DEMO_MODE ? code : null;
    run('UPDATE otp_challenges SET demo_display = NULL WHERE session_id = ? AND consumed_at IS NULL', [ctx.sessionId]);
    run(
      'INSERT INTO otp_challenges (id, session_id, customer_id, code_hash, demo_display, expires_at, created_at) VALUES (?,?,?,?,?,?,?)',
      [id, ctx.sessionId, customerId, sha256(`${id}:${code}`), demo, expiresAt, nowIso()],
    );
    const cust = get<{ phone_masked: string }>('SELECT phone_masked FROM bank_customers WHERE id = ?', [customerId]);
    return { challengeId: id, deliveredTo: cust?.phone_masked ?? 'registered device', demoCode: demo, expiresAt };
  },
  async checkOtp(_ctx, challengeId, code) {
    await simulatedLatency(20, 20);
    const c = get<{ code_hash: string; expires_at: string; attempts: number; consumed_at: string | null }>(
      'SELECT code_hash, expires_at, attempts, consumed_at FROM otp_challenges WHERE id = ?',
      [challengeId],
    );
    if (!c || c.consumed_at) return 'expired';
    if (c.expires_at < nowIso()) {
      run('UPDATE otp_challenges SET demo_display = NULL WHERE id = ?', [challengeId]);
      return 'expired';
    }
    if (c.attempts >= policy().verification.maxOtpAttempts) return 'locked';
    run('UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = ?', [challengeId]);
    if (safeEqual(c.code_hash, sha256(`${challengeId}:${code.replace(/\D/g, '')}`))) {
      run('UPDATE otp_challenges SET consumed_at = ?, demo_display = NULL WHERE id = ?', [nowIso(), challengeId]);
      return 'passed';
    }
    return c.attempts + 1 >= policy().verification.maxOtpAttempts ? 'locked' : 'failed';
  },
};
