/**
 * WARM HANDOFF (FR-11, BRD §6.5). SIMULATED telephony: a handoff is "queued" when the mock
 * agent desk accepts the transfer request and becomes "connected" ONLY when a demo agent
 * accepts it in the agent console. Nothing is described to the caller as transferred until
 * that confirmation exists. If no agents are available the configured safe fallback
 * (callback request on the case) is used.
 */
import { all, get, parseJson, run, tx } from '../db/db.ts';
import { nowIso, nowMs } from '../lib/clock.ts';
import { newId } from '../lib/ids.ts';
import { AppError } from '../lib/errors.ts';
import { redactText, minimiseName } from '../lib/redact.ts';
import { audit, type Actor } from '../audit/audit.ts';
import type { TelephonyAdapter, TransferResult } from '../voice/interfaces.ts';
import { caseEvent, regenerateSummary, updateCase } from '../cases/case-service.ts';
import { ISSUE_LABELS, HANDOFF_REASON_LABELS, OP_STATUS_LABELS, ACTION_LABELS, formatMoney, formatDate } from '../conversation/format.ts';
import { loadSnapshot, sourceData } from '../retrieval/retrieval.ts';
import { currentSnapshotId } from '../actions/action-service.ts';
import { emitTimeline } from '../events/timeline.ts';
import { kbReferencesFor } from '../kb/kb.ts';

export type HandoffReason = keyof typeof HANDOFF_REASON_LABELS;

/** Mock agent desk. Availability is a demo setting (app_settings.agents_available). */
export const mockTelephony: TelephonyAdapter = {
  provider: 'mock-agent-desk (SIMULATED)',
  async requestTransfer(): Promise<TransferResult> {
    const avail = get<{ value: string }>("SELECT value FROM app_settings WHERE key = 'agents_available'")?.value ?? 'true';
    if (avail !== 'true') return { status: 'no_agent' };
    const q = get<{ n: number }>("SELECT COUNT(*) n FROM handoffs WHERE status = 'queued'")?.n ?? 0;
    return { status: 'queued', queuePosition: q + 1 };
  },
  async hangup() {},
};

export interface HandoffBrief {
  caseId: string | null;
  sessionId: string;
  generatedAt: string;
  reason: string;
  reasonLabel: string;
  reasonDetail: string | null;
  priority: 'normal' | 'urgent';
  customer: { reference: string | null; name: string | null; verification: string; verificationLevel: string | null };
  issue: { type: string | null; label: string; customerStatement: string | null; extracted: Record<string, unknown> };
  transactions: { id: string; merchant: string | null; amount: string; date: string; status: string; cardLast4: string | null }[];
  systemsChecked: { source: string; status: string; latencyMs: number; asOf: string | null; stale: boolean }[];
  conflicts: string[];
  findings: { confirmed: string[]; inferred: string[]; unavailable: string[] };
  actions: { id: string; type: string; label: string; status: string; statusLabel: string; externalRef: string | null; errorCode: string | null }[];
  missingInformation: string[];
  riskFlags: string[];
  previousCases: string[];
  recommendedNextStep: string;
  transcriptExcerpt: { speaker: string; text: string }[];
  knowledge: { id: string; title: string; excerpt: string; reason: string; agentReview: boolean }[];
}

