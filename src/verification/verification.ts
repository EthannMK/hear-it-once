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
import { parseCardNumber, parseCustomerNumber, parseDob, parseOtp } from '../ai/parsers.ts';

/** Application-level result of one card-number check. The model never decides these. */
export type CardOutcome = 'verified' | 'not_verified' | 'ambiguous' | 'temporarily_unavailable' | 'invalid_input';

const cardChecksInFlight = new Set<string>();
const metrics = { total: 0, totalMs: 0, maxMs: 0, byOutcome: { verified: 0, not_verified: 0, ambiguous: 0, temporarily_unavailable: 0, invalid_input: 0 } as Record<CardOutcome, number> };
function noteCardOutcome(o: CardOutcome, ms: number): void {
  metrics.total++; metrics.totalMs += ms; metrics.maxMs = Math.max(metrics.maxMs, ms); metrics.byOutcome[o]++;
}
/** Timing and outcome counters for card checks. Contains no card data. */
export const cardCheckMetrics = () => ({ checks: metrics.total, avgMs: metrics.total ? Math.round(metrics.totalMs / metrics.total) : 0, maxMs: metrics.maxMs, outcomes: { ...metrics.byOutcome } });

/** One bounded attempt, retried once on error or timeout. A "no match" answer is a result, not an error. */
async function checkCardWithRetry(fn: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const once = () => Promise.race([fn(), new Promise<boolean>((_, rej) => setTimeout(() => rej(new Error('card check timed out')), timeoutMs).unref?.())]);
  try { return await once(); } catch { return await once(); }
}

export type VerificationStatus = 'not_started' | 'identifying' | 'awaiting_dob' | 'awaiting_otp' | 'awaiting_card' | 'verified' | 'failed';

export interface VerificationState {
  status: VerificationStatus;
  identifiedCustomerId: string | null;
  identifiedBy: 'ani' | 'customer_number' | 'card_number' | null;
  idAttempts: number;
  dobAttempts: number;
  otpAttempts: number;
  /** Failed card-number checks (card_number verification mode). */
  cardAttempts?: number;
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
  | { type: 'need_card' }
  | { type: 'otp_sent'; deliveredTo: string }
  | { type: 'retry'; step: 'identify' | 'dob' | 'otp' | 'card'; remaining: number; unparsed: boolean }
  | { type: 'verified' }
  /** The check could not run (timeout or error). No attempt was used and nothing was decided. */
  | { type: 'unavailable'; step: 'card'; latencyMs: number }
  /** Another check for this call is already running; the duplicate was dropped. */
  | { type: 'in_progress' }
  | { type: 'locked'; step: 'identify' | 'dob' | 'otp' | 'card' };

interface Ctx {
  sessionId: string;
  correlationId: string;
  scenarioId: string | null;
  actor: Actor;
}

function record(ctx: Ctx, customerId: string | null, step: 'identify' | 'dob' | 'otp' | 'card', method: string, outcome: 'passed' | 'failed' | 'locked' | 'issued', reason?: string) {
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
export async function startVerification(ctx: Ctx, s: VerificationState, ani: string | null, mode: 'dob_otp' | 'card_number' = 'dob_otp'): Promise<VerificationEvent> {
  const a = adapters().identity;
  const actx = { correlationId: ctx.correlationId, sessionId: ctx.sessionId, scenarioId: ctx.scenarioId };
  if (ani) {
    const hit = await a.identifyByAni(actx, ani);
    if (hit) {
      s.identifiedCustomerId = hit.customerId;
      s.identifiedBy = 'ani';
      s.status = mode === 'card_number' ? 'awaiting_card' : 'awaiting_dob';
      record(ctx, hit.customerId, 'identify', 'ani', 'passed');
      syncSession(ctx, s);
      return mode === 'card_number' ? { type: 'need_card' } : { type: 'need_dob' };
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

  if (s.status === 'awaiting_card') {
    const maxTries = cfg.maxCardAttempts;
    const number = parseCardNumber(answer);
    // Too little was captured to be an answer: ask again without using up an attempt.
    if (!number) { noteCardOutcome('invalid_input', 0); return { type: 'retry', step: 'card', remaining: maxTries - (s.cardAttempts ?? 0), unparsed: true }; }
    // A repeated tool call or speech event must not start a second check for the same call.
    if (cardChecksInFlight.has(ctx.sessionId)) return { type: 'in_progress' };
    cardChecksInFlight.add(ctx.sessionId);
    const t0 = Date.now();
    let ok: boolean;
    try {
      // A caller who has not been identified yet is found by the card number itself.
      ok = await checkCardWithRetry(async () => {
        if (s.identifiedCustomerId) return a.checkCardNumber(actx, s.identifiedCustomerId, number);
        const hit = await a.identifyByCardNumber(actx, number);
        if (!hit) return false;
        s.identifiedCustomerId = hit.customerId;
        s.identifiedBy = 'card_number';
        return true;
      }, cfg.cardCheckTimeoutMs);
    } catch {
      const latencyMs = Date.now() - t0;
      noteCardOutcome('temporarily_unavailable', latencyMs);
      audit({ actor: ctx.actor, event: 'verification.card_unavailable', status: 'failed', resourceType: 'session', resourceId: ctx.sessionId, sessionId: ctx.sessionId, correlationId: ctx.correlationId, metadata: { latencyMs } });
      return { type: 'unavailable', step: 'card', latencyMs };
    } finally {
      cardChecksInFlight.delete(ctx.sessionId);
    }
    const latencyMs = Date.now() - t0;
    s.cardAttempts = (s.cardAttempts ?? 0) + 1;
    if (ok) {
      noteCardOutcome('verified', latencyMs);
      s.status = 'verified';
      s.level = 'standard';
      s.verifiedAt = nowIso();
      record(ctx, s.identifiedCustomerId, 'card', 'card_number', 'passed');
      syncSession(ctx, s);
      return { type: 'verified' };
    }
    noteCardOutcome('not_verified', latencyMs);
    if (s.cardAttempts >= maxTries) return lock(ctx, s, 'card', 'card_number');
    // The supplied number is never stored or logged — only that it did not match.
    record(ctx, s.identifiedCustomerId, 'card', 'card_number', 'failed', 'mismatch');
    return { type: 'retry', step: 'card', remaining: maxTries - s.cardAttempts, unparsed: false };
  }

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

function lock(ctx: Ctx, s: VerificationState, step: 'identify' | 'dob' | 'otp' | 'card', method: string, reason = 'max_attempts'): VerificationEvent {
  s.status = 'failed';
  record(ctx, s.identifiedCustomerId, step, method, 'locked', reason);
  syncSession(ctx, s);
  return { type: 'locked', step };
}

/** Server-side gate used by every protected read and write. */
export function isVerified(s: VerificationState | undefined | null): s is VerificationState & { identifiedCustomerId: string } {
  return !!s && s.status === 'verified' && s.level === 'standard' && !!s.identifiedCustomerId;
}
