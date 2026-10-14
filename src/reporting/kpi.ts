/**
 * KPI CALCULATIONS (FR-16, BRD §12). Every value is computed from persisted rows at request
 * time — nothing is hard-coded. Each metric carries its definition and sample size (n). Targets
 * are returned separately and are never presented as achieved. All data in this prototype is
 * synthetic: "seeded_illustrative" rows are generated history; "demo_session" rows are
 * measured from calls actually run in the simulator.
 */
import { z } from 'zod';
import { all } from '../db/db.ts';
import { nowIso } from '../lib/clock.ts';
import { PILOT_TARGETS } from '../config/targets.ts';
import { HANDOFF_REASON_LABELS, ISSUE_LABELS } from '../conversation/format.ts';

export const KpiFilterSchema = z.object({
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  issueType: z.enum(['unrecognised_transaction', 'lost_stolen_card', 'wrong_or_duplicate_charge', 'payment_not_showing', 'fee_query', 'card_declined']).optional(),
  outcome: z.enum(['resolved', 'handed_off', 'abandoned', 'verification_failed', 'fallback', 'in_progress', 'ended_unresolved']).optional(),
  handoffReason: z.string().max(40).optional(),
  origin: z.enum(['all', 'demo_session', 'seeded_illustrative']).default('all'),
});
export type KpiFilter = z.infer<typeof KpiFilterSchema>;

export interface Metric {
  id: string;
  label: string;
  value: number | null;
  unit: '%' | 's' | 'count' | 'score' | 'calls' | 'ms';
  n: number;
  definition: string;
  targetId?: string;
  extra?: Record<string, unknown>;
}

interface SessionRow {
  id: string;
  customer_id: string | null;
  issue_type: string | null;
  eligible: number;
  outcome: string | null;
  resolution_status: string | null;
  handoff_reason: string | null;
  data_origin: string;
  answered_at: string;
  ended_at: string | null;
  verified_at: string | null;
  retrieval_started_at: string | null;
  retrieval_completed_at: string | null;
  proposal_at: string | null;
  consent_at: string | null;
  execution_completed_at: string | null;
  case_created_at: string | null;
  handoff_requested_at: string | null;
  agent_joined_at: string | null;
  issue_restatements: number;
  csat: number | null;
  mood_start: string | null;
  mood_end: string | null;
}

const secs = (a: string | null, b: string | null) => (a && b ? (Date.parse(b) - Date.parse(a)) / 1000 : null);
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const idx = Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1));
  return v[idx];
}
const avg = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
const pct = (num: number, den: number) => (den ? (100 * num) / den : null);
const r1 = (x: number | null) => (x == null ? null : Math.round(x * 10) / 10);
const inList = (ids: string[]) => ids.map(() => '?').join(',') || "''";

