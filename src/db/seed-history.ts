/**
 * SEEDED ILLUSTRATIVE HISTORY for the operations dashboard.
 *
 * Deterministic (fixed-seed PRNG) synthetic call history over the last 28 days, written as
 * ordinary persisted events (sessions, cases, operations, handoffs, holds, integration
 * calls, QA reviews) so the KPI engine computes from rows exactly as it does for live demo
 * calls. Every row is labelled data_origin = 'seeded_illustrative'. These numbers are
 * invented and must never be read as measured performance.
 */
import { run, tx } from './db.ts';
import { nowMs } from '../lib/clock.ts';
import { insertCard, insertCustomer, insertTxn } from './seed.ts';

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Jamie', 'Morgan', 'Riley', 'Casey', 'Avery', 'Quinn', 'Rowan', 'Harper', 'Elliot', 'Sasha', 'Noor', 'Kai', 'Imani', 'Mateo', 'Yuki', 'Aditya', 'Freya', 'Tomas', 'Leila', 'Owen'];
const LAST = ['Park', 'Silva', 'Novak', 'Okoye', 'Larsen', 'Reyes', 'Haddad', 'Moreau', 'Ito', 'Kowalski', 'Mensah', 'Byrne', 'Costa', 'Lindqvist', 'Rahman', 'Duarte', 'Fischer', 'Walsh', 'Ng', 'Adeyemi'];

type Issue = 'unrecognised_transaction' | 'lost_stolen_card' | 'wrong_or_duplicate_charge' | 'payment_not_showing' | 'fee_query';