export function buildBrief(sessionId: string, reason: string, reasonDetail: string | null, extras: { missing?: string[]; recommended?: string; priority?: 'normal' | 'urgent' } = {}): HandoffBrief {
  const s = get<Record<string, unknown>>('SELECT * FROM call_sessions WHERE id = ?', [sessionId])!;
  const c = get<Record<string, unknown>>('SELECT * FROM cases WHERE session_id = ?', [sessionId]);
  const verified = s.verification_status === 'verified';
  const cust = verified && s.customer_id ? get<{ full_name: string }>('SELECT full_name FROM bank_customers WHERE id = ?', [s.customer_id]) : null;
  const snapId = verified ? currentSnapshotId(sessionId) : null;
  const snap = snapId ? loadSnapshot(snapId) : null;
  const ctx = parseJson<Record<string, any>>(s.context_json, {});
  const txRefs: string[] = c ? parseJson(c.transaction_refs_json, []) : [];
  const txns = snap ? sourceData(snap, 'transactions') ?? [] : [];
  const cards = snap ? sourceData(snap, 'card_status') ?? [] : [];
  const events = c ? all<{ event_type: string; detail_json: string }>('SELECT event_type, detail_json FROM case_events WHERE case_id = ? ORDER BY id', [c.id]) : [];
  const facts = (k: string) => [...new Set(events.filter((e) => e.event_type === `fact_${k}`).map((e) => parseJson<{ text: string }>(e.detail_json, { text: '' }).text))];
  const ops = all<{ id: string; action_type: string; status: string; external_ref: string | null; error_code: string | null }>(
    'SELECT id, action_type, status, external_ref, error_code FROM action_operations WHERE session_id = ? ORDER BY requested_at',
    [sessionId],
  );
  const turns = all<{ speaker: string; text: string }>('SELECT speaker, text FROM conversation_turns WHERE session_id = ? ORDER BY seq DESC LIMIT 8', [sessionId]).reverse();
  const risk = c ? parseJson<string[]>(c.risk_flags_json, []) : [];
  const unknownOps = ops.filter((o) => o.status === 'unknown');
  const failedBlock = ops.find((o) => o.action_type === 'block_card' && (o.status === 'failed' || o.status === 'unknown'));
  const recommended =
    extras.recommended ??
    (failedBlock
      ? 'URGENT: card block not confirmed — block the card manually and confirm with the customer.'
      : unknownOps.length
        ? 'Reconcile operations with unknown outcome before taking any further action.'
        : !verified
          ? 'Verify the caller using the standard agent process before discussing the account.'
          : reason === 'conflicting_data'
            ? 'Resolve the conflicting system records before any card or dispute action.'
            : 'Review the facts below and continue from where the assistant stopped; the customer should not need to repeat the issue.');
  return {
    caseId: (c?.id as string) ?? null,
    sessionId,
    generatedAt: nowIso(),
    reason,
    reasonLabel: HANDOFF_REASON_LABELS[reason] ?? reason,
    reasonDetail,
    priority: extras.priority ?? (failedBlock || risk.includes('lost_stolen') ? 'urgent' : 'normal'),
    customer: {
      reference: verified ? (s.customer_id as string) : null,
      name: cust ? minimiseName(cust.full_name) : null,
      verification: String(s.verification_status),
      verificationLevel: (s.verification_level as string) ?? null,
    },
    issue: {
      type: (s.issue_type as string) ?? null,
      label: ISSUE_LABELS[String(s.issue_type)] ?? 'Not yet identified',
      customerStatement: (s.issue_statement as string) ?? null,
      extracted: verified ? (ctx.issue?.slots ?? {}) : {},
    },
    // Transaction details only for a verified caller.
    transactions: verified
      ? txRefs
          .map((id) => txns.find((t) => t.transactionId === id))
          .filter(Boolean)
          .map((t) => ({ id: t!.transactionId, merchant: t!.merchant, amount: formatMoney(t!.amountMinor, t!.currency), date: formatDate(t!.transactedAt), status: t!.status, cardLast4: cards.find((k) => k.cardRef === t!.cardRef)?.last4 ?? null }))
      : [],
    systemsChecked: snap ? Object.values(snap.sources).map((r) => ({ source: r!.source, status: r!.status, latencyMs: r!.latencyMs, asOf: r!.asOf, stale: r!.stale })) : [],
    conflicts: snap ? snap.conflicts.map((x) => x.detail) : [],
    findings: { confirmed: facts('confirmed'), inferred: facts('inferred'), unavailable: facts('unavailable') },
    actions: ops.map((o) => ({ id: o.id, type: o.action_type, label: ACTION_LABELS[o.action_type], status: o.status, statusLabel: OP_STATUS_LABELS[o.status], externalRef: o.external_ref, errorCode: o.error_code })),
    missingInformation: extras.missing ?? [],
    riskFlags: risk,
    previousCases: c ? parseJson(c.previous_case_ids_json, []) : [],
    recommendedNextStep: recommended,
    transcriptExcerpt: turns.map((t) => ({ speaker: t.speaker, text: redactText(t.text) })),
    knowledge: kbReferencesFor(sessionId).map((k) => ({ id: k.id, title: k.title, excerpt: k.excerpt, reason: k.reason, agentReview: k.agentReview })),
  };
}

