/**
 * AGENT-TRIGGERED IDENTITY CHECK.
 *
 * A human agent who has taken the call can send a one-time passcode to the customer's registered
 * number and ask them to type it in. This is how a contact centre re-checks a caller before doing
 * something sensitive, and it is deliberately kept apart from the call's own verification state
 * machine: it issues its own challenge, records its own result, and changes nothing about the stage
 * the conversation is in.
 *
 * Two rules it exists to keep (see FP-02 and FP-10 in `src/security/fraud-patterns.ts`):
 * the agent never sees the code, and the result is recorded against the agent who asked for it.
 */
import { adapters } from '../adapters/registry.ts';
import { audit, type Actor } from '../audit/audit.ts';
import { AppError } from '../lib/errors.ts';
import { get, run } from '../db/db.ts';
import { nowIso } from '../lib/clock.ts';
import { emitTimeline } from '../events/timeline.ts';
import { policy } from '../config/policy.ts';

export interface AgentCheck {
  challengeId: string;
  /** Masked destination, e.g. "•••-•••-0101". Safe to show to the agent. */
  deliveredTo: string;
  requestedBy: string;
  requestedByName: string;
  requestedAt: string;
  attempts: number;
  status: 'awaiting' | 'passed' | 'failed';
  completedAt?: string;
}

/** The call this check belongs to, with the handoff that gives the agent the right to ask for it. */
function callFor(sessionId: string, agentId: string) {
  const s = get<{ id: string; customer_id: string | null; scenario_id: string | null; ended_at: string | null; correlation_id: string }>(
    'SELECT id, customer_id, scenario_id, ended_at, correlation_id FROM call_sessions WHERE id = ?',
    [sessionId],
  );
  if (!s) throw new AppError('NOT_FOUND', 'Call not found.');
  if (s.ended_at) throw new AppError('CONFLICT', 'That call has ended.');
  const h = get<{ id: string; status: string; agent_id: string | null }>(
    'SELECT id, status, agent_id FROM handoffs WHERE session_id = ? ORDER BY requested_at DESC LIMIT 1',
    [sessionId],
  );
  if (!h || h.status !== 'connected') throw new AppError('CONFLICT', 'Only the agent on a connected call can run an identity check.');
  if (h.agent_id !== agentId) throw new AppError('FORBIDDEN', 'That call was accepted by another agent.');
  return s;
}

/**
 * Send a passcode to the customer's registered number. Returns where it went, masked; the code
 * itself is never returned, logged or shown to staff.
 */
export async function startAgentCheck(sessionId: string, actor: Actor & { id: string }, agentName: string): Promise<AgentCheck> {
  const s = callFor(sessionId, actor.id);
  if (!s.customer_id) throw new AppError('CONFLICT', 'No customer has been identified on this call yet, so there is nobody to send a passcode to.');
  const otp = await adapters().identity.issueOtp(
    { correlationId: s.correlation_id, sessionId, scenarioId: s.scenario_id },
    s.customer_id,
  );
  const check: AgentCheck = {
    challengeId: otp.challengeId,
    deliveredTo: otp.deliveredTo,
    requestedBy: actor.id,
    requestedByName: agentName,
    requestedAt: nowIso(),
    attempts: 0,
    status: 'awaiting',
  };
  saveCheck(sessionId, check);
  emitTimeline(sessionId, {
    type: 'verification.agent_requested',
    stage: 'verify',
    title: `${agentName} sent a passcode to the customer`,
    detail: `A one-time passcode went to the registered number (${otp.deliveredTo}). The agent cannot see it; the customer types it in. Requested by ${actor.id}.`,
    status: 'pending',
    source: 'identity verification',
  });
  audit({ actor, event: 'verification.agent_check_sent', status: 'ok', sessionId, resourceType: 'call_session', resourceId: sessionId });
  return check;
}

/**
 * Check a code the customer typed. Returns null when there is nothing to check, so an ordinary
 * number said during a handover is not mistaken for an answer.
 */
export async function submitAgentCheck(sessionId: string, code: string): Promise<{ outcome: 'passed' | 'failed' | 'locked'; check: AgentCheck } | null> {
  const check = readCheck(sessionId);
  if (!check || check.status !== 'awaiting') return null;
  const s = get<{ scenario_id: string | null; correlation_id: string }>('SELECT scenario_id, correlation_id FROM call_sessions WHERE id = ?', [sessionId]);
  check.attempts++;
  const r = await adapters().identity.checkOtp({ correlationId: s?.correlation_id ?? sessionId, sessionId, scenarioId: s?.scenario_id ?? null }, check.challengeId, code);
  const max = policy().verification.maxOtpAttempts;
  const outcome = r === 'passed' ? 'passed' : check.attempts >= max || r === 'locked' || r === 'expired' ? 'locked' : 'failed';
  check.status = outcome === 'passed' ? 'passed' : outcome === 'locked' ? 'failed' : 'awaiting';
  if (check.status !== 'awaiting') check.completedAt = nowIso();
  saveCheck(sessionId, check);
  emitTimeline(sessionId, {
    type: 'verification.agent_result',
    stage: 'verify',
    title: outcome === 'passed' ? 'Customer passed the agent’s passcode check' : outcome === 'locked' ? 'Agent’s passcode check failed' : 'Passcode did not match — customer can try again',
    detail: `Requested by ${check.requestedByName}. Attempt ${check.attempts} of ${max}.`,
    status: outcome === 'passed' ? 'ok' : outcome === 'locked' ? 'warn' : 'info',
    source: 'identity verification',
  });
  audit({
    actor: { type: 'customer_session', id: sessionId },
    event: 'verification.agent_check_answered',
    status: outcome === 'passed' ? 'ok' : 'denied',
    sessionId,
    resourceType: 'call_session',
    resourceId: sessionId,
    metadata: { outcome, attempts: check.attempts, requestedBy: check.requestedBy },
  });
  return { outcome, check };
}

/* The check rides on the call's stored context, so it survives a reconnect like everything else. */

function ctxOf(sessionId: string): Record<string, unknown> {
  const row = get<{ context_json: string }>('SELECT context_json FROM call_sessions WHERE id = ?', [sessionId]);
  try {
    return row ? (JSON.parse(row.context_json) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function readCheck(sessionId: string): AgentCheck | null {
  const c = ctxOf(sessionId).agentCheck as AgentCheck | undefined;
  return c ?? null;
}

function saveCheck(sessionId: string, check: AgentCheck): void {
  const ctx = ctxOf(sessionId);
  ctx.agentCheck = check;
  run('UPDATE call_sessions SET context_json = ?, updated_at = ? WHERE id = ?', [JSON.stringify(ctx), nowIso(), sessionId]);
}
