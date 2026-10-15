/**
 * AGENT WORKSPACE read model and edits.
 *
 * Everything the agent sees is assembled from persisted call state (transcript, verification
 * attempts, timeline events, operations, knowledge references, case). The suggested solution is
 * labelled an AI RECOMMENDATION and kept apart from confirmed actions. Agent edits (tags, reason
 * summary, suggestion, notes, resolution) are validated, saved and audited. The demo card number
 * is shown to the agent (synthetic data) but is never placed in CRM queries, audit metadata or logs.
 */
import { z } from 'zod';
import { all, get, parseJson, run } from '../db/db.ts';
import { AppError } from '../lib/errors.ts';
import { nowIso, nowMs } from '../lib/clock.ts';
import { redactText } from '../lib/redact.ts';
import { audit, type Actor } from '../audit/audit.ts';
import { emitTimeline, listTimeline } from '../events/timeline.ts';
import { kbReferencesFor } from '../kb/kb.ts';
import { getContext } from '../conversation/orchestrator.ts';
import { HANDOFF_REASON_LABELS, ISSUE_LABELS } from '../conversation/format.ts';
import { buildResolution } from '../api/brief.ts';
import { SCENARIOS } from '../db/scenarios.ts';
import { BANK_NAME } from '../live/profiles.ts';

const PHASE: Record<string, 'waiting' | 'accepted' | 'completed' | 'no_agent' | 'cancelled'> = {
  requested: 'waiting', queued: 'waiting', connected: 'accepted', completed: 'completed', no_agent: 'no_agent', failed: 'no_agent', cancelled: 'cancelled',
};

interface HandoffRow { id: string; session_id: string; status: string; reason: string; reason_detail: string | null; agent_id: string | null; requested_at: string; connected_at: string | null; completed_at: string | null; outcome: string | null; agent_notes: string | null }
interface SessionRow {
  id: string; channel: string; scenario_id: string | null; profile_id: string | null; answered_at: string; ended_at: string | null; issue_type: string | null; issue_statement: string | null;
  verification_status: string; agent_tags_json: string | null; call_reason_summary: string | null; suggestion_override: string | null; resolution_text: string | null;
  next_steps_text: string | null; agent_notes_text: string | null; agent_edited_at: string | null;
}

const looksLikeCardNumber = (q: string): boolean => /\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,4}\b/.test(q) || /(?<!\d)\d{13,19}(?!\d)/.test(q);

/* ------------------------------------------------------------------------------ read model */

export function buildWorkspace(handoffId: string) {
  const h = get<HandoffRow>('SELECT id, session_id, status, reason, reason_detail, agent_id, requested_at, connected_at, completed_at, outcome, agent_notes FROM handoffs WHERE id = ?', [handoffId]);
  if (!h) return null;
  return assemble(h.session_id, h);
}

/**
 * The agent's view of ANY call — with or without a handover — so a judge can see, right after
 * the call, exactly what a human agent would see. Uses the latest handover when there is one.
 */
export function buildSessionWorkspace(sessionId: string) {
  if (!get('SELECT 1 FROM call_sessions WHERE id = ?', [sessionId])) return null;
  const h = get<HandoffRow>('SELECT id, session_id, status, reason, reason_detail, agent_id, requested_at, connected_at, completed_at, outcome, agent_notes FROM handoffs WHERE session_id = ? ORDER BY requested_at DESC LIMIT 1', [sessionId]) ?? null;
  return assemble(sessionId, h);
}