export interface HandoffOutcome {
  handoffId: string;
  status: 'queued' | 'no_agent' | 'failed';
  queuePosition?: number;
}

export async function requestHandoff(input: {
  sessionId: string;
  caseId: string | null;
  reason: HandoffReason | string;
  reasonDetail?: string | null;
  actor: Actor;
  correlationId: string;
  missing?: string[];
  priority?: 'normal' | 'urgent';
  telephony?: TelephonyAdapter;
}): Promise<HandoffOutcome> {
  const existing = get<{ id: string; status: string }>("SELECT id, status FROM handoffs WHERE session_id = ? AND status IN ('requested','queued','connected')", [input.sessionId]);
  if (existing) return { handoffId: existing.id, status: existing.status === 'requested' ? 'failed' : 'queued' };
  const brief = buildBrief(input.sessionId, input.reason, input.reasonDetail ?? null, { missing: input.missing, priority: input.priority });
  const id = newId('HND');
  const ts = nowIso();
  tx(() => {
    run(
      `INSERT INTO handoffs (id, session_id, case_id, reason, reason_detail, brief_json, status, requested_at, updated_at) VALUES (?,?,?,?,?,?, 'requested', ?, ?)`,
      [id, input.sessionId, input.caseId, input.reason, input.reasonDetail ?? null, JSON.stringify(brief), ts, ts],
    );
    run('UPDATE call_sessions SET handoff_requested_at = COALESCE(handoff_requested_at, ?), handoff_reason = COALESCE(handoff_reason, ?), updated_at = ? WHERE id = ?', [ts, input.reason, ts, input.sessionId]);
  });
  audit({ actor: input.actor, event: 'handoff.requested', status: 'ok', resourceType: 'handoff', resourceId: id, sessionId: input.sessionId, correlationId: input.correlationId, metadata: { reason: input.reason } });

  let result: TransferResult;
  try {
    result = await (input.telephony ?? mockTelephony).requestTransfer(id, brief.priority);
  } catch (e) {
    result = { status: 'failed', reason: (e as Error).message };
  }
  if (result.status === 'queued') {
    run("UPDATE handoffs SET status = 'queued', updated_at = ? WHERE id = ?", [nowIso(), id]);
    run('INSERT INTO hold_intervals (session_id, reason, started_at) VALUES (?,?,?)', [input.sessionId, 'agent_queue', nowIso()]);
  } else {
    // Safe fallback: no live agent → callback request recorded on the case. Never claim a transfer.
    run("UPDATE handoffs SET status = ?, fallback = 'callback_requested', updated_at = ? WHERE id = ?", [result.status, nowIso(), id]);
  }
  if (input.caseId) {
    updateCase(input.caseId, {
      status: 'awaiting_agent',
      handoff_notes: `${brief.reasonLabel}${input.reasonDetail ? ` — ${input.reasonDetail}` : ''}. ${brief.recommendedNextStep}`,
      ...(result.status !== 'queued' ? { next_steps: 'No agent was available: callback requested. Card services team to call the customer back.' } : {}),
    });
    caseEvent(input.caseId, 'handoff_requested', { handoffId: id, reason: input.reason, transferStatus: result.status });
    regenerateSummary(input.caseId);
  }
  audit({ actor: input.actor, event: 'handoff.transfer_result', status: result.status === 'queued' ? 'ok' : 'failed', resourceType: 'handoff', resourceId: id, sessionId: input.sessionId, correlationId: input.correlationId, metadata: { result: result.status } });
  return { handoffId: id, status: result.status, queuePosition: result.status === 'queued' ? result.queuePosition : undefined };
}

function closeHold(sessionId: string): void {
  run('UPDATE hold_intervals SET ended_at = ? WHERE session_id = ? AND ended_at IS NULL', [nowIso(), sessionId]);
}

