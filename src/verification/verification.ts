/**
 * IDENTITY VERIFICATION STATE MACHINE (FR-04).
 *
 *   not_started ──ANI match──▶ awaiting_dob ──DOB ok──▶ awaiting_otp ──OTP ok──▶ verified
 *        │                         │ (≤3 fails)            │ (≤3 fails)
 *        └─no match─▶ identifying ─┘                       ▼
 *                         (≤3 fails) ───────────────────▶ failed (locked)
 *
 * Identification (ANI / customer number) is never proof of identity. Two factors are
 * required: knowledge (DOB) + possession (one-time passcode). Voice, claimed name, phone
 * number alone, or model confidence never count. Failure messages are generic so they do
 * not reveal which factor failed or whether a customer exists.
 */
import { adapters } from '../adapters/registry.ts';
import { policy } from '../config/policy.ts';
import { run } from '../db/db.ts';
import { nowIso } from '../lib/clock.ts';
import { audit, type Actor } from '../audit/audit.ts';
import { parseCustomerNumber, parseDob, parseOtp } from '../ai/parsers.ts';

export type VerificationStatus = 'not_started' | 'identifying' | 'awaiting_dob' | 'awaiting_otp' | 'verified' | 'failed';

export interface VerificationState {
  status: VerificationStatus;
  identifiedCustomerId: string | null;
  identifiedBy: 'ani' | 'customer_number' | null;
  idAttempts: number;
  dobAttempts: number;
  otpAttempts: number;
  challengeId: string | null;
  deliveredTo: string | null;
  verifiedAt: string | null;
  level: 'standard' | null;
}

export const initialVerification = (): VerificationState => ({
  status: 'not_started',
  identifiedCustomerId: null,
  identifiedBy: null,
  idAttempts: 0,
  dobAttempts: 0,
  otpAttempts: 0,
  challengeId: null,
  deliveredTo: null,
  verifiedAt: null,
  level: null,
});

export type VerificationEvent =
  | { type: 'need_identifier' }
  | { type: 'need_dob' }
  | { type: 'otp_sent'; deliveredTo: string }
  | { type: 'retry'; step: 'identify' | 'dob' | 'otp'; remaining: number; unparsed: boolean }
  | { type: 'verified' }
  | { type: 'locked'; step: 'identify' | 'dob' | 'otp' };

interface Ctx {
  sessionId: string;
  correlationId: string;
  scenarioId: string | null;
  actor: Actor;
}

function record(ctx: Ctx, customerId: string | null, step: 'identify' | 'dob' | 'otp', method: string, outcome: 'passed' | 'failed' | 'locked' | 'issued', reason?: string) {
  run('INSERT INTO verification_attempts (session_id, customer_id, step, method, outcome, failure_reason, created_at) VALUES (?,?,?,?,?,?,?)', [
    ctx.sessionId, customerId, step, method, outcome, reason ?? null, nowIso(),
  ]);
  audit({
    actor: ctx.actor,
    event: `verification.${step}`,
    status: outcome === 'passed' || outcome === 'issued' ? 'ok' : outcome === 'locked' ? 'denied' : 'failed',
    resourceType: 'session',
    resourceId: ctx.sessionId,
    sessionId: ctx.sessionId,
    correlationId: ctx.correlationId,
    metadata: { method, outcome, reason: reason ?? null },
  });
}

function syncSession(ctx: Ctx, s: VerificationState): void {
  const status = s.status === 'verified' ? 'verified' : s.status === 'failed' ? 'failed' : s.status === 'not_started' ? 'not_started' : s.identifiedCustomerId ? 'identified' : 'in_progress';
  run(
    `UPDATE call_sessions SET verification_status = ?, verification_level = ?, verified_at = COALESCE(verified_at, ?),
       customer_id = CASE WHEN ? = 'verified' THEN ? ELSE customer_id END, updated_at = ? WHERE id = ?`,
    [status, s.level, s.verifiedAt, s.status, s.identifiedCustomerId, nowIso(), ctx.sessionId],
  );
}

/** Begin verification: try to identify the caller from the ANI (caller ID). */
export async function startVerification(ctx: Ctx, s: VerificationState, ani: string | null): Promise<VerificationEvent> {
  const a = adapters().identity;
  const actx = { correlationId: ctx.correlationId, sessionId: ctx.sessionId, scenarioId: ctx.scenarioId };
  if (ani) {
    const hit = await a.identifyByAni(actx, ani);
    if (hit) {
      s.identifiedCustomerId = hit.customerId;
      s.identifiedBy = 'ani';
      s.status = 'awaiting_dob';
      record(ctx, hit.customerId, 'identify', 'ani', 'passed');
      syncSession(ctx, s);
      return { type: 'need_dob' };
    }
  }
  s.status = 'identifying';
  syncSession(ctx, s);
  return { type: 'need_identifier' };
}