export function seedIllustrativeHistory(opts: { days?: number; calls?: number; seed?: number } = {}): void {
  const rnd = mulberry32(opts.seed ?? 20261013);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
  const between = (a: number, b: number) => a + rnd() * (b - a);
  const chance = (p: number) => rnd() < p;
  const days = opts.days ?? 28;
  const callCount = opts.calls ?? 220;
  const now = nowMs();
  const iso = (ms: number) => new Date(ms).toISOString();
  let n = 0;
  const id = (p: string) => `${p}-IL${String(++n).padStart(6, '0')}`;

  tx(() => {
    // Background synthetic customers (not tied to any demo scenario).
    const customers: { id: string; card: string }[] = [];
    for (let i = 0; i < 48; i++) {
      const custId = `CUS-BG${String(i).padStart(3, '0')}`;
      insertCustomer({ id: custId, number: `4009${String(i).padStart(4, '0')}`, name: `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`, dob: `19${60 + (i % 35)}-0${1 + (i % 9)}-1${i % 9}`, phone: `+1 (555) 019-${String(1000 + i).slice(-4)}` });
      const card = `CRD-BG${String(i).padStart(3, '0')}`;
      insertCard(card, custId, String(5000 + i * 13).slice(-4), 'Synthetic', { network: i % 2 ? 'Visa' : 'Mastercard' });
      customers.push({ id: custId, card });
    }

    const issueWeights: [Issue | null, number][] = [
      ['unrecognised_transaction', 0.3],
      ['lost_stolen_card', 0.2],
      ['wrong_or_duplicate_charge', 0.12],
      ['payment_not_showing', 0.18],
      ['fee_query', 0.15],
      [null, 0.05],
    ];
    const pickIssue = () => {
      let r = rnd();
      for (const [k, w] of issueWeights) if ((r -= w) <= 0) return k;
      return null;
    };
    const lastCall = new Map<string, { at: number; issue: Issue }>();

    for (let c = 0; c < callCount; c++) {
      const sid = id('SES');
      // Repeat contacts: ~9% of calls are a same-issue follow-up within 7 days.
      let cust = pick(customers);
      let issue = pickIssue();
      let start = now - between(0.05, days) * 86_400_000;
      const prev = [...lastCall.entries()].find(([, v]) => now - v.at > 2 * 86_400_000);
      if (prev && chance(0.09)) {
        cust = customers.find((x) => x.id === prev[0])!;
        issue = prev[1].issue;
        start = Math.min(now - 3600_000, prev[1].at + between(0.5, 6.5) * 86_400_000);
      }
      const hour = Math.floor(between(8, 21));
      const d = new Date(start);
      d.setUTCHours(hour, Math.floor(between(0, 59)), Math.floor(between(0, 59)), 0);
      start = Math.min(d.getTime(), now - 600_000);

      const t = { answered: start } as Record<string, number>;
      let clock = start + between(8, 35) * 1000;
      const issueCaptured = issue ? clock : null;
      const verified = issue ? chance(0.94) : false;
      let outcome = 'resolved';
      let resolution: string | null = 'resolved';
      let handoffReason: string | null = null;
      const restated = chance(0.03) ? 1 : 0;
      const events: [string, number][] = [];
      if (restated) events.push(['issue_restatement_requested', clock]);
      if (chance(0.04)) events.push(['asr_low_confidence', clock]);

      if (!issue) {
        outcome = chance(0.7) ? 'handed_off' : 'abandoned';
        handoffReason = outcome === 'handed_off' ? pick(['ai_uncertain', 'out_of_policy', 'customer_requested']) : null;
        resolution = null;
      } else if (!verified) {
        outcome = 'handed_off';
        handoffReason = 'verification_failed';
        resolution = null;
        clock += between(60, 140) * 1000;
      } else {
        t.verified = clock += between(35, 80) * 1000;
        t.retrievalStart = clock;
        t.retrievalEnd = clock += between(0.12, 1.8) * 1000;
        const r = rnd();
        if (r < 0.03) {
          outcome = 'handed_off';
          handoffReason = pick(['system_unavailable', 'conflicting_data']);
          resolution = null;
        } else if (r < 0.2) {
          outcome = 'handed_off';
          handoffReason = pick(['customer_requested', 'customer_accepted_offer', 'out_of_policy', 'out_of_policy', 'communication_breakdown']);
          resolution = 'unresolved';
        } else if (r < 0.215) {
          outcome = 'fallback';
          handoffReason = 'assistant_unavailable';
          resolution = null;
          events.push(['assistant_unavailable', clock]);
        } else if (r < 0.24) {
          outcome = 'abandoned';
          resolution = null;
        } else if (issue === 'payment_not_showing' || (issue === 'wrong_or_duplicate_charge' && chance(0.5))) {
          resolution = 'informational';
        }
        t.proposal = clock += between(8, 50) * 1000;
      }

      run(
        `INSERT INTO call_sessions (id, correlation_id, channel, data_origin, state, issue_type, issue_statement, customer_id, verification_status, verification_level, eligible, outcome, resolution_status,
           handoff_reason, issue_restatements, mood_start, csat, answered_at, issue_captured_at, verified_at, retrieval_started_at, retrieval_completed_at, created_at, updated_at)
         VALUES (?,?, 'telephony', 'seeded_illustrative', 'ended', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sid, id('COR'), issue, issue ? '[seeded illustrative call — no transcript]' : null, verified ? cust.id : null, verified ? 'verified' : issue ? 'failed' : 'not_started', verified ? 'standard' : null,
          issue ? 1 : 0, outcome, resolution, handoffReason, restated, pick(['calm', 'calm', 'worried', 'frustrated', 'upset']), null,
          iso(t.answered), issueCaptured ? iso(issueCaptured) : null, t.verified ? iso(t.verified) : null, t.retrievalStart ? iso(t.retrievalStart) : null, t.retrievalEnd ? iso(t.retrievalEnd) : null, iso(t.answered), iso(t.answered),
        ],
      );
      for (const [e, at] of events) run('INSERT INTO session_events (session_id, event_type, detail_json, created_at) VALUES (?,?,?,?)', [sid, e, '{"seeded":true}', iso(at)]);

      // Integration calls (6 parallel reads) for verified calls.
      if (verified && t.retrievalStart) {
        const srcs = issue === 'payment_not_showing' ? ['customer_profile', 'card_status', 'transactions', 'fraud_alerts', 'prior_cases', 'payment_status'] : issue === 'fee_query' ? ['customer_profile', 'card_status', 'transactions', 'fraud_alerts', 'prior_cases', 'fee_policy'] : ['customer_profile', 'card_status', 'transactions', 'fraud_alerts', 'prior_cases', 'dispute_rules'];
        for (const s of srcs) {
          const fail = chance(0.015);
          run(
            `INSERT INTO integration_calls (session_id, correlation_id, source, operation, direction, status, latency_ms, attempts, started_at, data_origin) VALUES (?, 'seed', ?, 'read', 'read', ?, ?, ?, ?, 'seeded_illustrative')`,
            [sid, s, fail ? pick(['timeout', 'unavailable', 'error']) : 'ok', Math.round(fail ? between(800, 1500) : Math.exp(between(Math.log(35), Math.log(420)))), fail ? 2 : 1, iso(t.retrievalStart)],
          );
        }
      }

      // Case created during the call for every verified or handed-off call.
      let caseId: string | null = null;
      if (issue || handoffReason) {
        caseId = id('CASE');
        const caseAt = t.verified ? t.verified + 2000 : clock;
        run(
          `INSERT INTO cases (id, session_id, customer_id, issue_type, status, resolution_status, verification_outcome, summary, data_origin, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?, 'seeded_illustrative', ?, ?)`,
          [caseId, sid, verified ? cust.id : null, issue, outcome === 'resolved' ? 'resolved' : 'pending', resolution, verified ? 'verified' : 'not_verified', 'Seeded illustrative case — synthetic.', iso(caseAt), iso(caseAt)],
        );
        run('UPDATE call_sessions SET case_created_at = ? WHERE id = ?', [iso(caseAt), sid]);
      }

      // Actions for resolved / partially handled verified calls.
      const ops: { type: string; target: string; status: string; at: number }[] = [];
      if (verified && t.proposal && outcome !== 'abandoned' && outcome !== 'fallback') {
        const consentAt = (clock += between(6, 30) * 1000);
        run('UPDATE call_sessions SET proposal_at = ?, consent_at = ? WHERE id = ?', [iso(t.proposal), iso(consentAt), sid]);
        if (issue === 'lost_stolen_card' || (issue === 'unrecognised_transaction' && outcome === 'resolved')) {
          const r = rnd();
          const blockStatus = r < 0.03 ? 'failed' : r < 0.045 ? 'unknown' : 'succeeded';
          // Most blocks land quickly after verification; a tail is slower.
          const blockAt = t.verified! + (chance(0.92) ? between(12, 55) : between(61, 140)) * 1000;
          clock = Math.max(clock, blockAt);
          ops.push({ type: 'block_card', target: cust.card, status: blockStatus, at: blockAt });
          if (blockStatus === 'failed') {
            outcome = 'handed_off';
            handoffReason = 'action_failed';
            resolution = 'unresolved';
          } else {
            ops.push({ type: 'order_replacement', target: cust.card, status: 'succeeded', at: (clock += between(2, 6) * 1000) });
          }
          if (issue === 'unrecognised_transaction' && blockStatus === 'succeeded') ops.push({ type: 'submit_dispute', target: 'TXN', status: chance(0.06) ? 'submitted' : 'succeeded', at: (clock += between(2, 6) * 1000) });
        }
        if (issue === 'fee_query' && outcome === 'resolved') ops.push({ type: 'reverse_fee', target: 'FEE', status: 'succeeded', at: (clock += between(2, 6) * 1000) });
        if (ops.length) run('UPDATE call_sessions SET execution_completed_at = ? WHERE id = ?', [iso(clock), sid]);
      }
      for (const o of ops) {
        const opId = id('OP');
        let target = o.target;
        if (o.type === 'submit_dispute') {
          target = insertTxn(cust.id, { card: cust.card, merchant: pick(['GLOBEX STREAMING', 'NIGHTOWL GAMES', 'SKYLINE TICKETS', 'PIXELMART']), amount: Math.round(between(1500, 60000)), daysAgo: Math.max(1, (now - o.at) / 86_400_000 + between(1, 5)), mode: 'ecommerce' });
          run(
            `INSERT INTO disputes (id, case_id, session_id, customer_id, card_id, transaction_id, merchant, amount_minor, currency, txn_date, reason_code, rule_code, status, rework_required, downstream_status, data_origin, created_at, updated_at)
             VALUES (?,?,?,?,?,?, 'SEEDED MERCHANT', 0, 'USD', ?, 'fraud_unrecognised', 'DR-FRAUD-01', ?, ?, ?, 'seeded_illustrative', ?, ?)`,
            [id('DSP'), caseId, sid, cust.id, cust.card, target, iso(o.at).slice(0, 10), o.status === 'succeeded' ? 'submitted' : 'pending', o.status === 'succeeded' ? (chance(0.08) ? 1 : 0) : null, o.status === 'succeeded' ? 'simulated_review_complete' : null, iso(o.at), iso(o.at)],
          );
        }
        run(
          `INSERT INTO action_operations (id, idempotency_key, action_type, session_id, case_id, customer_id, target_ref, params_json, params_hash, actor_type, actor_id, status, external_ref, attempts, requested_at, submitted_at, completed_at, data_origin, updated_at)
           VALUES (?,?,?,?,?,?,?, '{}', 'seed', 'customer_session', ?, ?, ?, 1, ?, ?, ?, 'seeded_illustrative', ?)`,
          [opId, `seed:${opId}`, o.type, sid, caseId, cust.id, target, sid, o.status, o.status === 'succeeded' ? `SEED-${opId.slice(-6)}` : null, iso(o.at - 1500), iso(o.at - 1200), o.status === 'succeeded' || o.status === 'failed' ? iso(o.at) : null, iso(o.at)],
        );
      }

      // Handoff with recorded queue wait.
      if (handoffReason) {
        const reqAt = (clock += between(3, 10) * 1000);
        const answered = chance(0.95);
        const wait = chance(0.85) ? between(6, 45) : between(46, 150);
        const conn = reqAt + wait * 1000;
        const doneAt = conn + between(90, 420) * 1000;
        run(
          `INSERT INTO handoffs (id, session_id, case_id, reason, brief_json, status, agent_id, requested_at, connected_at, completed_at, outcome, customer_repeated_issue, fallback, data_origin, updated_at)
           VALUES (?,?,?,?, '{"seeded":true}', ?, ?, ?, ?, ?, ?, ?, ?, 'seeded_illustrative', ?)`,
          [id('HND'), sid, caseId, handoffReason, answered ? 'completed' : 'no_agent', answered ? pick(['STF-AGENT-1', 'STF-AGENT-2']) : null, iso(reqAt), answered ? iso(conn) : null, answered ? iso(doneAt) : null, answered ? pick(['resolved', 'resolved', 'follow_up_required']) : null, answered && chance(0.04) ? 1 : 0, answered ? null : 'callback_requested', iso(doneAt)],
        );
        if (answered) {
          run('INSERT INTO hold_intervals (session_id, reason, started_at, ended_at) VALUES (?, ?, ?, ?)', [sid, 'agent_queue', iso(reqAt), iso(conn)]);
          run('UPDATE call_sessions SET handoff_requested_at = ?, agent_joined_at = ? WHERE id = ?', [iso(reqAt), iso(conn), sid]);
          clock = doneAt;
        } else {
          run('UPDATE call_sessions SET handoff_requested_at = ? WHERE id = ?', [iso(reqAt), sid]);
          outcome = 'ended_unresolved';
        }
      }

      const ended = (clock += between(15, 70) * 1000);
      const unknownOp = ops.some((o) => o.status === 'unknown');
      if (outcome === 'resolved' && (unknownOp || !resolution)) outcome = 'ended_unresolved';
      run('UPDATE call_sessions SET outcome = ?, resolution_status = ?, handoff_reason = ?, ended_at = ?, csat = ?, mood_end = ? WHERE id = ?', [
        outcome, resolution, handoffReason, iso(Math.min(ended, now - 60_000)), chance(0.6) ? Math.max(1, Math.min(5, Math.round(between(outcome === 'resolved' ? 3.4 : 2, 5.4)))) : null,
        pick(outcome === 'resolved' ? ['calm', 'calm', 'relieved'] : ['calm', 'frustrated', 'worried']), sid,
      ]);

      // QA sample: ~30% of calls with consequential actions.
      if (ops.length && chance(0.3)) {
        run(
          `INSERT INTO qa_reviews (session_id, reviewer_id, in_sample, action_correct, safety_incident, customer_repeated_issue, score, notes, data_origin, created_at) VALUES (?, 'STF-QA-1', 1, ?, 0, 0, ?, 'Seeded illustrative review', 'seeded_illustrative', ?)`,
          [sid, chance(0.96) ? 1 : 0, Math.round(between(78, 100)), iso(Math.min(now - 60_000, ended + 86_400_000 * between(0.2, 1)))],
        );
      }
      if (issue && verified) lastCall.set(cust.id, { at: start, issue });
    }
    run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('history_seeded', ?)", [String(callCount)]);
  });
}
