/**
 * RESOLUTION / AGENT BRIEF read model. Built only from recorded state (session, case events,
 * proposals, consents, operations, disputes, handoffs, KB references, timeline). It keeps four
 * kinds of statement apart: what the customer said, what systems verified, what the AI
 * interpreted, and what is still unresolved.
 */
import { all, get, parseJson } from '../db/db.ts';
import { buildBrief } from '../handoff/handoff-service.ts';
import { listTimeline } from '../events/timeline.ts';
import { kbReferencesFor } from '../kb/kb.ts';
import { ACTION_LABELS, HANDOFF_REASON_LABELS, ISSUE_LABELS, OP_STATUS_LABELS, formatMoney } from '../conversation/format.ts';
import type { CallContext } from '../conversation/orchestrator.ts';

type Bucket = 'completed' | 'pending' | 'blocked' | 'failed' | 'awaiting_confirmation';
const bucket = (status: string): Bucket =>
  status === 'succeeded' ? 'completed' : status === 'failed' || status === 'unknown' ? 'failed' : status === 'rejected' ? 'blocked' : status === 'awaiting_confirmation' || status === 'validated' || status === 'requested' ? 'awaiting_confirmation' : 'pending';

export function buildResolution(sessionId: string) {
  const s = get<Record<string, unknown>>('SELECT * FROM call_sessions WHERE id = ?', [sessionId]);
  if (!s) return null;
  const ctx = parseJson<CallContext>(s.context_json, {} as CallContext);
  const h = get<{ id: string; reason: string; reason_detail: string | null; status: string; outcome: string | null; agent_notes: string | null }>(
    "SELECT id, reason, reason_detail, status, outcome, agent_notes FROM handoffs WHERE session_id = ? AND status != 'cancelled' ORDER BY requested_at DESC LIMIT 1",
    [sessionId],
  );
  const brief = buildBrief(sessionId, h?.reason ?? 'resolved_by_assistant', h?.reason_detail ?? null);
  const c = get<Record<string, unknown>>('SELECT * FROM cases WHERE session_id = ?', [sessionId]);
  const verified = s.verification_status === 'verified';

  // Actions: proposed → requested (consented) → outcome buckets
  const proposals = all<{ id: string; actions_json: string; status: string; rule_refs_json: string; created_at: string }>('SELECT id, actions_json, status, rule_refs_json, created_at FROM proposals WHERE session_id = ? ORDER BY created_at', [sessionId]);
  const ops = all<{ id: string; idempotency_key: string; action_type: string; status: string; external_ref: string | null; error_code: string | null; error_message: string | null; consent_id: string | null; attempts: number; completed_at: string | null }>(
    'SELECT id, idempotency_key, action_type, status, external_ref, error_code, error_message, consent_id, attempts, completed_at FROM action_operations WHERE session_id = ? ORDER BY requested_at, rowid',
    [sessionId],
  );
  const actions = ops.map((o) => {
    const p = proposals.find((x) => o.idempotency_key.startsWith(`${x.id}:`));
    const label = parseJson<{ type: string; label: string }[]>(p?.actions_json, []).find((a) => a.type === o.action_type)?.label ?? ACTION_LABELS[o.action_type];
    return {
      id: o.id,
      type: o.action_type,
      label,
      proposed: !!p,
      requestedByCustomer: !!o.consent_id || p?.status === 'accepted',
      status: o.status,
      statusLabel: OP_STATUS_LABELS[o.status] ?? o.status,
      bucket: bucket(o.status),
      reference: o.external_ref,
      error: o.error_code ? `${o.error_code}${o.error_message ? ` — ${o.error_message}` : ''}` : null,
      attempts: o.attempts,
      ruleRefs: parseJson<string[]>(p?.rule_refs_json, []),
    };
  });

  const disputes = all<{ id: string; status: string; reason_code: string; rule_code: string | null; merchant: string; amount_minor: number; currency: string; evidence_json: string; external_ref: string | null; downstream_status: string | null }>(
    'SELECT id, status, reason_code, rule_code, merchant, amount_minor, currency, evidence_json, external_ref, downstream_status FROM disputes WHERE session_id = ?',
    [sessionId],
  );
  const evidence = disputes.flatMap((d) => parseJson<{ type: string; description: string }[]>(d.evidence_json, []).map((e) => ({ dispute: d.id, ...e })));

  const slots = (verified || ctx.issue ? ctx.issue?.slots : null) ?? null;
  const customerSaid = [
    ...(s.issue_statement ? [{ text: String(s.issue_statement), kind: 'own words' }] : []),
    ...(slots?.amountMinor != null ? [{ text: `Mentioned an amount of ${formatMoney(slots.amountMinor)}`, kind: 'detail' }] : []),
    ...(slots?.merchantHint ? [{ text: `Mentioned “${slots.merchantHint}”`, kind: 'detail' }] : []),
    ...(slots?.dateRange ? [{ text: `Said it happened ${slots.dateRange.label}`, kind: 'detail' }] : []),
  ];
  const tags = ctx.tags ?? null;
  const interpretations = [
    ...(ctx.issue?.issueType ? [{ text: `Classified as “${ISSUE_LABELS[ctx.issue.issueType]}” (confidence ${Number(ctx.issue.confidence).toFixed(2)}, ${ctx.issue.model})`, basis: 'intent model — not a verified fact' }] : []),
    ...brief.findings.inferred.map((t) => ({ text: t, basis: 'inferred from records, not confirmed by a system' })),
    ...(tags ? [{ text: `Sentiment: ${tags.sentiment} (indicative only — ${tags.sentimentBasis})`, basis: 'keyword rule' }, { text: `Urgency: ${tags.urgency} (${tags.urgencyReason})`, basis: 'explicit demo rule' }] : []),
  ];
  const unresolved = [
    ...brief.findings.unavailable,
    ...brief.conflicts,
    ...actions.filter((a) => a.bucket === 'pending' || a.bucket === 'failed' || a.bucket === 'awaiting_confirmation').map((a) => `${a.label}: ${a.statusLabel}`),
    ...brief.missingInformation.map((m) => `Missing: ${m}`),
  ];

  const outcome = String(s.outcome ?? 'in_progress');
  const escalated = !!h;
  const headline = escalated
    ? h!.status === 'connected' || h!.status === 'completed'
      ? 'Handed to a specialist'
      : h!.status === 'no_agent'
        ? 'Escalated — callback requested'
        : 'Escalation prepared — waiting for an agent'
    : outcome === 'resolved'
      ? 'Resolved by the assistant'
      : s.ended_at
        ? 'Call ended — not fully resolved'
        : c?.status === 'resolved'
          ? 'Resolved — call still open'
          : 'In progress';
  const nextStep = escalated ? brief.recommendedNextStep : c?.next_steps ? String(c.next_steps) : s.ended_at ? 'No follow-up recorded.' : 'The call is still in progress.';

  const copyText = [
    `HEAR IT ONCE — ${headline.toUpperCase()} (SIMULATED DEMO, SYNTHETIC DATA)`,
    `Case: ${brief.caseId ?? '—'} · Call: ${sessionId} · Issue: ${brief.issue.label} · Priority: ${brief.priority}`,
    `Identity: ${brief.customer.verification}${brief.customer.name ? ` (${brief.customer.name})` : ''}`,
    escalated ? `Escalation reason: ${HANDOFF_REASON_LABELS[h!.reason] ?? h!.reason}${h!.reason_detail ? ` — ${h!.reason_detail}` : ''}` : null,
    '',
    'CUSTOMER SAID',
    ...customerSaid.map((x) => `- ${x.text}`),
    '',
    'VERIFIED BY SYSTEMS',
    ...(brief.findings.confirmed.length ? brief.findings.confirmed.map((t) => `- ${t}`) : ['- Nothing verified']),
    '',
    'ACTIONS',
    ...(actions.length ? actions.map((a) => `- ${a.label}: ${a.statusLabel}${a.reference ? ` (ref ${a.reference})` : ''}${a.error ? ` — ${a.error}` : ''}`) : ['- None']),
    '',
    'UNRESOLVED',
    ...(unresolved.length ? unresolved.map((u) => `- ${u}`) : ['- Nothing outstanding']),
    '',
    `NEXT STEP: ${brief.recommendedNextStep}`,
  ]
    .filter((x) => x !== null)
    .join('\n');

  return {
    simulated: true,
    sessionId,
    headline,
    nextStep,
    outcome,
    resolutionStatus: s.resolution_status ?? null,
    endedAt: s.ended_at ?? null,
    escalation: h ? { id: h.id, reason: h.reason, reasonLabel: HANDOFF_REASON_LABELS[h.reason] ?? h.reason, detail: h.reason_detail, status: h.status, agentOutcome: h.outcome, agentNotes: h.agent_notes } : null,
    brief,
    case: c ? { id: c.id, status: c.status, resolutionStatus: c.resolution_status, summary: c.summary, nextSteps: c.next_steps, riskFlags: parseJson(c.risk_flags_json, []) } : null,
    customerSaid,
    verifiedFacts: brief.findings.confirmed,
    interpretations,
    unresolved,
    actions,
    evidence,
    disputes: disputes.map((d) => ({ id: d.id, status: d.status, rule: d.rule_code, merchant: d.merchant, amount: formatMoney(d.amount_minor, d.currency), reference: d.external_ref, downstream: d.downstream_status })),
    knowledge: kbReferencesFor(sessionId),
    tags,
    timeline: listTimeline(sessionId),
    copyText,
  };
}