/** Feed one caller answer into the state machine. The raw answer is never persisted. */
export async function submitVerificationAnswer(ctx: Ctx, s: VerificationState, answer: string): Promise<VerificationEvent> {
  const cfg = policy().verification;
  const a = adapters().identity;
  const actx = { correlationId: ctx.correlationId, sessionId: ctx.sessionId, scenarioId: ctx.scenarioId, customerId: s.identifiedCustomerId };

  if (s.status === 'identifying') {
    const num = parseCustomerNumber(answer);
    s.idAttempts++;
    const hit = num ? await a.identifyByCustomerNumber(actx, num) : null;
    if (hit) {
      s.identifiedCustomerId = hit.customerId;
      s.identifiedBy = 'customer_number';
      s.status = 'awaiting_dob';
      record(ctx, hit.customerId, 'identify', 'customer_number', 'passed');
      syncSession(ctx, s);
      return { type: 'need_dob' };
    }
    if (s.idAttempts >= cfg.maxDobAttempts) return lock(ctx, s, 'identify', 'customer_number');
    record(ctx, null, 'identify', 'customer_number', 'failed', num ? 'no_match' : 'unparsed');
    return { type: 'retry', step: 'identify', remaining: cfg.maxDobAttempts - s.idAttempts, unparsed: !num };
  }

  if (s.status === 'awaiting_dob' && s.identifiedCustomerId) {
    const dob = parseDob(answer);
    if (!dob) return { type: 'retry', step: 'dob', remaining: cfg.maxDobAttempts - s.dobAttempts, unparsed: true };
    s.dobAttempts++;
    const ok = await a.checkDateOfBirth(actx, s.identifiedCustomerId, dob);
    if (!ok) {
      if (s.dobAttempts >= cfg.maxDobAttempts) return lock(ctx, s, 'dob', 'knowledge_dob');
      record(ctx, s.identifiedCustomerId, 'dob', 'knowledge_dob', 'failed', 'mismatch');
      return { type: 'retry', step: 'dob', remaining: cfg.maxDobAttempts - s.dobAttempts, unparsed: false };
    }
    record(ctx, s.identifiedCustomerId, 'dob', 'knowledge_dob', 'passed');
    const otp = await a.issueOtp(actx, s.identifiedCustomerId);
    s.challengeId = otp.challengeId;
    s.deliveredTo = otp.deliveredTo;
    s.status = 'awaiting_otp';
    record(ctx, s.identifiedCustomerId, 'otp', 'possession_otp', 'issued');
    syncSession(ctx, s);
    return { type: 'otp_sent', deliveredTo: otp.deliveredTo };
  }

  if (s.status === 'awaiting_otp' && s.identifiedCustomerId && s.challengeId) {
    const code = parseOtp(answer, cfg.otpLength);
    if (!code) return { type: 'retry', step: 'otp', remaining: cfg.maxOtpAttempts - s.otpAttempts, unparsed: true };
    s.otpAttempts++;
    const r = await a.checkOtp(actx, s.challengeId, code);
    if (r === 'passed') {
      s.status = 'verified';
      s.level = 'standard';
      s.verifiedAt = nowIso();
      record(ctx, s.identifiedCustomerId, 'otp', 'possession_otp', 'passed');
      syncSession(ctx, s);
      return { type: 'verified' };
    }
    if (r === 'locked' || r === 'expired' || s.otpAttempts >= cfg.maxOtpAttempts) return lock(ctx, s, 'otp', 'possession_otp', r);
    record(ctx, s.identifiedCustomerId, 'otp', 'possession_otp', 'failed', 'mismatch');
    return { type: 'retry', step: 'otp', remaining: cfg.maxOtpAttempts - s.otpAttempts, unparsed: false };
  }
  return { type: 'locked', step: 'identify' };
}

function lock(ctx: Ctx, s: VerificationState, step: 'identify' | 'dob' | 'otp', method: string, reason = 'max_attempts'): VerificationEvent {
  s.status = 'failed';
  record(ctx, s.identifiedCustomerId, step, method, 'locked', reason);
  syncSession(ctx, s);
  return { type: 'locked', step };
}

/** Server-side gate used by every protected read and write. */
export function isVerified(s: VerificationState | undefined | null): s is VerificationState & { identifiedCustomerId: string } {
  return !!s && s.status === 'verified' && s.level === 'standard' && !!s.identifiedCustomerId;
}