export function computeKpis(f: KpiFilter) {
  const where: string[] = [];
  const p: unknown[] = [];
  if (f.from) (where.push('answered_at >= ?'), p.push(f.from));
  if (f.to) (where.push('answered_at <= ?'), p.push(f.to.length === 10 ? `${f.to}T23:59:59.999Z` : f.to));
  if (f.issueType) (where.push('issue_type = ?'), p.push(f.issueType));
  if (f.outcome) (where.push('outcome = ?'), p.push(f.outcome));
  if (f.handoffReason) (where.push('handoff_reason = ?'), p.push(f.handoffReason));
  if (f.origin !== 'all') (where.push('data_origin = ?'), p.push(f.origin));
  const sessions = all<SessionRow>(`SELECT * FROM call_sessions ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`, p);
  const ids = sessions.map((s) => s.id);
  const eligible = sessions.filter((s) => s.eligible === 1);
  const ended = (xs: SessionRow[]) => xs.filter((s) => s.ended_at);
  const metrics: Metric[] = [];

  // Volume
  metrics.push({ id: 'call_volume', label: 'Call volume', value: sessions.length, unit: 'count', n: sessions.length, definition: 'Sessions answered in the selected window.' });
  metrics.push({ id: 'eligible_volume', label: 'Eligible calls', value: eligible.length, unit: 'count', n: sessions.length, definition: 'Sessions classified into one of the five BRD issue types.' });

  // Handling time (eligible, ended, excluding abandoned)
  const aht = ended(eligible).filter((s) => s.outcome !== 'abandoned').map((s) => secs(s.answered_at, s.ended_at)!);
  metrics.push({ id: 'aht', label: 'Average handling time', value: r1(avg(aht)), unit: 's', n: aht.length, definition: 'Mean of (session ended − answered) for ended eligible calls; includes time with an agent after handoff; excludes abandoned calls.', targetId: 'aht_reduction', extra: { median: r1(percentile(aht, 50)) } });

  // Wait / hold time
  const holds = ids.length ? all<{ session_id: string; started_at: string; ended_at: string | null }>(`SELECT session_id, started_at, ended_at FROM hold_intervals WHERE session_id IN (${inList(ids)})`, ids) : [];
  const holdBySession = new Map<string, number>();
  for (const h of holds) if (h.ended_at) holdBySession.set(h.session_id, (holdBySession.get(h.session_id) ?? 0) + secs(h.started_at, h.ended_at)!);
  const endedIds = ended(sessions).map((s) => s.id);
  const waitPer = endedIds.map((id) => holdBySession.get(id) ?? 0);
  metrics.push({ id: 'wait_time', label: 'Average wait / hold', value: r1(avg(waitPer)), unit: 's', n: waitPer.length, definition: 'Mean per ended call of explicitly recorded hold intervals (agent queue).', targetId: 'wait_time', extra: { pctWithin60s: r1(pct(waitPer.filter((w) => w <= 60).length, waitPer.length)) } });

  // First-call resolution
  const fcrDen = ended(eligible).filter((s) => s.outcome !== 'abandoned');
  const fcrNum = fcrDen.filter((s) => s.outcome === 'resolved');
  metrics.push({ id: 'fcr', label: 'First-call resolution', value: r1(pct(fcrNum.length, fcrDen.length)), unit: '%', n: fcrDen.length, definition: 'Eligible ended calls with outcome "resolved" (resolution status resolved/informational, no handoff, no unknown operations) ÷ eligible ended non-abandoned calls. Case creation is not resolution.', targetId: 'fcr' });

  // Repeat contact within 7 days (same customer + same issue family)
  const verifiedEligible = eligible.filter((s) => s.customer_id && s.issue_type);
  const history = verifiedEligible.length
    ? all<{ customer_id: string; issue_type: string; answered_at: string; id: string }>(
        `SELECT id, customer_id, issue_type, answered_at FROM call_sessions WHERE customer_id IN (${inList([...new Set(verifiedEligible.map((s) => s.customer_id!))])}) AND issue_type IS NOT NULL`,
        [...new Set(verifiedEligible.map((s) => s.customer_id!))],
      )
    : [];
  const repeats = verifiedEligible.filter((s) =>
    history.some((h) => h.id !== s.id && h.customer_id === s.customer_id && h.issue_type === s.issue_type && Date.parse(h.answered_at) < Date.parse(s.answered_at) && Date.parse(s.answered_at) - Date.parse(h.answered_at) <= 7 * 86_400_000),
  );
  metrics.push({ id: 'repeat_7d', label: 'Repeat contact within 7 days', value: r1(pct(repeats.length, verifiedEligible.length)), unit: '%', n: verifiedEligible.length, definition: 'Verified eligible calls where the same customer called about the same issue type in the previous 7 days.', targetId: 'repeat_7d' });

  // Customer repetition rate
  const qa = ids.length ? all<{ session_id: string; customer_repeated_issue: number; action_correct: number | null; safety_incident: number; in_sample: number }>(`SELECT * FROM qa_reviews WHERE session_id IN (${inList(ids)})`, ids) : [];
  const handoffs = ids.length
    ? all<{ session_id: string; reason: string; status: string; agent_id: string | null; requested_at: string; connected_at: string | null; completed_at: string | null; customer_repeated_issue: number | null }>(
        `SELECT session_id, reason, status, agent_id, requested_at, connected_at, completed_at, customer_repeated_issue FROM handoffs WHERE session_id IN (${inList(ids)})`,
        ids,
      )
    : [];
  const repeatedSet = new Set<string>([
    ...eligible.filter((s) => s.issue_restatements > 0).map((s) => s.id),
    ...qa.filter((q) => q.customer_repeated_issue).map((q) => q.session_id),
    ...handoffs.filter((h) => h.customer_repeated_issue).map((h) => h.session_id),
  ]);
  const repN = eligible.filter((s) => repeatedSet.has(s.id)).length;
  metrics.push({ id: 'repetition', label: 'Customer repetition rate', value: r1(pct(repN, eligible.length)), unit: '%', n: eligible.length, definition: 'Eligible calls where the customer was asked to restate the issue (restatement events) or a QA reviewer / receiving agent flagged that they had to repeat it ÷ eligible calls.', targetId: 'repetition' });

  // Time to block
  const blockApplicable = sessions.filter((s) => s.verified_at && (s.issue_type === 'lost_stolen_card' || s.issue_type === 'unrecognised_transaction'));
  const blockOps = blockApplicable.length
    ? all<{ session_id: string; status: string; completed_at: string | null }>(`SELECT session_id, status, completed_at FROM action_operations WHERE action_type = 'block_card' AND session_id IN (${inList(blockApplicable.map((s) => s.id))})`, blockApplicable.map((s) => s.id))
    : [];
  const blockSessions = blockApplicable.filter((s) => s.issue_type === 'lost_stolen_card' || blockOps.some((o) => o.session_id === s.id && o.status !== 'rejected'));
  const confirmedTimes: number[] = [];
  let within60 = 0;
  for (const s of blockSessions) {
    const ok = blockOps.find((o) => o.session_id === s.id && o.status === 'succeeded');
    if (ok) {
      const t = secs(s.verified_at, ok.completed_at)!;
      confirmedTimes.push(t);
      if (t <= 60) within60++;
    }
  }
  metrics.push({
    id: 'block_rate',
    label: 'Cards blocked ≤60 s after verification',
    value: r1(pct(within60, blockSessions.length)),
    unit: '%',
    n: blockSessions.length,
    definition: 'Applicable calls (verified lost/stolen, or fraud calls where a block was attempted) with a CONFIRMED block within 60 s of verification ÷ applicable calls. Failed, unknown, declined or missing blocks count against.',
    targetId: 'block_rate',
    extra: { medianSeconds: r1(percentile(confirmedTimes, 50)), p90Seconds: r1(percentile(confirmedTimes, 90)), confirmed: confirmedTimes.length, failedOrUnknown: blockOps.filter((o) => o.status === 'failed' || o.status === 'unknown').length },
  });

  // Dispute quality (simulated downstream)
  const disputes = ids.length ? all<{ status: string; rework_required: number | null; data_origin: string }>(`SELECT status, rework_required, data_origin FROM disputes WHERE session_id IN (${inList(ids)})`, ids) : [];
  const reviewed = disputes.filter((d) => d.status === 'submitted' && d.rework_required !== null);
  metrics.push({
    id: 'dispute_no_rework',
    label: 'Disputes accepted without rework (SIMULATED)',
    value: r1(pct(reviewed.filter((d) => d.rework_required === 0).length, reviewed.length)),
    unit: '%',
    n: reviewed.length,
    definition: 'Submitted disputes with a SIMULATED downstream review marked "no rework" ÷ submitted disputes with a simulated review. Not demonstrable with mocks alone; production definition needs the dispute team.',
    targetId: 'dispute_no_rework',
    extra: { submitted: disputes.filter((d) => d.status === 'submitted').length, pending: disputes.filter((d) => d.status === 'pending' || d.status === 'unknown').length, failedOrRejected: disputes.filter((d) => d.status === 'failed' || d.status === 'rejected').length },
  });

  // Handoff rate & reasons
  const handedOffSessions = new Set(handoffs.filter((h) => h.status !== 'cancelled').map((h) => h.session_id));
  const reasons: Record<string, number> = {};
  for (const h of handoffs.filter((x) => x.status !== 'cancelled')) reasons[h.reason] = (reasons[h.reason] ?? 0) + 1;
  metrics.push({
    id: 'handoff_rate',
    label: 'Human handoff rate',
    value: r1(pct([...handedOffSessions].length, sessions.length)),
    unit: '%',
    n: sessions.length,
    definition: 'Calls with a handoff request (queued, connected, completed or no-agent fallback) ÷ all calls in the window.',
    extra: { reasons: Object.entries(reasons).map(([k, v]) => ({ reason: k, label: HANDOFF_REASON_LABELS[k] ?? k, count: v })).sort((a, b) => b.count - a.count) },
  });

  // Satisfaction & mood (simulated)
  const cs = sessions.filter((s) => s.csat != null).map((s) => s.csat!);
  const moodCount = (k: 'mood_start' | 'mood_end') => sessions.reduce<Record<string, number>>((acc, s) => (s[k] ? ((acc[s[k]!] = (acc[s[k]!] ?? 0) + 1), acc) : acc), {});
  metrics.push({ id: 'csat', label: 'Satisfaction (SIMULATED survey, 1–5)', value: r1(avg(cs)), unit: 'score', n: cs.length, definition: 'Mean of end-of-call demo survey scores. Simulated; not a real customer survey. Mood labels are simulated selections, not AI inference.', targetId: 'csat', extra: { moodStart: moodCount('mood_start'), moodEnd: moodCount('mood_end') } });

  // Calls per agent per shift
  const shiftKey = (iso: string) => `${iso.slice(0, 10)}#${Math.floor(new Date(iso).getUTCHours() / 8)}`;
  const perAgentShift = new Map<string, number>();
  for (const h of handoffs.filter((x) => x.status === 'completed' && x.agent_id && x.completed_at)) {
    const k = `${h.agent_id}|${shiftKey(h.completed_at!)}`;
    perAgentShift.set(k, (perAgentShift.get(k) ?? 0) + 1);
  }
  metrics.push({ id: 'agent_calls', label: 'Calls handled per agent per shift', value: r1(avg([...perAgentShift.values()])), unit: 'calls', n: perAgentShift.size, definition: 'Completed handoffs per (agent, 8-hour shift). Demo traffic cannot establish real productivity; shown for method only.', targetId: 'agent_calls' });

  // Case before call end
  const resolvedCalls = ended(sessions).filter((s) => s.outcome === 'resolved');
  const caseBefore = resolvedCalls.filter((s) => s.case_created_at && s.case_created_at <= s.ended_at!);
  metrics.push({ id: 'case_before_end', label: 'Resolved calls with case before call end', value: r1(pct(caseBefore.length, resolvedCalls.length)), unit: '%', n: resolvedCalls.length, definition: 'Resolved calls whose case-created timestamp ≤ session-ended timestamp ÷ resolved calls.', targetId: 'case_before_end' });

  // Action correctness & safety
  const sample = qa.filter((q) => q.in_sample && q.action_correct !== null);
  metrics.push({
    id: 'action_correctness',
    label: 'Action correctness (QA sample)',
    value: r1(pct(sample.filter((q) => q.action_correct === 1).length, sample.length)),
    unit: '%',
    n: sample.length,
    definition: 'QA-reviewed calls with a consequential action judged correct ÷ QA-reviewed calls with a consequential action. Safety incidents counted separately.',
    targetId: 'action_correctness',
    extra: { safetyIncidents: qa.filter((q) => q.safety_incident).length },
  });

  // Integrations
  const ic = ids.length ? all<{ source: string; status: string; latency_ms: number; direction: string }>(`SELECT source, status, latency_ms, direction FROM integration_calls WHERE session_id IN (${inList(ids)})`, ids) : [];
  const bySource = new Map<string, { n: number; fail: number; lat: number[]; direction: string }>();
  for (const c of ic) {
    const e = bySource.get(c.source) ?? { n: 0, fail: 0, lat: [], direction: c.direction };
    e.n++;
    if (c.status !== 'ok') e.fail++;
    e.lat.push(c.latency_ms);
    bySource.set(c.source, e);
  }
  const integrationRows = [...bySource.entries()].map(([source, e]) => ({ source, direction: e.direction, calls: e.n, failureRatePct: r1(pct(e.fail, e.n)), p50ms: percentile(e.lat, 50), p95ms: percentile(e.lat, 95), simulated: true })).sort((a, b) => a.source.localeCompare(b.source));
  metrics.push({ id: 'integration_failure', label: 'Integration failure rate (all sources)', value: r1(pct(ic.filter((c) => c.status !== 'ok').length, ic.length)), unit: '%', n: ic.length, definition: 'Integration calls (mock adapters) not returning ok (error, timeout, unavailable, circuit open, stale) ÷ all integration calls.', extra: { bySource: integrationRows } });

  // AI / voice failures and unresolved operations
  const ev = ids.length ? all<{ event_type: string; n: number }>(`SELECT event_type, COUNT(*) n FROM session_events WHERE session_id IN (${inList(ids)}) AND event_type IN ('ai_model_error','assistant_unavailable','orchestrator_error','asr_low_confidence','unclear_input','duplicate_utterance_ignored','barge_in') GROUP BY event_type`, ids) : [];
  const unresolvedOps = ids.length ? all<{ status: string; n: number }>(`SELECT status, COUNT(*) n FROM action_operations WHERE session_id IN (${inList(ids)}) AND status IN ('unknown','submitted','awaiting_approval') GROUP BY status`, ids) : [];
  metrics.push({ id: 'ai_failures', label: 'AI / voice failures', value: ev.filter((e) => ['ai_model_error', 'assistant_unavailable', 'orchestrator_error', 'asr_low_confidence'].includes(e.event_type)).reduce((a, e) => a + e.n, 0), unit: 'count', n: sessions.length, definition: 'Count of model errors, assistant-unavailable fallbacks, orchestrator errors and low-confidence speech events.', extra: { byType: Object.fromEntries(ev.map((e) => [e.event_type, e.n])) } });
  metrics.push({ id: 'unresolved_ops', label: 'Unresolved operations', value: unresolvedOps.reduce((a, e) => a + e.n, 0), unit: 'count', n: sessions.length, definition: 'Operations currently Unknown, pending downstream confirmation, or awaiting human approval.', extra: { byStatus: Object.fromEntries(unresolvedOps.map((e) => [e.status, e.n])) } });

  // Stage timings
  const stage = (id: string, label: string, a: keyof SessionRow, b: keyof SessionRow, targetId: string, limit: number) => {
    const v = eligible.map((s) => secs(s[a] as string | null, s[b] as string | null)).filter((x): x is number => x != null && x >= 0);
    metrics.push({ id, label, value: r1(percentile(v, 90)), unit: 's', n: v.length, definition: `90th percentile of (${String(b)} − ${String(a)}) on eligible calls.`, targetId, extra: { pctWithinTarget: r1(pct(v.filter((x) => x <= limit).length, v.length)), median: r1(percentile(v, 50)) } });
  };
  stage('stage_retrieval', 'Parallel fact retrieval (p90)', 'retrieval_started_at', 'retrieval_completed_at', 'stage_retrieval', 120);
  stage('stage_proposal', 'Action proposal (p90)', 'retrieval_completed_at', 'proposal_at', 'stage_proposal', 120);
  stage('stage_execution', 'Action execution + case (p90)', 'consent_at', 'execution_completed_at', 'stage_execution', 150);
  const joins = handoffs.filter((h) => h.connected_at).map((h) => secs(h.requested_at, h.connected_at)!);
  metrics.push({ id: 'handoff_join', label: 'Agent join time after handoff (p90)', value: r1(percentile(joins, 90)), unit: 's', n: joins.length, definition: '90th percentile of (agent connected − handoff requested). Simulated agent desk.', targetId: 'handoff_join', extra: { pctWithin30s: r1(pct(joins.filter((x) => x <= 30).length, joins.length)) } });

  // Breakdowns for charts
  const byDay: Record<string, { calls: number; resolved: number; handedOff: number }> = {};
  for (const s of sessions) {
    const d = s.answered_at.slice(0, 10);
    byDay[d] ??= { calls: 0, resolved: 0, handedOff: 0 };
    byDay[d].calls++;
    if (s.outcome === 'resolved') byDay[d].resolved++;
    if (handedOffSessions.has(s.id)) byDay[d].handedOff++;
  }
  const byIssue = Object.keys(ISSUE_LABELS).map((k) => ({ issueType: k, label: ISSUE_LABELS[k], calls: sessions.filter((s) => s.issue_type === k).length }));
  const byOutcome = sessions.reduce<Record<string, number>>((acc, s) => ((acc[s.outcome ?? 'unknown'] = (acc[s.outcome ?? 'unknown'] ?? 0) + 1), acc), {});

  return {
    generatedAt: nowIso(),
    dataLabel: 'Demo / synthetic data',
    filters: f,
    origins: {
      seeded_illustrative: sessions.filter((s) => s.data_origin === 'seeded_illustrative').length,
      demo_session: sessions.filter((s) => s.data_origin === 'demo_session').length,
    },
    metrics,
    targets: PILOT_TARGETS,
    breakdowns: { byDay: Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b)).map(([day, v]) => ({ day, ...v })), byIssue, byOutcome },
  };
}
