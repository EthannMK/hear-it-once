/**
 * GENERATED CONVERSATIONS. Random but seeded sequences of customer actions (general questions,
 * acknowledgements, corrections, interruptions, injection attempts, duplicates, and so on) are played
 * against the real back end, and the invariants in invariants.ts are checked on every one.
 *
 * Run:      npx vitest run tests/fuzz
 * More:     FUZZ_RUNS=500 npx vitest run tests/fuzz
 * Replay:   FUZZ_ONLY=20261015 npx vitest run tests/fuzz     (a seed printed by a failure)
 * Failures are saved to tests/fuzz/failures/seed-<n>.json with the actions, transcript, timeline and handoffs.
 * Typed path with rule-based intent. Real Gemini voice and the Gemini intent model are not reachable from tests.
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setup } from '../e2e/harness.ts';
import { rng } from './rng.ts';
import { randomSequence, verifiedPrefix } from './library.ts';
import { play, type Trace } from './run.ts';
import { check, type Violation } from './invariants.ts';

const BASE = Number(process.env.FUZZ_SEED ?? 20261015);
const RUNS = Number(process.env.FUZZ_RUNS ?? 60);
const ONLY = process.env.FUZZ_ONLY ? Number(process.env.FUZZ_ONLY) : null;
const seeds = ONLY != null ? [ONLY] : Array.from({ length: RUNS }, (_, i) => BASE + i);

const results: { seed: number; trace: Trace; violations: Violation[] }[] = [];

function save(seed: number, trace: Trace, violations: Violation[]) {
  mkdirSync('tests/fuzz/failures', { recursive: true });
  writeFileSync(`tests/fuzz/failures/seed-${seed}.json`, JSON.stringify({ seed, violations, actions: trace.actions, transcript: trace.transcript, timeline: trace.timeline, handoffs: trace.handoffs }, null, 2));
}

describe('generated conversations keep every invariant', () => {
  it(`plays ${seeds.length} seeded sequences`, async () => {
    for (const seed of seeds) {
      const app = await setup();
      try {
        const trace = await play(app, seed, randomSequence(rng(seed)));
        const violations = check(trace);
        results.push({ seed, trace, violations });
        if (violations.length) save(seed, trace, violations);
      } finally { await app.close(); }
    }
    const bad = results.filter((r) => r.violations.length);
    const msg = bad.slice(0, 5).map((r) => `seed ${r.seed}: ${r.violations.map((x) => `${x.rule} (turn ${x.turn}: ${x.detail})`).join('; ')}\n   steps: ${r.trace.actions.map((a) => `[${a.kind}] ${a.text}`).join(' | ')}\n   replay: FUZZ_ONLY=${r.seed} npx vitest run tests/fuzz`).join('\n');
    expect(bad.length, `${bad.length} of ${results.length} sequences broke an invariant:\n${msg}`).toBe(0);
  }, 300_000);

  it('after verification, unrelated turns trigger no new verification, queries, cases or operations', async () => {
    const n = Math.max(20, Math.floor(RUNS / 3));
    for (let i = 0; i < n; i++) {
      const seed = BASE + 100_000 + i;
      const app = await setup();
      try {
        const trace = await play(app, seed, [...verifiedPrefix(), ...randomSequence(rng(seed)).slice(0, 4)]);
        const violations = check(trace);
        results.push({ seed, trace, violations });
        if (violations.length) save(seed, trace, violations);
      } finally { await app.close(); }
    }
    const bad = results.filter((r) => r.seed >= BASE + 100_000 && r.violations.length);
    const msg = bad.slice(0, 5).map((r) => `seed ${r.seed}: ${r.violations.map((x) => `${x.rule} (${x.detail})`).join('; ')}\n   steps: ${r.trace.actions.map((a) => `[${a.kind}] ${a.text}`).join(' | ')}`).join('\n');
    expect(bad.length, `${bad.length} verified-path sequences broke an invariant:\n${msg}`).toBe(0);
  }, 300_000);

  it('writes the metrics report', () => {
    const n = results.length || 1;
    const count = (rule: string) => results.filter((r) => r.violations.some((v) => v.rule === rule)).length;
    const pct = (k: number) => `${((k / n) * 100).toFixed(1)}%`;
    const rate = (rules: string[]) => pct(results.filter((r) => r.violations.some((v) => rules.includes(v.rule))).length);
    const lines = [
      '# Fuzz metrics', '', `Sequences: ${results.length}. Base seed: ${BASE}.`, '',
      '| Metric | Rate | Target |', '| --- | --- | --- |',
      `| Unnecessary authentication | ${rate(['unnecessary-verification', 'card-number-requested-for-faq'])} | 0% |`,
      `| Premature escalation | ${rate(['premature-escalation'])} | 0% |`,
      `| Duplicate response | ${rate(['duplicate-message', 'repeated-message', 'duplicate-event', 'duplicate-handoff', 'duplicate-handoff-message'])} | 0% |`,
      `| Unintended or unauthorised operation | ${rate(['unauthorised-operation'])} | 0% |`,
      `| Sensitive data leakage | ${rate(['card-in-transcript', 'data-before-verification'])} | 0% |`,
      `| Unconfirmed transfer or queue claim | ${rate(['unconfirmed-queue-claim', 'transfer-claim-without-handoff'])} | 0% |`,
      `| Unanswered turn | ${rate(['no-reply'])} | 0% |`,
      '', `Handoffs seen: ${results.filter((r) => r.trace.handoffs.length).length}. Verified calls: ${results.filter((r) => r.trace.verified).length}.`,
    ];
    writeFileSync(process.env.FUZZ_REPORT ?? '/tmp/fuzz-report.md', lines.join('\n'));
    expect(count('unauthorised-operation')).toBe(0);
  });
});
