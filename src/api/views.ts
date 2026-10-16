/**
 * Read models for the API. Caller views reveal protected data only after verification;
 * the demo OTP is shown only to the caller and only in DEMO_MODE.
 */
import { env } from '../config/env.ts';
import { readCheck } from '../verification/agent-check.ts';
import { all, get, parseJson } from '../db/db.ts';
import { nowIso } from '../lib/clock.ts';
import { ACTION_LABELS, ISSUE_LABELS, OP_STATUS_LABELS, HANDOFF_REASON_LABELS } from '../conversation/format.ts';
import { cardCaptureFor, type CallContext } from '../conversation/orchestrator.ts';
import { loadSnapshot } from '../retrieval/retrieval.ts';
import { opHistory, opsForSession } from '../actions/action-service.ts';
import { SOURCE_LABELS } from '../workflows/common.ts';
import { policy } from '../config/policy.ts';
import { computeTags } from '../conversation/tags.ts';
import { kbReferencesFor } from '../kb/kb.ts';
import { scenarioById } from '../db/scenarios.ts';

export const STAGES = ['understand', 'verify', 'investigate', 'explain', 'confirm', 'act', 'record', 'resolve', 'handoff'] as const;

/** Where the call is in Understand → Verify → Investigate → Explain → Confirm → Act → Record → Resolve/Handoff. */
function currentStage(ctx: CallContext, ops: { status: string }[], ended: boolean, handedOff: boolean): (typeof STAGES)[number] {
  if (handedOff || ctx.stage === 'handoff' || ctx.stage === 'fallback') return 'handoff';
  if (ended || ctx.stage === 'wrap_up' || ctx.stage === 'awaiting_survey' || ctx.stage === 'ended') return 'resolve';
  if (ctx.stage === 'awaiting_issue' || ctx.stage === 'clarifying_issue') return 'understand';
  if (ctx.stage === 'identifying' || ctx.stage === 'awaiting_dob' || ctx.stage === 'awaiting_otp' || ctx.stage === 'awaiting_card' || ctx.stage === 'stepup') return 'verify';
  if (ops.some((o) => o.status === 'submitted' || o.status === 'unknown')) return 'act';
  if (ctx.pending?.kind === 'consent') return 'confirm';
  return 'explain';
}

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
  const agentCheck = readCheck(sessionId);
  const awaitingAgentCode = agentCheck?.status === 'awaiting';
  if (opts.audience === 'caller' && env().DEMO_MODE && (ctx.stage === 'awaiting_otp' || awaitingAgentCode)) {
    // The challenge this screen is actually waiting on. Two passcodes issued in the same second
    // sort equally by time, so an agent's new code could otherwise be shown as the old one.
    const otp = awaitingAgentCode
      ? get<{ demo_display: string | null; expires_at: string }>('SELECT demo_display, expires_at FROM otp_challenges WHERE id = ? AND consumed_at IS NULL', [agentCheck!.challengeId])
      : get<{ demo_display: string | null; expires_at: string }>(
          'SELECT demo_display, expires_at FROM otp_challenges WHERE session_id = ? AND consumed_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1',
          [sessionId],
        );
    if (otp?.demo_display && otp.expires_at > nowIso()) demoDevice = { label: 'SIMULATED registered phone — demo only', message: `Your Northstar Bank passcode is ${otp.demo_display}. Never share it with anyone who calls you.`, code: otp.demo_display, expiresAt: otp.expires_at };
  }
  // Private entry: the screen offers a box that types straight to the back end, never into the transcript.
  const secureEntry = awaitingAgentCode ? { kind: 'agent_otp', label: 'Passcode from the agent', hint: '6 digits', maxLength: 8 } : ctx.stage === 'awaiting_card' ? { kind: 'card', label: 'Card number', hint: '16 digits', maxLength: 24 } : ctx.stage === 'stepup' ? { kind: 'nrc', label: 'NRC last 4 digits', hint: '4 digits', maxLength: 20 } : null;
  const choices = ctx.pending?.kind === 'choice' ? ctx.pending.options : ctx.pending?.kind === 'yes_no' ? [{ id: '__yes', label: 'Yes' }, { id: '__no', label: 'No' }] : [];

  const handedOff = !!h && h.status !== 'cancelled';
  const visited = all<{ stage: string }>('SELECT DISTINCT stage FROM timeline_events WHERE session_id = ?', [sessionId]).map((r) => r.stage);
  const stageNow = currentStage(ctx, ops, !!s.ended_at, handedOff);
  const sc = ctx.persona ? scenarioById(ctx.persona.scenarioId) : null;
  const pol = policy();
  return {
    simulated: true,
    workflow: { stage: stageNow, visited: [...new Set([...visited, stageNow])], stages: STAGES },
    tags: computeTags(sessionId, { issue: ctx.issue, sentiment: ctx.sentiment, flags: ctx.flags, secondary: ctx.secondary?.map((x) => x.issueType) }),
    persona:
      ctx.persona && sc
        ? { scenarioId: ctx.persona.scenarioId, name: ctx.persona.name, customerNumber: ctx.persona.customerNumber, phoneMasked: ctx.persona.phoneMasked, // Synthetic DOB is a demo helper: caller only, demo mode only, and only until verified.
          dob: opts.audience === 'caller' && env().DEMO_MODE && !verified && s.verification_status !== 'failed' ? sc.customer.dob : null, synthetic: true }
        : null,
    freeMode: !!ctx.freeMode,
    knowledge: kbReferencesFor(sessionId),
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
      governance: pol.actions[o.action_type].requiresHumanApproval ? 'human_approval' : pol.actions[o.action_type].requiresConsent ? 'customer_confirmation' : 'automatic',
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
    handoff: h ? { id: h.id, status: h.status, reason: h.reason, reasonLabel: HANDOFF_REASON_LABELS[String(h.reason)] ?? h.reason, agentName: h.agent_name ?? null, requestedAt: h.requested_at, connectedAt: h.connected_at, fallback: h.fallback, reference: ctx.escalationRef ?? null, simulated: true } : null,
    agentCheck: agentCheck ? { status: agentCheck.status, deliveredTo: agentCheck.deliveredTo, requestedByName: agentCheck.requestedByName, attempts: agentCheck.attempts } : null,
    demoDevice,
    secureEntry,
    // What the caller's own words were heard as, so they can see whether the number was captured correctly. Caller view only; never stored.
    cardCapture: opts.audience === 'caller' ? cardCaptureFor(sessionId) : null,
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

/**
 * Live operations overview (demo calls only): where active calls are in the procedure, how
 * actions ended, issue mix, and the most recent interactions for drill-down. Built from
 * recorded sessions, operations and timeline events — never from estimates.
 */
export function opsOverview(hours = 24) {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const sessions = all<{ id: string; context_json: string; ended_at: string | null; outcome: string | null; issue_type: string | null; answered_at: string; scenario_id: string | null; verification_status: string }>(
    "SELECT id, context_json, ended_at, outcome, issue_type, answered_at, scenario_id, verification_status FROM call_sessions WHERE data_origin = 'demo_session' AND answered_at >= ? ORDER BY answered_at DESC LIMIT 200",
    [since],
  );
  const stageCounts: Record<string, number> = Object.fromEntries(STAGES.map((s) => [s, 0]));
  const issues: Record<string, number> = {};
  const recent: Record<string, unknown>[] = [];
  let active = 0;
  let completed = 0;
  let handedOff = 0;
  for (const s of sessions) {
    const ctx = parseJson<CallContext>(s.context_json, {} as CallContext);
    const ops = all<{ status: string }>('SELECT status FROM action_operations WHERE session_id = ?', [s.id]);
    const h = get<{ status: string; reason: string }>('SELECT status, reason FROM handoffs WHERE session_id = ? ORDER BY requested_at DESC LIMIT 1', [s.id]);
    const ho = !!h && h.status !== 'cancelled';
    const stage = currentStage(ctx, ops, !!s.ended_at, ho);
    if (!s.ended_at) {
      active++;
      stageCounts[stage]++;
    } else completed++;
    if (ho) handedOff++;
    if (s.issue_type) issues[s.issue_type] = (issues[s.issue_type] ?? 0) + 1;
    if (recent.length < 12) {
      const last = get<{ title: string; created_at: string; status: string }>('SELECT title, created_at, status FROM timeline_events WHERE session_id = ? ORDER BY id DESC LIMIT 1', [s.id]);
      const n = get<{ n: number }>('SELECT COUNT(*) n FROM timeline_events WHERE session_id = ?', [s.id])?.n ?? 0;
      recent.push({ id: s.id, scenarioId: s.scenario_id, answeredAt: s.answered_at, endedAt: s.ended_at, active: !s.ended_at, stage, outcome: s.outcome, issueType: s.issue_type, issueLabel: s.issue_type ? ISSUE_LABELS[s.issue_type] : null, verification: s.verification_status, handoff: h ? { status: h.status, reason: h.reason, reasonLabel: HANDOFF_REASON_LABELS[h.reason] ?? h.reason } : null, lastEvent: last ? { title: last.title, at: last.created_at, status: last.status } : null, events: n });
    }
  }
  const actionRows = all<{ action_type: string; status: string; n: number }>(
    "SELECT action_type, status, COUNT(*) n FROM action_operations WHERE data_origin = 'demo_session' AND requested_at >= ? GROUP BY action_type, status",
    [since],
  );
  const actionOutcomes: Record<string, number> = {};
  for (const r of actionRows) actionOutcomes[r.status] = (actionOutcomes[r.status] ?? 0) + r.n;
  return {
    label: `Demo calls only · last ${hours} hours · synthetic data`,
    totals: { sessions: sessions.length, active, completed, handedOff },
    stageDistribution: STAGES.map((s) => ({ stage: s, active: stageCounts[s] })),
    actionOutcomes: Object.entries(actionOutcomes).map(([status, count]) => ({ status, label: OP_STATUS_LABELS[status as keyof typeof OP_STATUS_LABELS] ?? status, count })),
    actionsByType: actionRows.map((r) => ({ type: r.action_type, label: ACTION_LABELS[r.action_type as keyof typeof ACTION_LABELS] ?? r.action_type, status: r.status, count: r.n })),
    categories: Object.entries(issues).map(([issue, count]) => ({ issue, label: ISSUE_LABELS[issue] ?? issue, count })).sort((a, b) => b.count - a.count),
    recent,
  };
}
