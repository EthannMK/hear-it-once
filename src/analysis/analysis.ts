/**
 * POST-CALL ANALYSIS. Runs when a call ends and stores its own status (pending, ready, failed) so
 * that ending a call never claims the call was fully processed. Everything here is built from the
 * persisted transcript and recorded system events. Nothing is inferred beyond them. A failure keeps
 * the transcript and call record intact and can be retried.
 */
import { all, get, parseJson, run } from '../db/db.ts';
import { nowIso } from '../lib/clock.ts';
import { redactText } from '../lib/redact.ts';
import { audit, type Actor } from '../audit/audit.ts';
import { buildResolution } from '../api/brief.ts';
import { kbReferencesFor } from '../kb/kb.ts';
import { HANDOFF_REASON_LABELS, ISSUE_LABELS } from '../conversation/format.ts';
import type { CallContext } from '../conversation/orchestrator.ts';

export type Resolution = 'resolved' | 'partially_resolved' | 'unresolved' | 'escalated' | 'informational';
export type AnalysisStatus = 'pending' | 'ready' | 'failed';

/** Caller-facing lifecycle of a call, derived from persisted state. */
export function lifecycle(sessionId: string): 'active' | 'transferring' | 'connected_to_agent' | 'completed' | 'failed' | null {
  const s = get<{ ended_at: string | null; outcome: string | null }>('SELECT ended_at, outcome FROM call_sessions WHERE id = ?', [sessionId]);
  if (!s) return null;
  const h = get<{ status: string }>("SELECT status FROM handoffs WHERE session_id = ? AND status != 'cancelled' ORDER BY requested_at DESC LIMIT 1", [sessionId]);
  if (s.ended_at) return s.outcome === 'fallback' ? 'failed' : 'completed';
  if (h?.status === 'connected') return 'connected_to_agent';
  if (h && ['requested', 'queued'].includes(h.status)) return 'transferring';
  return 'active';
}

/** The complete transcript as ordered segments. Nothing is truncated; the count says how many exist. */
export function transcriptSegments(sessionId: string) {
  const rows = all<{ seq: number; speaker: string; kind: string; text: string; created_at: string; sensitive_redacted: number; asr_confidence: number | null }>(
    'SELECT seq, speaker, kind, text, created_at, sensitive_redacted, asr_confidence FROM conversation_turns WHERE session_id = ? ORDER BY seq',
    [sessionId],
  );
  const s = get<{ ended_at: string | null }>('SELECT ended_at FROM call_sessions WHERE id = ?', [sessionId]);
  return {
    callId: sessionId,
    complete: !!s?.ended_at,
    count: rows.length,
    segments: rows.map((r) => ({
      callId: sessionId,
      segmentId: `${sessionId}:${r.seq}`,
      sequence: r.seq,
      speaker: r.speaker === 'assistant' ? 'ai' : r.speaker,
      text: r.text,
      timestamp: r.created_at,
      isFinal: true,
      redacted: !!r.sensitive_redacted,
      asrConfidence: r.asr_confidence,
    })),
    note: 'Card numbers and one-time codes are removed before saving. Interim speech results are not stored.',
  };
}

let fault = false;
/** Test hook: makes the next analyses fail so the failure and retry path can be checked. */
export const setAnalysisFaultForTests = (v: boolean) => { fault = v; };

