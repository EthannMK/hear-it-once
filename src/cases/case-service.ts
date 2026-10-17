/**
 * CASE MANAGEMENT. One persistent case per call session, created/updated during the call.
 * The summary is generated deterministically from persisted events and operation rows, and
 * keeps three things apart: what the customer reported, what bank systems confirmed, and
 * what actions actually completed (with their real statuses).
 */
import { all, get, parseJson, run } from '../db/db.ts';
import { nowIso } from '../lib/clock.ts';
import { newId } from '../lib/ids.ts';
import { redactText } from '../lib/redact.ts';
import { audit, type Actor } from '../audit/audit.ts';
import { ISSUE_LABELS, HANDOFF_REASON_LABELS, ACTION_LABELS, OP_STATUS_LABELS, formatMoney, formatDate } from '../conversation/format.ts';

export interface Finding {
  kind: 'confirmed' | 'inferred' | 'unavailable';
  text: string;
  source: string | null;
}

export function getCaseForSession(sessionId: string): Record<string, unknown> | undefined {
  return get('SELECT * FROM cases WHERE session_id = ?', [sessionId]);
}

export function ensureCase(input: {
  sessionId: string;
  customerId: string | null;
  issueType: string | null;
  verificationOutcome: string;
  customerReported: string | null;
  actor: Actor;
  correlationId?: string;
  dataOrigin?: string;
}): string {
  const existing = get<{ id: string }>('SELECT id FROM cases WHERE session_id = ?', [input.sessionId]);
  if (existing) {
    run(
      `UPDATE cases SET customer_id = COALESCE(customer_id, ?), issue_type = COALESCE(?, issue_type), verification_outcome = ?,
         customer_reported = COALESCE(customer_reported, ?), updated_at = ? WHERE id = ?`,
      [input.customerId, input.issueType, input.verificationOutcome, input.customerReported ? redactText(input.customerReported) : null, nowIso(), existing.id],
    );
    return existing.id;
  }
  const id = newId('CASE');
  const ts = nowIso();
  run(
    `INSERT INTO cases (id, session_id, customer_id, issue_type, status, verification_outcome, customer_reported, data_origin, created_at, updated_at)
     VALUES (?,?,?,?, 'open', ?,?,?,?,?)`,
    [id, input.sessionId, input.customerId, input.issueType, input.verificationOutcome, input.customerReported ? redactText(input.customerReported) : null, input.dataOrigin ?? 'demo_session', ts, ts],
  );
  run('UPDATE call_sessions SET case_created_at = COALESCE(case_created_at, ?) WHERE id = ?', [ts, input.sessionId]);
  caseEvent(id, 'case_created', { verificationOutcome: input.verificationOutcome });
  audit({ actor: input.actor, event: 'case.created', status: 'ok', resourceType: 'case', resourceId: id, sessionId: input.sessionId, correlationId: input.correlationId });
  return id;
}

export function caseEvent(caseId: string, type: string, detail: Record<string, unknown> = {}): void {
  run('INSERT INTO case_events (case_id, event_type, detail_json, created_at) VALUES (?,?,?,?)', [caseId, type, JSON.stringify(detail), nowIso()]);
  run('UPDATE cases SET updated_at = ? WHERE id = ?', [nowIso(), caseId]);
}

export function recordFindings(caseId: string, findings: Finding[]): void {
  for (const f of findings) caseEvent(caseId, `fact_${f.kind}`, { text: redactText(f.text), source: f.source });
}

type CasePatch = Partial<{
  issue_type: string | null;
  status: string;
  resolution_status: string | null;
  transaction_refs: string[];
  sources_checked: unknown[];
  eligibility: unknown;
  next_steps: string;
  handoff_notes: string;
  previous_case_ids: string[];
  recurring_issue: boolean;
  risk_flags: string[];
}>;

export function updateCase(caseId: string, patch: CasePatch): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  const map: Record<string, [string, (v: unknown) => unknown]> = {
    issue_type: ['issue_type', (v) => v],
    status: ['status', (v) => v],
    resolution_status: ['resolution_status', (v) => v],
    transaction_refs: ['transaction_refs_json', (v) => JSON.stringify(v)],
    sources_checked: ['sources_checked_json', (v) => JSON.stringify(v)],
    eligibility: ['eligibility_json', (v) => JSON.stringify(v)],
    next_steps: ['next_steps', (v) => v],
    handoff_notes: ['handoff_notes', (v) => v],
    previous_case_ids: ['previous_case_ids_json', (v) => JSON.stringify(v)],
    recurring_issue: ['recurring_issue', (v) => (v ? 1 : 0)],
    risk_flags: ['risk_flags_json', (v) => JSON.stringify([...new Set(v as string[])])],
  };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const [col, conv] = map[k];
    sets.push(`${col} = ?`);
    vals.push(conv(v));
  }
  if (patch.status === 'resolved' || patch.status === 'closed') sets.push(`closed_at = COALESCE(closed_at, '${nowIso()}')`);
  sets.push('updated_at = ?');
  vals.push(nowIso());
  run(`UPDATE cases SET ${sets.join(', ')} WHERE id = ?`, [...vals, caseId]);
}

export function addRiskFlag(caseId: string, flag: string): void {
  const c = get<{ risk_flags_json: string }>('SELECT risk_flags_json FROM cases WHERE id = ?', [caseId]);
  if (!c) return;
  const flags = parseJson<string[]>(c.risk_flags_json, []);
  if (!flags.includes(flag)) updateCase(caseId, { risk_flags: [...flags, flag] });
}

