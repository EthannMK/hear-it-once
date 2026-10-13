/**
 * Read models for the API. Caller views reveal protected data only after verification;
 * the demo OTP is shown only to the caller and only in DEMO_MODE.
 */
import { env } from '../config/env.ts';
import { all, get, parseJson } from '../db/db.ts';
import { nowIso } from '../lib/clock.ts';
import { ACTION_LABELS, ISSUE_LABELS, OP_STATUS_LABELS, HANDOFF_REASON_LABELS } from '../conversation/format.ts';
import type { CallContext } from '../conversation/orchestrator.ts';
import { loadSnapshot } from '../retrieval/retrieval.ts';
import { opHistory, opsForSession } from '../actions/action-service.ts';
import { SOURCE_LABELS } from '../workflows/common.ts';

export function buildCallView(sessionId: string, opts: { audience: 'caller' | 'staff' }) {
  const s = get<Record<string, unknown>>('SELECT * FROM call_sessions WHERE id = ?', [sessionId]);
  if (!s) return null;
  const ctx = parseJson<CallContext>(s.context_json, {} as CallContext);
  const verified = s.verification_status === 'verified';
  const turns = all<{ seq: number; speaker: string; kind: string; text: string; created_at: string }>(
    'SELECT seq, speaker, kind, text, created_at FROM conversation_turns WHERE session_id = ? ORDER BY seq',
    [sessionId],
  );
  const c = get<Record<string, unknown>>('SELECT id, status, resolution_status, summary, next_steps, risk_flags_json, recurring_issue, previous_case_ids_json FROM cases WHERE session_id = ?', [sessionId]);
  const h = get<Record<string, unknown>>(
    'SELECT h.id, h.status, h.reason, h.requested_at, h.connected_at, h.fallback, u.display_name agent_name FROM handoffs h LEFT JOIN staff_users u ON u.id = h.agent_id WHERE h.session_id = ? ORDER BY h.requested_at DESC LIMIT 1',
    [sessionId],
  );
  const snap = verified && ctx.snapshotId ? loadSnapshot(ctx.snapshotId) : null;
  const ops = verified ? opsForSession(sessionId) : [];
  let proposal: Record<string, unknown> | null = null;
  if (ctx.pending?.kind === 'consent') {
    const p = get<{ id: string; actions_json: string; rule_refs_json: string; status: string }>('SELECT id, actions_json, rule_refs_json, status FROM proposals WHERE id = ?', [ctx.pending.proposalId]);
    if (p) proposal = { id: p.id, status: p.status, ruleRefs: parseJson(p.rule_refs_json, []), actions: parseJson<{ type: string; label: string; targetRef: string }[]>(p.actions_json, []).map((a) => ({ type: a.type, label: a.label })) };
  }
  const events = c ? all<{ event_type: string; detail_json: string }>("SELECT event_type, detail_json FROM case_events WHERE case_id = ? AND event_type LIKE 'fact_%' ORDER BY id", [c.id]) : [];
  const facts = (k: string) => [...new Set(events.filter((e) => e.event_type === `fact_${k}`).map((e) => parseJson<{ text: string; source: string }>(e.detail_json, { text: '', source: '' })))].filter((v, i, a) => a.findIndex((x) => x.text === v.text) === i);

  let demoDevice: Record<string, unknown> | null = null;
  if (opts.audience === 'caller' && env().DEMO_MODE && ctx.stage === 'awaiting_otp') {
    const otp = get<{ demo_display: string | null; expires_at: string }>(
      'SELECT demo_display, expires_at FROM otp_challenges WHERE session_id = ? AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1',
      [sessionId],
    );
    if (otp?.demo_display && otp.expires_at > nowIso()) demoDevice = { label: 'SIMULATED registered phone — demo only', message: `Your Card Services passcode is ${otp.demo_display}. Never share it with anyone who calls you.`, code: otp.demo_display, expiresAt: otp.expires_at };
  }
  const choices = ctx.pending?.kind === 'choice' ? ctx.pending.options : ctx.pending?.kind === 'yes_no' ? [{ id: '__yes', label: 'Yes' }, { id: '__no', label: 'No' }] : [];

  return {
    simulated: true,
    session: {
      id: s.id,
      stage: ctx.stage,
      scenarioId: s.scenario_id,
      channel: s.channel,
      answeredAt: s.answered_at,
      endedAt: s.ended_at,
      outcome: s.outcome,
      resolutionStatus: s.resolution_status,
      verificationStatus: s.verification_status,
      issueType: s.issue_type,
      issueLabel: s.issue_type ? ISSUE_LABELS[String(s.issue_type)] : null,
      issueStatement: s.issue_statement,
      customerFirstName: verified ? ctx.firstName : null,
      csat: s.csat,
    },
    pending: ctx.pending ? { kind: ctx.pending.kind, purpose: 'purpose' in ctx.pending ? ctx.pending.purpose : null } : null,
    choices,
    proposal,
    canReconcile: ops.some((o) => o.status === 'unknown' || o.status === 'submitted'),
    transcript: turns.map((t) => ({ seq: t.seq, speaker: t.speaker, kind: t.kind, text: t.text, at: t.created_at })),
    sources: snap
      ? {
          snapshotId: snap.id,
          wallMs: snap.wallMs,
          sumSourceMs: snap.sumSourceMs,
          items: Object.values(snap.sources).map((r) => ({ source: r!.source, label: SOURCE_LABELS[r!.source], status: r!.status, stale: r!.stale, latencyMs: r!.latencyMs, attempts: r!.attempts, asOf: r!.asOf, simulated: true })),
          conflicts: snap.conflicts,
        }
      : null,
    findings: verified ? { confirmed: facts('confirmed'), inferred: facts('inferred'), unavailable: facts('unavailable') } : null,
    operations: ops.map((o) => ({
      id: o.id,
      type: o.action_type,
      label: ACTION_LABELS[o.action_type],
      targetRef: o.target_ref,
      status: o.status,
      statusLabel: OP_STATUS_LABELS[o.status],
      externalRef: o.external_ref,
      errorCode: o.error_code,
      errorMessage: o.error_message,
      attempts: o.attempts,
      requestedAt: o.requested_at,
      completedAt: o.completed_at,
      history: opHistory(o.id),
    })),
    case: c
      ? { id: c.id, status: c.status, resolutionStatus: c.resolution_status, summary: verified || opts.audience === 'staff' ? c.summary : null, nextSteps: c.next_steps, riskFlags: parseJson(c.risk_flags_json, []), recurring: !!c.recurring_issue, previousCaseIds: parseJson(c.previous_case_ids_json, []) }
      : null,
    handoff: h ? { id: h.id, status: h.status, reason: h.reason, reasonLabel: HANDOFF_REASON_LABELS[String(h.reason)] ?? h.reason, agentName: h.agent_name ?? null, requestedAt: h.requested_at, connectedAt: h.connected_at, fallback: h.fallback, simulated: true } : null,
    demoDevice,
  };
}

