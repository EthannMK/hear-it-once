/** Dashboard metric calculations against hand-built events with known answers. */
import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb } from '../helpers.ts';
import { run } from '../../src/db/db.ts';
import { computeKpis, percentile } from '../../src/reporting/kpi.ts';
import { seedIllustrativeHistory } from '../../src/db/seed-history.ts';

const T0 = Date.parse('2026-10-01T10:00:00Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

function session(id: string, o: Record<string, unknown>) {
  const row = {
    id, correlation_id: `C-${id}`, channel: 'text_simulator', data_origin: 'demo_session', state: 'ended', context_json: '{}', eligible: 1, verification_status: 'verified',
    answered_at: at(0), created_at: at(0), updated_at: at(0), ...o,
  };
  const cols = Object.keys(row);
  run(`INSERT INTO call_sessions (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, Object.values(row));
}
const metric = (k: ReturnType<typeof computeKpis>, id: string) => k.metrics.find((m) => m.id === id)!;

beforeEach(() => {
  freshDb();
  // Remove the S07 fixture's prior session so this dataset is exactly the rows below.
  run("DELETE FROM cases WHERE session_id IN (SELECT id FROM call_sessions WHERE scenario_id = 'S07-prior')");
  run("DELETE FROM call_sessions WHERE scenario_id = 'S07-prior'");
  // A: resolved lost card, block confirmed 30 s after verification, case before end, csat 5
  session('A', { customer_id: 'CUS-1001', issue_type: 'lost_stolen_card', outcome: 'resolved', resolution_status: 'resolved', verified_at: at(40), ended_at: at(200), case_created_at: at(45), csat: 5, retrieval_started_at: at(40), retrieval_completed_at: at(41), proposal_at: at(50), consent_at: at(60), execution_completed_at: at(70) });
  run("INSERT INTO action_operations (id, idempotency_key, action_type, session_id, customer_id, target_ref, params_json, params_hash, actor_type, actor_id, status, requested_at, completed_at, updated_at) VALUES ('OP-A','k1','block_card','A','CUS-1001','CRD-1001A','{}','h','customer_session','A','succeeded',?,?,?)", [at(65), at(70), at(70)]);
  // B: lost card, block FAILED → handed off after 20 s wait
  session('B', { customer_id: 'CUS-1002', issue_type: 'lost_stolen_card', outcome: 'handed_off', resolution_status: 'unresolved', handoff_reason: 'action_failed', verified_at: at(30), ended_at: at(400), case_created_at: at(35), csat: 2 });
  run("INSERT INTO action_operations (id, idempotency_key, action_type, session_id, customer_id, target_ref, params_json, params_hash, actor_type, actor_id, status, requested_at, updated_at) VALUES ('OP-B','k2','block_card','B','CUS-1002','CRD-1002A','{}','h','customer_session','B','failed',?,?)", [at(50), at(50)]);
  run("INSERT INTO handoffs (id, session_id, reason, brief_json, status, agent_id, requested_at, connected_at, completed_at, updated_at) VALUES ('H-B','B','action_failed','{}','completed','STF-AGENT-1',?,?,?,?)", [at(60), at(80), at(300), at(300)]);
  run('INSERT INTO hold_intervals (session_id, reason, started_at, ended_at) VALUES (?,?,?,?)', ['B', 'agent_queue', at(60), at(80)]);
  // C: fee query, resolved, same customer as A within 7 days?  No — different customer; repeat of D below.
  session('C', { customer_id: 'CUS-1005', issue_type: 'fee_query', outcome: 'resolved', resolution_status: 'resolved', verified_at: at(30), ended_at: at(150), case_created_at: at(160), issue_restatements: 1 });
  // D: same customer + same issue 2 days after C → repeat contact
  session('D', { customer_id: 'CUS-1005', issue_type: 'fee_query', outcome: 'ended_unresolved', resolution_status: 'unresolved', verified_at: at(172_830), answered_at: at(172_800), ended_at: at(173_000) });
  // E: abandoned, not eligible
  session('E', { eligible: 0, verification_status: 'not_started', outcome: 'abandoned', ended_at: at(20) });
  run("INSERT INTO qa_reviews (session_id, reviewer_id, action_correct, safety_incident, created_at) VALUES ('A','STF-QA-1',1,0,?), ('B','STF-QA-1',0,1,?)", [at(500), at(500)]);
});

describe('KPI calculations', () => {
  it('computes each metric from persisted rows with its sample size', () => {
    const k = computeKpis({ origin: 'all' });
    expect(metric(k, 'call_volume').value).toBe(5);
    expect(metric(k, 'eligible_volume').value).toBe(4);
    // AHT over eligible ended non-abandoned: A 200, B 400, C 150, D 200 → 237.5
    expect(metric(k, 'aht').value).toBe(237.5);
    // FCR: A, C resolved of 4 → 50%
    expect(metric(k, 'fcr')).toMatchObject({ value: 50, n: 4 });
    // Repeat: D repeats C → 1 of 4 verified eligible
    expect(metric(k, 'repeat_7d')).toMatchObject({ value: 25, n: 4 });
    // Repetition: C restated → 1/4
    expect(metric(k, 'repetition').value).toBe(25);
    // Block: A confirmed in 30 s (≤60), B failed → 50%, failures count against
    expect(metric(k, 'block_rate')).toMatchObject({ value: 50, n: 2 });
    expect(metric(k, 'block_rate').extra).toMatchObject({ medianSeconds: 30, failedOrUnknown: 1 });
    // Wait: B 20 s over 5 ended calls = 4 s mean
    expect(metric(k, 'wait_time').value).toBe(4);
    // Handoff rate 1/5
    expect(metric(k, 'handoff_rate').value).toBe(20);
    // Case before end: resolved A (45<200 ✓), C (160>150 ✗) → 50%
    expect(metric(k, 'case_before_end')).toMatchObject({ value: 50, n: 2 });
    // QA: 1 of 2 correct; one safety incident reported separately
    expect(metric(k, 'action_correctness')).toMatchObject({ value: 50, n: 2 });
    expect(metric(k, 'action_correctness').extra).toMatchObject({ safetyIncidents: 1 });
    expect(metric(k, 'csat').value).toBe(3.5);
    expect(metric(k, 'handoff_join').value).toBe(20);
    expect(metric(k, 'stage_retrieval').value).toBe(1);
  });
  it('applies filters (issue type, outcome, handoff reason, date)', () => {
    expect(metric(computeKpis({ origin: 'all', issueType: 'fee_query' }), 'call_volume').value).toBe(2);
    expect(metric(computeKpis({ origin: 'all', outcome: 'resolved' }), 'call_volume').value).toBe(2);
    expect(metric(computeKpis({ origin: 'all', handoffReason: 'action_failed' }), 'call_volume').value).toBe(1);
    expect(metric(computeKpis({ origin: 'all', from: at(100_000) }), 'call_volume').value).toBe(1);
  });
  it('separates illustrative seeded data from measured demo sessions; targets are never values', () => {
    seedIllustrativeHistory({ calls: 30 });
    const all = computeKpis({ origin: 'all' });
    expect(all.origins).toEqual({ seeded_illustrative: 30, demo_session: 5 });
    expect(metric(computeKpis({ origin: 'demo_session' }), 'call_volume').value).toBe(5);
    expect(all.dataLabel).toBe('Demo / synthetic data');
    expect(all.targets.find((t) => t.id === 'fcr')?.value).toBe(60);
    expect(metric(all, 'fcr').value).not.toBe(60); // never echoes the target
  });
  it('percentile helper', () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([], 90)).toBeNull();
  });
});
