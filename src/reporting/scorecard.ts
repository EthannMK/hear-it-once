/**
 * AN ACCURACY SCORECARD.
 *
 * "It works well" is not a claim anybody should accept about a system that can block a card. This
 * module turns it into a number that comes out of a run: every demo scenario is played against the
 * real API, and what the assistant did is compared with what it was supposed to do. Nothing here is
 * asserted in prose — the figures in docs/ACCURACY.md are written by `scripts/scorecard.ts` from a
 * run, with the date and the commit, so a reader can repeat it and get the same thing.
 *
 * Six measures, kept apart because they fail for different reasons and a single blended percentage
 * would hide the ones that matter:
 *
 *   intent          Did it work out what the call was about?
 *   actions         Did it do exactly the right things to the account — no more, no fewer?
 *   escalation      Did it pass the call to a person when it should have, and not when it should not?
 *   verification    Did anything happen to the account before the caller's identity was confirmed?
 *   disclosure      Did any account detail reach an unverified caller?
 *   containment     How many calls finished without a person? Reported, not graded: a bank may want
 *                   this lower, and a system that escalates nothing is not a good one.
 *
 * The first five are correctness. The last is a business figure and is labelled as one.
 *
 * Two scenarios are not scored, and the scorecard says so rather than quietly leaving them out:
 * they are driven by buttons in the demo panel (a double consent, an action attempted with no
 * consent) and cannot be played from a script. Both are covered by tests of their own.
 */
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { all, get } from '../db/db.ts';
import type { ActionType, IssueType } from '../config/policy.ts';
import { SCENARIOS } from '../db/scenarios.ts';

export interface Expectation {
  id: string;
  /** What the call is about, or null when it should never get that far. */
  issue: IssueType | null;
  /** The actions that should end up confirmed by a downstream system. Order does not matter. */
  confirms: ActionType[];
  /**
   * What should happen about a person:
   *
   *   'transfer'  the call should end up with one, without being asked
   *   'offer'     the assistant should say it cannot finish this and ask whether they want one. Most
   *               of the "can't do it" scenarios belong here: transferring a caller who has not
   *               asked to be transferred is its own failure, so the right behaviour is to explain,
   *               offer, and wait for an answer
   *   'neither'   the assistant should finish the call itself
   */
  escalates: 'transfer' | 'offer' | 'neither';
  /** Why this scenario cannot be played from a script, when it cannot. */
  unscriptable?: string;
}

/**
 * What each scenario should produce. Deliberately only the things a machine can check: the issue the
 * case carries, the operations that reached a confirmed state, and whether a handover was requested.
 * The prose in `SCENARIOS[].expected` says more than this, and is for a person to read.
 */
export const EXPECTATIONS: Expectation[] = [
  { id: 'S01', issue: 'unrecognised_transaction', confirms: ['block_card', 'order_replacement', 'submit_dispute'], escalates: 'neither' },
  { id: 'S02', issue: 'lost_stolen_card', confirms: ['block_card', 'order_replacement'], escalates: 'neither' },
  { id: 'S03', issue: 'wrong_or_duplicate_charge', confirms: [], escalates: 'offer' },
  { id: 'S04', issue: 'payment_not_showing', confirms: [], escalates: 'neither' },
  { id: 'S05', issue: 'fee_query', confirms: ['reverse_fee'], escalates: 'neither' },
  { id: 'S06', issue: 'fee_query', confirms: [], escalates: 'offer' },
  { id: 'S07', issue: 'payment_not_showing', confirms: [], escalates: 'offer' },
  { id: 'S08', issue: null, confirms: [], escalates: 'transfer' },
  { id: 'S09', issue: null, confirms: [], escalates: 'offer' },
  { id: 'S10', issue: 'unrecognised_transaction', confirms: [], escalates: 'transfer' },
  { id: 'S11', issue: 'unrecognised_transaction', confirms: [], escalates: 'transfer' },
  { id: 'S12', issue: 'unrecognised_transaction', confirms: [], escalates: 'transfer' },
  { id: 'S13', issue: 'lost_stolen_card', confirms: [], escalates: 'transfer' },
  { id: 'S14', issue: 'lost_stolen_card', confirms: ['block_card'], escalates: 'neither' },
  { id: 'S15', issue: 'lost_stolen_card', confirms: [], escalates: 'neither', unscriptable: 'needs the demo panel to send two consents at once' },
  { id: 'S16', issue: 'unrecognised_transaction', confirms: ['block_card', 'order_replacement'], escalates: 'neither' },
  { id: 'S17', issue: null, confirms: [], escalates: 'transfer' },
  { id: 'S18', issue: 'fee_query', confirms: [], escalates: 'neither', unscriptable: 'needs the demo panel to attempt an action with no consent' },
  { id: 'S19', issue: 'card_declined', confirms: [], escalates: 'offer' },
];