function build(sessionId: string) {
  if (fault) throw new Error('analysis unavailable');
  const s = get<Record<string, any>>('SELECT * FROM call_sessions WHERE id = ?', [sessionId]);
  if (!s) throw new Error('call not found');
  const res = buildResolution(sessionId)!;
  const ctx = parseJson<CallContext>(s.context_json, {} as CallContext);
  const tags = ctx.tags ?? null;
  const turns = all<{ seq: number; speaker: string; text: string }>('SELECT seq, speaker, text FROM conversation_turns WHERE session_id = ? ORDER BY seq', [sessionId]);
  const cust = turns.filter((t) => t.speaker === 'customer');
  const primary: string | null = tags?.intent ?? s.issue_type ?? null;
  const primaryLabel = primary ? ISSUE_LABELS[primary as keyof typeof ISSUE_LABELS] ?? primary : null;
  const secondary = (tags?.secondaryIntents ?? []).map((x: { intent: string; label: string }) => x.label);
  const esc = res.escalation;

  // Resolution follows what systems recorded, never what the assistant said.
  const completed = res.actions.filter((a) => a.bucket === 'completed');
  const open = res.actions.filter((a) => a.bucket !== 'completed');
  let resolution: Resolution;
  if (esc && !['cancelled'].includes(esc.status)) resolution = 'escalated';
  else if (s.resolution_status === 'informational') resolution = 'informational';
  else if (s.outcome === 'resolved' && !open.length) resolution = 'resolved';
  else if (completed.length || (s.outcome === 'resolved' && open.length)) resolution = 'partially_resolved';
  else resolution = 'unresolved';

  const verified = s.verification_status === 'verified';
  const cardTries = all<{ outcome: string }>("SELECT outcome FROM verification_attempts WHERE session_id = ? AND step = 'card'", [sessionId]);
  const failedTries = cardTries.filter((a) => a.outcome !== 'passed').length;
  const identity = verified ? 'Identity was verified by the card-number check.' : failedTries ? `Identity was not verified (${failedTries} failed card-number attempt${failedTries === 1 ? '' : 's'}).` : 'Identity was not verified.';
  const said = s.issue_statement ? `They said: “${redactText(String(s.issue_statement)).slice(0, 200)}”.` : cust.length ? '' : 'The customer did not say anything that could be recorded.';

  // A request for a person that was cancelled because the caller hung up first is still part of the story.
  const droppedHandoff = !esc && !!get("SELECT 1 FROM handoffs WHERE session_id = ? AND status = 'cancelled'", [sessionId]);
  const unresolved = [...res.unresolved, ...(droppedHandoff ? ['The customer asked for a person but ended the call before an agent accepted'] : []), ...(resolution === 'escalated' ? [`Handover to a person (${esc ? HANDOFF_REASON_LABELS[esc.reason] ?? esc.reason : 'requested'})`] : [])];
  const summary = [
    primaryLabel ? `The customer contacted the bank about ${primaryLabel.toLowerCase()}${secondary.length ? `, and also raised ${secondary.join(' and ').toLowerCase()}` : ''}.` : 'The customer did not state a clear banking issue.',
    said,
    identity,
    res.verifiedFacts.length ? `Systems confirmed: ${res.verifiedFacts.slice(0, 3).join(' ')}` : null,
    completed.length ? `Completed and confirmed: ${completed.map((a) => a.label).join(', ')}.` : 'No account changes were made.',
    open.length ? `Not completed: ${open.map((a) => `${a.label} (${a.statusLabel})`).join('; ')}.` : null,
    esc ? `The call was passed to a person (${HANDOFF_REASON_LABELS[esc.reason] ?? esc.reason}).` : null,
    droppedHandoff ? 'The customer asked for a person but ended the call before an agent accepted.' : null,
    `Resolution: ${resolution.replace('_', ' ')}.`,
  ].filter(Boolean).join(' ');

  const kb = kbReferencesFor(sessionId);
  const suggested = [
    esc ? res.brief.recommendedNextStep : null,
    !verified && resolution !== 'informational' ? 'Verify the customer another way before discussing or changing the account.' : null,
    ...open.map((a) => `Follow up: ${a.label} is ${a.statusLabel.toLowerCase()}.`),
    ...(!esc && resolution === 'resolved' ? ['No follow-up needed.'] : []),
    ...kb.slice(0, 2).map((k) => `Guidance “${k.title}” applies.`),
  ].filter(Boolean) as string[];

  // Evidence lines point at the customer's own words by sequence number, so a reader can check them.
  const evidence = cust.slice(0, 3).map((t) => ({ sequence: t.seq, text: redactText(t.text).slice(0, 160) }));

  return {
    summary,
    reasonPrimary: primary,
    reasonLabel: primaryLabel ?? 'Other or unknown',
    reasonConfidence: ctx.issue?.confidence ?? null,
    secondary,
    resolution,
    unresolved,
    suggested,
    kb: kb.map((k) => ({ title: k.title, reason: k.reason })),
    tags: [primaryLabel ?? 'Other or unknown', ...secondary, tags ? `Identity: ${tags.identity}` : null, tags ? `Urgency: ${tags.urgency}` : null, tags ? `Sentiment: ${tags.sentiment}` : null, esc ? HANDOFF_REASON_LABELS[esc.reason] ?? esc.reason : null].filter(Boolean),
    evidence,
    turns: turns.length,
  };
}