/** Grounded, deterministic summary built ONLY from persisted rows. */
export function regenerateSummary(caseId: string): string {
  const c = get<Record<string, unknown>>('SELECT * FROM cases WHERE id = ?', [caseId]);
  if (!c) return '';
  const events = all<{ event_type: string; detail_json: string }>('SELECT event_type, detail_json FROM case_events WHERE case_id = ? ORDER BY id', [caseId]);
  const facts = (kind: string) => [...new Set(events.filter((e) => e.event_type === `fact_${kind}`).map((e) => parseJson<{ text: string }>(e.detail_json, { text: '' }).text))];
  const ops = all<{ action_type: string; status: string; target_ref: string; external_ref: string | null; error_code: string | null }>(
    'SELECT action_type, status, target_ref, external_ref, error_code FROM action_operations WHERE case_id = ? ORDER BY requested_at',
    [caseId],
  );
  const disputes = all<{ id: string; status: string; merchant: string; amount_minor: number; currency: string; txn_date: string; external_ref: string | null }>(
    'SELECT id, status, merchant, amount_minor, currency, txn_date, external_ref FROM disputes WHERE case_id = ?',
    [caseId],
  );
  const handoff = get<{ reason: string; status: string }>('SELECT reason, status FROM handoffs WHERE case_id = ? ORDER BY requested_at DESC LIMIT 1', [caseId]);
  const lines: string[] = [];
  lines.push(`Issue: ${ISSUE_LABELS[String(c.issue_type)] ?? 'Not yet classified'}. Verification: ${c.verification_outcome}.`);
  lines.push(`Customer reported: ${c.customer_reported ? `"${c.customer_reported}"` : 'not captured'}.`);
  const conf = facts('confirmed');
  lines.push(`Bank systems confirmed: ${conf.length ? conf.join(' ') : 'nothing yet.'}`);
  const inf = facts('inferred');
  if (inf.length) lines.push(`Inferred (not confirmed by a system): ${inf.join(' ')}`);
  const un = facts('unavailable');
  if (un.length) lines.push(`Unavailable / not verified: ${un.join(' ')}`);
  const done = ops.filter((o) => o.status === 'succeeded');
  const notDone = ops.filter((o) => o.status !== 'succeeded');
  lines.push(`Actions completed (confirmed by service): ${done.length ? done.map((o) => `${ACTION_LABELS[o.action_type]} (ref ${o.external_ref})`).join('; ') : 'none'}.`);
  if (notDone.length) lines.push(`Actions not completed: ${notDone.map((o) => `${ACTION_LABELS[o.action_type]} — ${OP_STATUS_LABELS[o.status] ?? o.status}${o.error_code ? ` (${o.error_code})` : ''}`).join('; ')}.`);
  for (const d of disputes)
    lines.push(`Dispute ${d.id}: ${formatMoney(d.amount_minor, d.currency)} at ${d.merchant} on ${formatDate(d.txn_date)} — status ${d.status}${d.external_ref ? `, intake ref ${d.external_ref}` : ''} (submission is not a final decision).`);
  if (handoff) lines.push(`Handoff: ${HANDOFF_REASON_LABELS[handoff.reason] ?? handoff.reason} — ${handoff.status}.`);
  // A later demo call put the bank records back. Say so, so this case cannot be read as the current
  // state of the account: what happened on the call stands, and the reset came after it.
  const reset = events.filter((e) => e.event_type === 'demo_data_reset').at(-1);
  if (reset) {
    const at = parseJson<{ at?: string }>(reset.detail_json, {}).at;
    lines.push(`Demo data was put back after this call${at ? ` on ${formatDate(at)}` : ''}: the card is active again, fees are charged again and disputes are released. The actions above did happen on this call.`);
  }
  if (c.next_steps) lines.push(`Next steps: ${c.next_steps}`);
  const summary = redactText(lines.join('\n'));
  run('UPDATE cases SET summary = ?, actions_json = ?, updated_at = ? WHERE id = ?', [summary, JSON.stringify(ops), nowIso(), caseId]);
  return summary;
}

export function getCaseDetail(caseId: string) {
  const c = get<Record<string, unknown> & { session_id: string }>('SELECT * FROM cases WHERE id = ?', [caseId]);
  if (!c) return null;
  return {
    ...c,
    transaction_refs: parseJson(c.transaction_refs_json, []),
    sources_checked: parseJson(c.sources_checked_json, []),
    eligibility: parseJson(c.eligibility_json, null),
    actions: all('SELECT id, action_type, status, target_ref, external_ref, error_code, error_message, requested_at, completed_at, attempts FROM action_operations WHERE case_id = ? ORDER BY requested_at', [caseId]),
    disputes: all('SELECT * FROM disputes WHERE case_id = ?', [caseId]).map((d) => ({ ...d, evidence: parseJson((d as { evidence_json: string }).evidence_json, []), missing_fields: parseJson((d as { missing_fields_json: string }).missing_fields_json, []) })),
    previous_case_ids: parseJson(c.previous_case_ids_json, []),
    risk_flags: parseJson(c.risk_flags_json, []),
    events: all('SELECT event_type, detail_json, created_at FROM case_events WHERE case_id = ? ORDER BY id', [caseId]).map((e) => ({ ...e, detail: parseJson((e as { detail_json: string }).detail_json, {}) })),
    handoffs: all('SELECT id, reason, status, requested_at, connected_at, completed_at, outcome, agent_notes FROM handoffs WHERE case_id = ?', [caseId]),
  };
}