function assemble(sessionId: string, h: HandoffRow | null) {
  const s = get<SessionRow>('SELECT * FROM call_sessions WHERE id = ?', [sessionId])!;
  const ctx = getContext(sessionId);
  const res = buildResolution(sessionId)!;
  const tags = ctx?.tags;

  // Active customer: identified from caller ID at the start of the call (identification only).
  const customerId = ctx?.verification?.identifiedCustomerId ?? null;
  const cu = customerId ? get<{ id: string; customer_number: string; full_name: string; account_standing: string }>('SELECT id, customer_number, full_name, account_standing FROM bank_customers WHERE id = ?', [customerId]) : undefined;
  const card = customerId ? get<{ last4: string; demo_pan: string | null; status: string; network: string }>('SELECT last4, demo_pan, status, network FROM bank_cards WHERE customer_id = ? ORDER BY id LIMIT 1', [customerId]) : undefined;
  const sc = SCENARIOS.find((x) => x.customer.id === customerId);
  const attempts = all<{ created_at: string; step: string; method: string; outcome: string; failure_reason: string | null }>(
    'SELECT created_at, step, method, outcome, failure_reason FROM verification_attempts WHERE session_id = ? ORDER BY id',
    [sessionId],
  ).map((a) => ({ at: a.created_at, step: a.step, method: a.method.replace(/_/g, ' '), outcome: a.outcome, reason: a.failure_reason }));
  const cardTries = attempts.filter((a) => a.step === 'card');

  const transcript = all<{ seq: number; speaker: string; kind: string; text: string; created_at: string; sensitive_redacted: number }>(
    'SELECT seq, speaker, kind, text, created_at, sensitive_redacted FROM conversation_turns WHERE session_id = ? ORDER BY seq',
    [sessionId],
  ).map((t) => ({ seq: t.seq, at: t.created_at, speaker: t.speaker, kind: t.kind, text: t.text, hidden: !!t.sensitive_redacted }));

  const events = listTimeline(sessionId).filter((e) => !/^voice\.(muted|unmuted)/.test(e.type));
  const kb = kbReferencesFor(sessionId);
  const primary = tags?.intent ?? s.issue_type;
  const primaryLabel = primary ? ISSUE_LABELS[primary] ?? primary : 'Not yet identified';
  const secondary = (tags?.secondaryIntents ?? []).map((x) => x.label);

  const aiTags = [
    primaryLabel,
    ...secondary,
    tags ? `Identity: ${tags.identity}` : null,
    tags ? `Urgency: ${tags.urgency}` : null,
    tags ? `Sentiment: ${tags.sentiment}` : null,
    h?.reason ? HANDOFF_REASON_LABELS[h.reason] ?? h.reason : null,
  ].filter(Boolean) as string[];
  const agentTags = s.agent_tags_json ? parseJson<string[]>(s.agent_tags_json, []) : null;

  const statement = s.issue_statement ?? res.customerSaid[0]?.text ?? '';
  const aiReason = `${primaryLabel}${secondary.length ? ` (also: ${secondary.join(', ')})` : ''}${statement ? ` — customer said: “${redactText(statement).slice(0, 220)}”` : ''}`;

  // Concise AI summary, assembled only from recorded facts.
  const verifiedLine = s.verification_status === 'verified' ? 'Identity was verified in the call.' : s.verification_status === 'failed' ? `Identity was NOT verified (${cardTries.filter((a) => a.outcome !== 'passed').length || 'several'} failed attempt${cardTries.filter((a) => a.outcome !== 'passed').length === 1 ? '' : 's'}).` : 'Identity was not verified.';
  const done = res.actions.filter((a) => a.bucket === 'completed').map((a) => a.label);
  const openActs = res.actions.filter((a) => a.bucket !== 'completed').map((a) => `${a.label}: ${a.statusLabel}`);
  const aiSummary = [
    `${cu?.full_name ?? 'The customer'} contacted ${BANK_NAME} about ${primaryLabel.toLowerCase()}${secondary.length ? ` and also ${secondary.join(' and ').toLowerCase()}` : ''}.`,
    verifiedLine,
    res.verifiedFacts.length ? `Systems confirmed: ${res.verifiedFacts.slice(0, 3).join(' ')}` : 'No account facts have been confirmed yet.',
    done.length ? `Completed and confirmed by systems: ${done.join(', ')}.` : 'No account changes were made.',
    openActs.length ? `Not completed: ${openActs.join('; ')}.` : null,
    h ? `Handover reason: ${HANDOFF_REASON_LABELS[h.reason] ?? h.reason}${h.reason_detail ? ` (${h.reason_detail})` : ''}.` : 'Lily handled the call without a handover.',
  ].filter(Boolean).join(' ');

  // Suggested solution: an AI RECOMMENDATION, separate from confirmed actions.
  const verificationFailed = h?.reason === 'verification_failed' || s.verification_status === 'failed';
  const recommendation = verificationFailed
    ? 'Do not discuss or change the account yet. Verify the customer another way (for example a callback to the registered phone), then handle the original request.'
    : res.nextStep ?? res.brief.recommendedNextStep;
  const reasoning = [
    h ? `Handover reason: ${HANDOFF_REASON_LABELS[h.reason] ?? h.reason}.` : null,
    verificationFailed ? 'The card number given did not match the active customer’s record on the server.' : null,
    ...res.verifiedFacts.slice(0, 3).map((f) => `Confirmed: ${f}`),
    ...kb.slice(0, 2).map((k) => `Guidance “${k.title}” applies — ${k.reason || 'matches the call'}.`),
  ].filter(Boolean) as string[];
  const suggestion = {
    status: 'ai_recommendation' as const,
    notice: 'AI recommendation — not a confirmed action. Only operations marked “confirmed” below actually happened.',
    text: recommendation,
    reasoning,
    supportingFacts: res.verifiedFacts,
    confirmedActions: res.actions.filter((a) => a.bucket === 'completed').map((a) => ({ label: a.label, status: a.statusLabel, reference: a.reference })),
    notConfirmed: res.actions.filter((a) => a.bucket !== 'completed').map((a) => ({ label: a.label, status: a.statusLabel })),
    override: s.suggestion_override,
    effective: s.suggestion_override ?? recommendation,
  };

  const crmQuery = [cu?.full_name, sc?.customer.phone, cu?.customer_number, primaryLabel !== 'Not yet identified' ? primaryLabel : null].filter(Boolean).join(' · ');
  const edits = all<{ ts: string; event: string; actor_id: string; metadata_json: string }>(
    "SELECT ts, event, actor_id, metadata_json FROM audit_events WHERE session_id = ? AND event LIKE 'agent.workspace.%' ORDER BY id DESC LIMIT 30",
    [sessionId],
  ).map((e) => ({ at: e.ts, field: e.event.replace('agent.workspace.', ''), by: e.actor_id }));

  const start = Date.parse(s.answered_at);
  const end = s.ended_at ? Date.parse(s.ended_at) : nowMs();

  return {
    simulated: true,
    bank: BANK_NAME,
    handoff: h ? { id: h.id, status: h.status, phase: PHASE[h.status] ?? h.status, reason: h.reason, reasonLabel: HANDOFF_REASON_LABELS[h.reason] ?? h.reason, reasonDetail: h.reason_detail, agentId: h.agent_id, requestedAt: h.requested_at, connectedAt: h.connected_at, completedAt: h.completed_at, outcome: h.outcome } : null,
    customer: {
      name: cu?.full_name ?? 'Unknown caller',
      phone: sc?.customer.phone ?? null,
      accountRef: cu?.customer_number ?? null,
      cardNumber: card?.demo_pan ?? null,
      cardLast4: card?.last4 ?? null,
      cardStatus: card?.status ?? null,
      standing: cu?.account_standing ?? null,
      synthetic: true,
      notice: 'Fictional demo customer and card number — test data only.',
    },
    verification: { status: s.verification_status, attempts, failedCardAttempts: cardTries.filter((a) => a.outcome === 'failed' || a.outcome === 'locked').length },
    call: { sessionId, channel: s.channel, startedAt: s.answered_at, endedAt: s.ended_at, durationSeconds: Math.max(0, Math.round((end - start) / 1000)), status: s.ended_at ? 'ended' : 'live' },
    intents: { primary: { key: primary, label: primaryLabel }, secondary },
    tags: { ai: aiTags, agent: agentTags, effective: agentTags ?? aiTags },
    reason: { ai: aiReason, agent: s.call_reason_summary, effective: s.call_reason_summary ?? aiReason },
    aiSummary,
    transcript,
    activity: events.map((e) => ({ id: e.id, at: e.at, stage: e.stage, type: e.type, title: e.title, detail: e.detail, status: e.status })),
    actions: res.actions,
    unresolved: res.unresolved,
    concerns: res.customerSaid.map((x) => x.text),
    suggestion,
    knowledge: kb.map((k) => ({ id: k.id, title: k.title, excerpt: k.excerpt, steps: k.steps, reason: k.reason, ruleRefs: k.ruleRefs, notice: 'Illustrative demo policy — not real bank policy.' })),
    crm: { query: crmQuery },
    notes: s.agent_notes_text ?? '',
    resolution: { text: s.resolution_text ?? '', nextSteps: s.next_steps_text ?? '', outcome: h?.outcome ?? null, agentNotes: h?.agent_notes ?? null },
    edits,
    editedAt: s.agent_edited_at,
  };
}