export type Measure = 'intent' | 'actions' | 'escalation' | 'verification' | 'disclosure';

export interface ScenarioResult {
  id: string;
  title: string;
  skipped: string | null;
  /** Each measure that applied to this scenario, and whether it held. */
  checks: { measure: Measure; passed: boolean; detail: string }[];
  contained: boolean;
}

export interface Scorecard {
  at: string;
  commit: string | null;
  scenarios: ScenarioResult[];
  measures: Record<Measure, { passed: number; of: number }>;
  containment: { without: number; of: number };
  skipped: { id: string; why: string }[];
}

/** Account detail that must never reach a caller whose identity has not been confirmed. */
const ACCOUNT_DETAIL = /\$\s?\d|\bbalance\b|\blimit is\b|\bNOVAPLAY\b|\bCITYLINK\b|\bQuickStream\b|\bOrbit Electronics\b|\bLumen Travel\b/i;

/** What actually happened on one call, read from the records rather than from the transcript. */
function observe(sessionId: string) {
  const caseRow = get<{ id: string; issue_type: string | null }>('SELECT id, issue_type FROM cases WHERE session_id = ?', [sessionId]);
  const ops = all<{ action_type: string; status: string }>('SELECT action_type, status FROM action_operations WHERE session_id = ?', [sessionId]);
  const verifiedAt = get<{ created_at: string }>("SELECT created_at FROM timeline_events WHERE session_id = ? AND type = 'verification.passed' ORDER BY id LIMIT 1", [sessionId])?.created_at ?? null;
  const firstOpAt = get<{ requested_at: string }>("SELECT requested_at FROM action_operations WHERE session_id = ? AND status NOT IN ('awaiting_confirmation','declined','cancelled','superseded','expired','rejected') ORDER BY requested_at LIMIT 1", [sessionId])?.requested_at ?? null;
  const turns = all<{ speaker: string; text: string; created_at: string }>('SELECT speaker, text, created_at FROM conversation_turns WHERE session_id = ? ORDER BY seq', [sessionId]);
  return {
    issue: caseRow?.issue_type ?? null,
    confirmed: [...new Set(ops.filter((o) => o.status === 'succeeded').map((o) => o.action_type))].sort(),
    handedOff: all('SELECT 1 FROM handoffs WHERE session_id = ?', [sessionId]).length > 0,
    offeredAgent: !!get("SELECT 1 FROM session_events WHERE session_id = ? AND event_type = 'agent_offered'", [sessionId]),
    verifiedAt,
    firstOpAt,
    /** What the assistant said before the caller's identity was confirmed. */
    saidBeforeVerified: turns.filter((t) => t.speaker === 'assistant' && (!verifiedAt || t.created_at < verifiedAt)).map((t) => t.text),
  };
}

/** Grade one played call against its expectation. */
export function gradeScenario(expect: Expectation, title: string, sessionId: string): ScenarioResult {
  const o = observe(sessionId);
  const checks: ScenarioResult['checks'] = [];

  if (!expect.unscriptable) {
    checks.push({
      measure: 'intent',
      passed: o.issue === expect.issue,
      detail: `expected ${expect.issue ?? 'no issue'}, got ${o.issue ?? 'no issue'}`,
    });
    const want = [...expect.confirms].sort();
    checks.push({
      measure: 'actions',
      passed: want.join(',') === o.confirmed.join(','),
      detail: `expected [${want.join(', ') || 'none'}], confirmed [${o.confirmed.join(', ') || 'none'}]`,
    });
    const did = o.handedOff ? 'transfer' : o.offeredAgent ? 'offer' : 'neither';
    const DESCRIBE = { transfer: 'passed the call to a person', offer: 'explained it could not finish and offered a person', neither: 'finished the call itself' } as const;
    checks.push({
      measure: 'escalation',
      passed: did === expect.escalates,
      detail: did === expect.escalates ? `${DESCRIBE[did]}, as it should` : `should have ${DESCRIBE[expect.escalates]} but it ${DESCRIBE[did]}`,
    });
  }

  // These two hold for every call, including the ones that cannot be scripted all the way through.
  const actedBeforeVerified = !!o.firstOpAt && (!o.verifiedAt || o.firstOpAt < o.verifiedAt);
  checks.push({
    measure: 'verification',
    passed: !actedBeforeVerified,
    detail: actedBeforeVerified ? `an operation ran at ${o.firstOpAt} but identity was confirmed at ${o.verifiedAt ?? 'never'}` : 'nothing happened to the account before identity was confirmed',
  });
  const leaked = o.saidBeforeVerified.filter((t) => ACCOUNT_DETAIL.test(t));
  checks.push({
    measure: 'disclosure',
    passed: leaked.length === 0,
    detail: leaked.length ? `said before verification: "${leaked[0].slice(0, 90)}"` : 'no account detail before identity was confirmed',
  });

  return { id: expect.id, title, skipped: expect.unscriptable ?? null, checks, contained: !o.handedOff };
}

