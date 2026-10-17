/**
 * THE SCORECARD ITSELF.
 *
 * The figures in docs/ACCURACY.md are only worth reading if the thing that produced them works, so
 * these tests check the grader rather than the assistant: that it plays a scenario through the real
 * API, that it marks a wrong answer as wrong, and that the two rules which hold on every call are
 * checked even for the scenarios that cannot be scripted to the end.
 *
 * A measure that cannot fail is not a measure, so most of this is about making it fail.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { setup, staffLogin } from './harness.ts';
import { EXPECTATIONS, gradeScenario, playScenario, scenarioTitle, summarise, shortfalls, lastScorecard, type Expectation } from '../../src/reporting/scorecard.ts';
import { SCENARIOS } from '../../src/db/scenarios.ts';

let app: FastifyInstance;
beforeEach(async () => { app = await setup(); });
afterEach(async () => { await app.close(); });

const expectationFor = (id: string) => EXPECTATIONS.find((e) => e.id === id)!;

describe('playing a scenario', () => {
  it('drives a whole call: verification happens and the issue is captured', async () => {
    const sessionId = await playScenario(app, 'S05');
    const r = gradeScenario(expectationFor('S05'), scenarioTitle('S05'), sessionId);
    expect(r.checks.every((c) => c.passed)).toBe(true);
  });

  it('refuses a scenario id it does not know', async () => {
    await expect(playScenario(app, 'S99')).rejects.toThrow(/Unknown scenario/);
  });

  it('there is an expectation for every scenario, and nothing extra', () => {
    expect(EXPECTATIONS.map((e) => e.id).sort()).toEqual(SCENARIOS.map((s) => s.id).sort());
  });
});

describe('the grader can fail', () => {
  it('marks the wrong issue as wrong', async () => {
    const sessionId = await playScenario(app, 'S05');
    const wrong: Expectation = { ...expectationFor('S05'), issue: 'lost_stolen_card' };
    const r = gradeScenario(wrong, 'S05', sessionId);
    const intent = r.checks.find((c) => c.measure === 'intent')!;
    expect(intent.passed).toBe(false);
    expect(intent.detail).toMatch(/expected lost_stolen_card, got fee_query/);
  });

  it('marks a missing action as wrong, and an extra one too', async () => {
    const sessionId = await playScenario(app, 'S05');
    const tooMany = gradeScenario({ ...expectationFor('S05'), confirms: ['reverse_fee', 'block_card'] }, 'S05', sessionId);
    expect(tooMany.checks.find((c) => c.measure === 'actions')!.passed).toBe(false);
    const tooFew = gradeScenario({ ...expectationFor('S05'), confirms: [] }, 'S05', sessionId);
    expect(tooFew.checks.find((c) => c.measure === 'actions')!.passed).toBe(false);
  });

  it('tells a transfer apart from an offer, and both from neither', async () => {
    const sessionId = await playScenario(app, 'S08'); // asks for a person straight away
    expect(gradeScenario({ ...expectationFor('S08'), escalates: 'transfer' }, 'S08', sessionId).checks.find((c) => c.measure === 'escalation')!.passed).toBe(true);
    for (const wrong of ['offer', 'neither'] as const) {
      const r = gradeScenario({ ...expectationFor('S08'), escalates: wrong }, 'S08', sessionId);
      expect(r.checks.find((c) => c.measure === 'escalation')!.passed, wrong).toBe(false);
    }
  });

  it('an offer counts as an offer, not as a transfer', async () => {
    const sessionId = await playScenario(app, 'S06'); // ineligible fee: explains, then offers
    const r = gradeScenario(expectationFor('S06'), 'S06', sessionId);
    expect(r.checks.find((c) => c.measure === 'escalation')!.passed).toBe(true);
    expect(r.contained).toBe(true); // offered, not transferred
  });
});

describe('the two rules that hold on every call', () => {
  it('are checked even for a scenario that cannot be scripted to the end', async () => {
    const sessionId = await playScenario(app, 'S15');
    const r = gradeScenario(expectationFor('S15'), 'S15', sessionId);
    expect(r.skipped).toBeTruthy();
    expect(r.checks.map((c) => c.measure).sort()).toEqual(['disclosure', 'verification']);
  });

  it('would catch an operation that ran before identity was confirmed', async () => {
    const sessionId = await playScenario(app, 'S01');
    const { all, run, get } = await import('../../src/db/db.ts');
    const verifiedAt = get<{ created_at: string }>("SELECT created_at FROM timeline_events WHERE session_id = ? AND type = 'verification.passed' LIMIT 1", [sessionId])!.created_at;
    expect(gradeScenario(expectationFor('S01'), 'S01', sessionId).checks.find((c) => c.measure === 'verification')!.passed).toBe(true);
    // Move the first operation to before the identity check and the measure must notice.
    const op = all<{ id: string }>('SELECT id FROM action_operations WHERE session_id = ? ORDER BY requested_at LIMIT 1', [sessionId])[0];
    run('UPDATE action_operations SET requested_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', op.id]);
    expect(verifiedAt > '2000-01-01T00:00:00.000Z').toBe(true);
    const after = gradeScenario(expectationFor('S01'), 'S01', sessionId).checks.find((c) => c.measure === 'verification')!;
    expect(after.passed).toBe(false);
    expect(after.detail).toMatch(/before identity|confirmed at/);
  });

  it('would catch an account detail said before the identity check', async () => {
    const sessionId = await playScenario(app, 'S01');
    const { run } = await import('../../src/db/db.ts');
    run("INSERT INTO conversation_turns (session_id, seq, speaker, text, created_at) VALUES (?, 0, 'assistant', ?, '2000-01-01T00:00:00.000Z')", [sessionId, 'Your balance is $1,204.33.']);
    const r = gradeScenario(expectationFor('S01'), 'S01', sessionId).checks.find((c) => c.measure === 'disclosure')!;
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/balance/);
  });
});

describe('the summary', () => {
  it('counts each measure separately rather than blending them', async () => {
    const a = gradeScenario(expectationFor('S05'), 'a', await playScenario(app, 'S05'));
    const b = gradeScenario({ ...expectationFor('S06'), issue: 'lost_stolen_card' }, 'b', await playScenario(app, 'S06'));
    const card = summarise([a, b], 'abc1234');
    expect(card.measures.intent).toEqual({ passed: 1, of: 2 });
    expect(card.measures.verification).toEqual({ passed: 2, of: 2 });
    expect(shortfalls(card)).toEqual(['intent: 1/2']);
    expect(card.commit).toBe('abc1234');
  });

  it('keeps the unscored scenarios visible instead of dropping them', async () => {
    const s = gradeScenario(expectationFor('S18'), 'S18', await playScenario(app, 'S18'));
    const card = summarise([s], null);
    expect(card.skipped).toHaveLength(1);
    expect(card.skipped[0].why).toMatch(/demo panel/);
    expect(card.containment.of).toBe(0);
  });

  it('containment is reported, and is not one of the graded measures', async () => {
    const s = gradeScenario(expectationFor('S08'), 'S08', await playScenario(app, 'S08'));
    const card = summarise([s], null);
    expect(card.containment).toEqual({ without: 0, of: 1 });
    expect(Object.keys(card.measures)).not.toContain('containment');
  });
});

describe('the recorded run', () => {
  it('is served to whoever may read policy, and carries its date and commit', async () => {
    const cookie = await staffLogin(app, 'STF-QA-1');
    const r = await app.inject({ method: 'GET', url: '/api/scorecard', headers: { cookie } });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    if (b.recorded) {
      expect(b.at).toMatch(/^\d{4}-\d{2}-\d{2}/);
      expect(b.measures.verification.of).toBeGreaterThan(0);
    } else {
      expect(b.note).toMatch(/No accuracy run/);
    }
  });

  it('needs a staff session', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/scorecard' });
    expect([401, 403]).toContain(r.statusCode);
  });

  it('says so plainly when there is no run, rather than returning zeroes', () => {
    const card = lastScorecard();
    // Whichever it is, it must be readable as one or the other and never as an empty result.
    if (!card.recorded) expect(card.note).toMatch(/No accuracy run/);
    else expect(card.scenarios.length).toBeGreaterThan(0);
  });
});