/* ------------------------------------------------------------------------------ edits */

const Tag = z.string().trim().min(1).max(40).regex(/^[\p{L}\p{N} .,:&+/'’()\-]+$/u, 'Tags may contain letters, numbers and simple punctuation only.');
export const WorkspacePatch = z
  .object({
    tags: z.array(Tag).max(12).optional(),
    reasonSummary: z.string().trim().max(800).optional(),
    suggestion: z.string().trim().max(1500).optional(),
    notes: z.string().trim().max(3000).optional(),
    resolution: z.string().trim().max(1500).optional(),
    nextSteps: z.string().trim().max(800).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update.');

export function editWorkspace(handoffId: string, actor: Actor & { id: string }, raw: unknown) {
  const patch = WorkspacePatch.parse(raw);
  const h = get<{ session_id: string; status: string; agent_id: string | null }>('SELECT session_id, status, agent_id FROM handoffs WHERE id = ?', [handoffId]);
  if (!h) throw new AppError('NOT_FOUND', 'Handoff not found.');
  if (h.status !== 'connected') throw new AppError('CONFLICT', h.status === 'completed' ? 'This case is completed and can no longer be edited.' : 'Accept the handover before editing the case.');
  if (h.agent_id !== actor.id) throw new AppError('FORBIDDEN', 'Only the agent who accepted this handover can edit it.');
  const s = get<SessionRow>('SELECT * FROM call_sessions WHERE id = ?', [h.session_id])!;
  const ts = nowIso();
  const base = { actor, status: 'ok' as const, resourceType: 'handoff', resourceId: handoffId, sessionId: h.session_id };

  if (patch.tags) {
    const next = [...new Set(patch.tags.map((t) => t.trim()))];
    const before = s.agent_tags_json ? parseJson<string[]>(s.agent_tags_json, []) : null;
    run('UPDATE call_sessions SET agent_tags_json = ?, agent_edited_at = ? WHERE id = ?', [JSON.stringify(next), ts, h.session_id]);
    audit({ ...base, event: 'agent.workspace.tags_edited', metadata: { before, after: next } });
  }
  const text = (col: string, event: string, value: string | undefined, before: string | null) => {
    if (value === undefined) return;
    run(`UPDATE call_sessions SET ${col} = ?, agent_edited_at = ? WHERE id = ?`, [redactText(value), ts, h.session_id]);
    audit({ ...base, event, metadata: { beforeLength: before?.length ?? 0, afterLength: value.length, cleared: value.length === 0 } });
  };
  text('call_reason_summary', 'agent.workspace.reason_summary_edited', patch.reasonSummary, s.call_reason_summary);
  text('suggestion_override', 'agent.workspace.suggestion_edited', patch.suggestion, s.suggestion_override);
  text('agent_notes_text', 'agent.workspace.notes_edited', patch.notes, s.agent_notes_text);
  text('resolution_text', 'agent.workspace.resolution_recorded', patch.resolution, s.resolution_text);
  text('next_steps_text', 'agent.workspace.next_steps_recorded', patch.nextSteps, s.next_steps_text);

  emitTimeline(h.session_id, { type: 'handoff.case_updated', stage: 'record', title: 'Agent updated the case details', status: 'info', source: 'agent workspace', ref: handoffId });
  return buildWorkspace(handoffId)!;
}

/* ------------------------------------------------------------------------------ CRM search */

export interface CrmCustomer { kind: 'customer'; name: string; accountRef: string; phone: string; standing: string; cardLast4: string | null; cardStatus: string | null; matchedOn: string[] }
export interface CrmCase { kind: 'case'; id: string; customer: string | null; issue: string; status: string; summary: string; createdAt: string; matchedOn: string[] }

/**
 * Synthetic CRM: customers and cases from the demo database. Plain token matching over names,
 * phone digits, account reference, issue labels and case summaries. Queries that look like a card
 * number are refused, and the query text itself is never written to the audit log.
 */
export function crmSearch(query: string, actor: Actor, sessionId?: string | null): { query: string; customers: CrmCustomer[]; cases: CrmCase[] } {
  const q = query.trim().slice(0, 200);
  if (looksLikeCardNumber(q)) throw new AppError('VALIDATION_FAILED', 'Card numbers cannot be used in CRM searches. Search by name, phone, account reference or topic.');
  const tokens = [...new Set(q.toLowerCase().split(/[\s·,;|]+/).map((t) => t.replace(/^[(+]+|[)]+$/g, '')).filter((t) => t.length >= 2))];
  const digitTokens = tokens.map((t) => t.replace(/\D/g, '')).filter((d) => d.length >= 3);
  const customers: (CrmCustomer & { score: number })[] = [];
  for (const sc of SCENARIOS) {
    const cu = get<{ id: string; customer_number: string; full_name: string; account_standing: string }>('SELECT id, customer_number, full_name, account_standing FROM bank_customers WHERE id = ?', [sc.customer.id]);
    if (!cu) continue;
    const card = get<{ last4: string; status: string }>('SELECT last4, status FROM bank_cards WHERE customer_id = ? ORDER BY id LIMIT 1', [cu.id]);
    const name = cu.full_name.toLowerCase();
    const phone = sc.customer.phone.replace(/\D/g, '');
    const matchedOn: string[] = [];
    let score = 0;
    for (const t of tokens) if (name.includes(t)) { score += 3; if (!matchedOn.includes('name')) matchedOn.push('name'); }
    for (const d of digitTokens) {
      if (phone.includes(d)) { score += 3; if (!matchedOn.includes('phone')) matchedOn.push('phone'); }
      if (cu.customer_number.includes(d)) { score += 4; if (!matchedOn.includes('account reference')) matchedOn.push('account reference'); }
    }
    if (score > 0) customers.push({ kind: 'customer', name: cu.full_name, accountRef: cu.customer_number, phone: sc.customer.phone, standing: cu.account_standing, cardLast4: card?.last4 ?? null, cardStatus: card?.status ?? null, matchedOn, score });
  }
  const cases: (CrmCase & { score: number })[] = [];
  for (const c of all<{ id: string; customer_id: string | null; issue_type: string | null; status: string; summary: string | null; created_at: string; full_name: string | null }>(
    'SELECT c.id, c.customer_id, c.issue_type, c.status, c.summary, c.created_at, b.full_name FROM cases c LEFT JOIN bank_customers b ON b.id = c.customer_id ORDER BY c.created_at DESC LIMIT 300',
  )) {
    const issue = c.issue_type ? ISSUE_LABELS[c.issue_type] ?? c.issue_type : 'Not identified';
    const hay = `${c.id} ${issue} ${c.summary ?? ''} ${c.full_name ?? ''}`.toLowerCase();
    const matchedOn: string[] = [];
    let score = 0;
    for (const t of tokens) {
      if (t.length < 3) continue;
      if ((c.full_name ?? '').toLowerCase().includes(t)) { score += 3; if (!matchedOn.includes('customer')) matchedOn.push('customer'); }
      else if (issue.toLowerCase().includes(t)) { score += 2; if (!matchedOn.includes('issue')) matchedOn.push('issue'); }
      else if (hay.includes(t)) { score += 1; if (!matchedOn.includes('summary')) matchedOn.push('summary'); }
    }
    if (score > 0) cases.push({ kind: 'case', id: c.id, customer: c.full_name, issue, status: c.status, summary: redactText(c.summary ?? '').slice(0, 200), createdAt: c.created_at, matchedOn, score });
  }
  customers.sort((a, b) => b.score - a.score);
  cases.sort((a, b) => b.score - a.score || Date.parse(b.createdAt) - Date.parse(a.createdAt));
  audit({ actor, event: 'agent.crm_search', status: 'ok', sessionId: sessionId ?? null, metadata: { tokenCount: tokens.length, customers: customers.length, cases: cases.length } });
  return { query: q, customers: customers.slice(0, 6).map(({ score: _s, ...r }) => r), cases: cases.slice(0, 8).map(({ score: _s, ...r }) => r) };
}