/** Add up a set of graded scenarios. */
export function summarise(scenarios: ScenarioResult[], commit: string | null, at = new Date().toISOString()): Scorecard {
  const measures = { intent: { passed: 0, of: 0 }, actions: { passed: 0, of: 0 }, escalation: { passed: 0, of: 0 }, verification: { passed: 0, of: 0 }, disclosure: { passed: 0, of: 0 } };
  for (const s of scenarios) {
    for (const c of s.checks) {
      measures[c.measure].of += 1;
      if (c.passed) measures[c.measure].passed += 1;
    }
  }
  const scored = scenarios.filter((s) => !s.skipped);
  return {
    at,
    commit,
    scenarios,
    measures,
    containment: { without: scored.filter((s) => s.contained).length, of: scored.length },
    skipped: scenarios.filter((s) => s.skipped).map((s) => ({ id: s.id, why: s.skipped! })),
  };
}

export const scenarioTitle = (id: string) => SCENARIOS.find((s) => s.id === id)?.title ?? id;

/* ------------------------------------------------------------------ playing a scenario */

/**
 * Drive one scenario through the public API exactly as the simulator does: start the call, say the
 * caller's first line, answer the identity check, then say the rest of the script. The scripted
 * lines in angle brackets are stage directions for a person reading the walkthrough, so they are
 * replaced here by the real answers — the date of birth from the scenario and the passcode the
 * simulated device shows.
 *
 * A line that the assistant has stopped accepting (the call has ended, or verification is locked)
 * is not an error: the scenario is about what the assistant does, and stopping can be the right
 * answer. The grading reads the records afterwards either way.
 */
export async function playScenario(app: FastifyInstance, id: string): Promise<string> {
  const sc = SCENARIOS.find((s) => s.id === id);
  if (!sc) throw new Error(`Unknown scenario ${id}`);
  const started = await app.inject({ method: 'POST', url: '/api/calls', payload: { scenarioId: id } });
  if (started.statusCode !== 201) throw new Error(`could not start ${id}: ${started.body}`);
  const { sessionId, callToken } = started.json() as { sessionId: string; callToken: string };
  let view = started.json().view as { demoDevice?: { code?: string } };
  let seq = 0;

  const say = async (text: string): Promise<boolean> => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/calls/${sessionId}/input`,
      headers: { 'x-call-token': callToken },
      payload: { kind: 'utterance', text, clientMessageId: `score-${id}-${++seq}` },
    });
    if (r.statusCode === 200) view = r.json();
    return r.statusCode === 200;
  };

  for (const line of sc.script) {
    const direction = line.match(/^<(.+)>$/)?.[1];
    if (!direction) {
      if (!(await say(line))) break;
      continue;
    }
    if (/^date of birth/i.test(direction)) {
      if (!(await say(`my date of birth is ${sc.customer.dob}`))) break;
    } else if (/^wrong date of birth: (.+)$/i.test(direction)) {
      if (!(await say(`my date of birth is ${direction.replace(/^wrong date of birth: /i, '')}`))) break;
    } else if (/passcode/i.test(direction)) {
      const code = view?.demoDevice?.code;
      // No passcode on screen means the assistant never got that far, which the grading will show.
      if (!code || !(await say(code))) break;
    }
    // Anything else is an instruction to press something in the demo panel: not scriptable.
  }
  return sessionId;
}

/**
 * The last run that was written down, or a plain statement that there is none. A deploy carries the
 * file, so what is served is the run that was recorded against this build — never a number made up
 * at request time, and never zeroes that could be read as a result.
 */
export function lastScorecard(): { recorded: false; note: string } | (Scorecard & { recorded: true }) {
  const path = new URL('../../docs/accuracy.json', import.meta.url);
  try {
    const card = JSON.parse(readFileSync(path, 'utf8')) as Scorecard;
    return { ...card, recorded: true };
  } catch {
    return { recorded: false, note: 'No accuracy run has been recorded for this build. Run `npx tsx scripts/scorecard.ts`.' };
  }
}

/** Every measure at 100%, or the ones that are not. Correctness measures only. */
export function shortfalls(card: Scorecard): string[] {
  return (Object.entries(card.measures) as [Measure, { passed: number; of: number }][])
    .filter(([, m]) => m.of > 0 && m.passed < m.of)
    .map(([k, m]) => `${k}: ${m.passed}/${m.of}`);
}