/** Start (or restart) the analysis for a call. Never throws: a failure is stored and can be retried. */
export function analyseCall(sessionId: string, actor: Actor | null = null): AnalysisStatus {
  const now = nowIso();
  run(
    `INSERT INTO call_analysis (session_id, status, attempts, updated_at) VALUES (?, 'pending', 1, ?)
     ON CONFLICT(session_id) DO UPDATE SET status = 'pending', attempts = attempts + 1, error = NULL, updated_at = excluded.updated_at`,
    [sessionId, now],
  );
  try {
    const a = build(sessionId);
    run(
      `UPDATE call_analysis SET status = 'ready', summary = ?, reason_primary = ?, reason_label = ?, reason_confidence = ?, reason_secondary_json = ?, resolution = ?,
         unresolved_json = ?, suggested_json = ?, kb_json = ?, tags_json = ?, evidence_json = ?, transcript_turns = ?, generated_at = ?, updated_at = ? WHERE session_id = ?`,
      [a.summary, a.reasonPrimary, a.reasonLabel, a.reasonConfidence, JSON.stringify(a.secondary), a.resolution, JSON.stringify(a.unresolved), JSON.stringify(a.suggested), JSON.stringify(a.kb), JSON.stringify(a.tags), JSON.stringify(a.evidence), a.turns, nowIso(), nowIso(), sessionId],
    );
    run('UPDATE call_sessions SET call_reason_summary = COALESCE(call_reason_summary, ?) WHERE id = ?', [a.reasonLabel, sessionId]);
    audit({ actor: actor ?? { type: 'system', id: 'analysis' }, event: 'call.analysis_ready', status: 'ok', resourceType: 'session', resourceId: sessionId, sessionId });
    return 'ready';
  } catch (e) {
    try { run("UPDATE call_analysis SET status = 'failed', error = ?, updated_at = ? WHERE session_id = ?", [(e as Error).message.slice(0, 300), nowIso(), sessionId]); } catch { /* the call record is already saved */ }
    audit({ actor: actor ?? { type: 'system', id: 'analysis' }, event: 'call.analysis_failed', status: 'failed', resourceType: 'session', resourceId: sessionId, sessionId });
    return 'failed';
  }
}

export function getAnalysis(sessionId: string) {
  const r = get<Record<string, any>>('SELECT * FROM call_analysis WHERE session_id = ?', [sessionId]);
  const state = lifecycle(sessionId);
  if (!r) return { sessionId, lifecycle: state, status: 'not_started' as const };
  return {
    sessionId,
    lifecycle: state,
    status: r.status as AnalysisStatus,
    attempts: r.attempts,
    error: r.error,
    summary: r.summary,
    reason: r.reason_label ? { primary: r.reason_primary, label: r.reason_label, confidence: r.reason_confidence, secondary: parseJson<string[]>(r.reason_secondary_json, []) } : null,
    resolution: r.resolution as Resolution | null,
    unresolved: parseJson<string[]>(r.unresolved_json, []),
    suggestedSolutions: parseJson<string[]>(r.suggested_json, []),
    knowledge: parseJson<{ title: string; reason: string }[]>(r.kb_json, []),
    tags: parseJson<string[]>(r.tags_json, []),
    evidence: parseJson<{ sequence: number; text: string }[]>(r.evidence_json, []),
    transcriptTurns: r.transcript_turns,
    generatedAt: r.generated_at,
  };
}

/** Recently ended calls with their analysis status, for the agent workspace. */
export function listCompleted(limit = 15) {
  return all<{ id: string; ended_at: string; outcome: string | null; full_name: string | null; status: string | null; reason_label: string | null; resolution: string | null }>(
    `SELECT s.id, s.ended_at, s.outcome, b.full_name, a.status, a.reason_label, a.resolution
       FROM call_sessions s LEFT JOIN bank_customers b ON b.id = s.customer_id LEFT JOIN call_analysis a ON a.session_id = s.id
      WHERE s.ended_at IS NOT NULL AND s.data_origin = 'demo_session' ORDER BY s.ended_at DESC LIMIT ?`,
    [limit],
  ).map((r) => ({ sessionId: r.id, endedAt: r.ended_at, outcome: r.outcome, customerName: r.full_name, analysisStatus: r.status ?? 'not_started', reason: r.reason_label, resolution: r.resolution }));
}