export function acceptHandoff(handoffId: string, agent: Actor & { id: string }): Record<string, unknown> {
  const h = get<{ status: string; session_id: string; case_id: string | null }>('SELECT status, session_id, case_id FROM handoffs WHERE id = ?', [handoffId]);
  if (!h) throw new AppError('NOT_FOUND', 'Handoff not found.');
  const r = run("UPDATE handoffs SET status = 'connected', agent_id = ?, connected_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'", [agent.id, nowIso(), nowIso(), handoffId]);
  if (r.changes !== 1) throw new AppError('CONFLICT', `Handoff is ${h.status}; only queued handoffs can be accepted.`);
  closeHold(h.session_id);
  run('UPDATE call_sessions SET agent_joined_at = COALESCE(agent_joined_at, ?), updated_at = ? WHERE id = ?', [nowIso(), nowIso(), h.session_id]);
  const name = get<{ display_name: string }>('SELECT display_name FROM staff_users WHERE id = ?', [agent.id])?.display_name ?? 'An agent';
  addTurn(h.session_id, 'system', `${name.replace(/ \(demo agent\)$/, '')} (card services agent — simulated) has joined the call and can see your case details.`);
  emitTimeline(h.session_id, { type: 'handoff.connected', stage: 'handoff', title: `Agent joined: ${name}`, detail: 'Warm handoff complete — the agent has the full brief; the customer does not need to repeat the issue.', status: 'ok', source: 'agent desk (simulated)', ref: handoffId });
  if (h.case_id) {
    caseEvent(h.case_id, 'agent_joined', { handoffId, agentId: agent.id });
    regenerateSummary(h.case_id);
  }
  audit({ actor: agent, event: 'handoff.accepted', status: 'ok', resourceType: 'handoff', resourceId: handoffId, sessionId: h.session_id });
  return getHandoff(handoffId)!;
}

export function completeHandoff(handoffId: string, agent: Actor, input: { outcome: 'resolved' | 'unresolved' | 'follow_up_required'; notes: string; customerRepeatedIssue: boolean }): Record<string, unknown> {
  const h = get<{ status: string; session_id: string; case_id: string | null; agent_id: string | null }>('SELECT status, session_id, case_id, agent_id FROM handoffs WHERE id = ?', [handoffId]);
  if (!h) throw new AppError('NOT_FOUND', 'Handoff not found.');
  if (h.status !== 'connected') throw new AppError('CONFLICT', 'Only a connected handoff can be completed.');
  if (h.agent_id !== agent.id) throw new AppError('FORBIDDEN', 'Only the agent who accepted this handoff can complete it.');
  const notes = redactText(input.notes).slice(0, 2000);
  run("UPDATE handoffs SET status = 'completed', completed_at = ?, outcome = ?, agent_notes = ?, customer_repeated_issue = ?, updated_at = ? WHERE id = ?", [
    nowIso(), input.outcome, notes, input.customerRepeatedIssue ? 1 : 0, nowIso(), handoffId,
  ]);
  if (input.customerRepeatedIssue) run('UPDATE call_sessions SET issue_restatements = issue_restatements + 1 WHERE id = ?', [h.session_id]);
  const resolution = input.outcome === 'resolved' ? 'resolved' : 'unresolved';
  run(
    "UPDATE call_sessions SET state = 'ended', outcome = 'handed_off', resolution_status = ?, ended_at = COALESCE(ended_at, ?), updated_at = ? WHERE id = ?",
    [resolution, nowIso(), nowIso(), h.session_id],
  );
  const ctx = parseJson<Record<string, unknown>>(get<{ context_json: string }>('SELECT context_json FROM call_sessions WHERE id = ?', [h.session_id])?.context_json, {});
  ctx.stage = 'ended';
  run('UPDATE call_sessions SET context_json = ? WHERE id = ?', [JSON.stringify(ctx), h.session_id]);
  addTurn(h.session_id, 'system', 'The agent has completed the call. Thank you for calling.');
  emitTimeline(h.session_id, { type: 'handoff.completed', stage: 'handoff', title: `Agent completed the call — ${input.outcome.replace(/_/g, ' ')}`, detail: notes || null, status: input.outcome === 'resolved' ? 'ok' : 'warn', source: 'agent desk (simulated)', ref: handoffId });
  emitTimeline(h.session_id, { type: 'call.closed', stage: 'handoff', title: 'Call closed — handed off', status: input.outcome === 'resolved' ? 'ok' : 'warn', source: 'conversation', ref: h.case_id ?? handoffId });
  if (h.case_id) {
    updateCase(h.case_id, { status: input.outcome === 'resolved' ? 'resolved' : 'pending', resolution_status: resolution, next_steps: input.outcome === 'resolved' ? 'Resolved by agent.' : `Agent follow-up: ${notes}` });
    caseEvent(h.case_id, 'handoff_completed', { handoffId, outcome: input.outcome });
    regenerateSummary(h.case_id);
  }
  audit({ actor: agent, event: 'handoff.completed', status: 'ok', resourceType: 'handoff', resourceId: handoffId, sessionId: h.session_id, metadata: { outcome: input.outcome } });
  return getHandoff(handoffId)!;
}