export function listCalls(q: { from?: string; to?: string; issueType?: string; outcome?: string; origin?: string; limit: number; cursor?: string }) {
  const where: string[] = [];
  const p: unknown[] = [];
  if (q.from) (where.push('answered_at >= ?'), p.push(q.from));
  if (q.to) (where.push('answered_at <= ?'), p.push(q.to));
  if (q.issueType) (where.push('issue_type = ?'), p.push(q.issueType));
  if (q.outcome) (where.push('outcome = ?'), p.push(q.outcome));
  if (q.origin) (where.push('data_origin = ?'), p.push(q.origin));
  if (q.cursor) (where.push('answered_at < ?'), p.push(q.cursor));
  const rows = all<Record<string, unknown>>(
    `SELECT s.id, s.answered_at, s.ended_at, s.issue_type, s.outcome, s.resolution_status, s.verification_status, s.handoff_reason, s.data_origin, s.scenario_id, s.qa_flagged,
            (SELECT id FROM cases WHERE session_id = s.id) case_id
     FROM call_sessions s ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY answered_at DESC LIMIT ?`,
    [...p, q.limit + 1],
  );
  const more = rows.length > q.limit;
  const items = rows.slice(0, q.limit);
  return { items, nextCursor: more ? (items[items.length - 1].answered_at as string) : null };
}

export function listCases(q: { status?: string; issueType?: string; limit: number; cursor?: string }) {
  const where: string[] = [];
  const p: unknown[] = [];
  if (q.status) (where.push('c.status = ?'), p.push(q.status));
  if (q.issueType) (where.push('c.issue_type = ?'), p.push(q.issueType));
  if (q.cursor) (where.push('c.created_at < ?'), p.push(q.cursor));
  const rows = all<Record<string, unknown>>(
    `SELECT c.id, c.session_id, c.customer_id, c.issue_type, c.status, c.resolution_status, c.verification_outcome, c.recurring_issue, c.data_origin, c.created_at, c.updated_at
     FROM cases c ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.created_at DESC LIMIT ?`,
    [...p, q.limit + 1],
  );
  const more = rows.length > q.limit;
  const items = rows.slice(0, q.limit);
  return { items, nextCursor: more ? (items[items.length - 1].created_at as string) : null };
}