export function agentMessage(handoffId: string, agent: Actor, text: string): void {
  const h = get<{ status: string; session_id: string; agent_id: string | null }>('SELECT status, session_id, agent_id FROM handoffs WHERE id = ?', [handoffId]);
  if (!h) throw new AppError('NOT_FOUND', 'Handoff not found.');
  if (h.status !== 'connected' || h.agent_id !== agent.id) throw new AppError('FORBIDDEN', 'Only the connected agent can message the caller.');
  addTurn(h.session_id, 'agent', text.slice(0, 1000));
  audit({ actor: agent, event: 'handoff.agent_message', status: 'ok', resourceType: 'handoff', resourceId: handoffId, sessionId: h.session_id });
}

export function addTurn(sessionId: string, speaker: 'customer' | 'assistant' | 'agent' | 'system', text: string, extra: { kind?: string; sensitive?: boolean; clientMessageId?: string | null; asrConfidence?: number | null } = {}): number {
  const seq = (get<{ m: number | null }>('SELECT MAX(seq) m FROM conversation_turns WHERE session_id = ?', [sessionId])?.m ?? 0) + 1;
  const r = run(
    'INSERT INTO conversation_turns (session_id, seq, speaker, kind, text, sensitive_redacted, client_message_id, asr_confidence, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [sessionId, seq, speaker, extra.kind ?? 'utterance', redactText(text), extra.sensitive ? 1 : 0, extra.clientMessageId ?? null, extra.asrConfidence ?? null, nowIso()],
  );
  return r.lastInsertRowid;
}

export function getHandoff(id: string) {
  const h = get<Record<string, unknown> & { session_id: string; case_id: string | null }>('SELECT * FROM handoffs WHERE id = ?', [id]);
  if (!h) return null;
  const waitedS = Math.round(((h.connected_at ? Date.parse(String(h.connected_at)) : nowMs()) - Date.parse(String(h.requested_at))) / 1000);
  return { ...h, brief: parseJson(h.brief_json, {}), brief_json: undefined, waitedSeconds: waitedS };
}

export function listHandoffs(status?: string) {
  const rows = all<Record<string, unknown>>(
    `SELECT h.*, s.verification_status, s.issue_type FROM handoffs h JOIN call_sessions s ON s.id = h.session_id ${status ? 'WHERE h.status = ?' : ''} ORDER BY h.requested_at DESC LIMIT 100`,
    status ? [status] : [],
  );
  return rows.map((h) => {
    const b = parseJson<HandoffBrief>(h.brief_json, {} as HandoffBrief);
    return { id: h.id, sessionId: h.session_id, caseId: h.case_id, status: h.status, reason: h.reason, reasonLabel: HANDOFF_REASON_LABELS[String(h.reason)] ?? h.reason, priority: b.priority, issueLabel: b.issue?.label, verification: h.verification_status, requestedAt: h.requested_at, agentId: h.agent_id, dataOrigin: h.data_origin };
  });
}
