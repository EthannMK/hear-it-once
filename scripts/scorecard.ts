/**
 * Run the accuracy scorecard and write it down.
 *
 *   npx tsx scripts/scorecard.ts            play every scenario, print the table, write the report
 *   npx tsx scripts/scorecard.ts S01 S05     play only these
 *   npx tsx scripts/scorecard.ts --no-write  print only
 *
 * Each scenario gets its own database, so one call cannot leave anything behind for the next. The
 * report is written to docs/ACCURACY.md and docs/accuracy.json with the date and the commit; the
 * app serves the JSON at /api/scorecard so the safety page can show the last recorded run.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { buildApp } from '../src/api/app.ts';
import { openDb, setDb, migrate } from '../src/db/db.ts';
import { seedAll } from '../src/db/seed.ts';
import { resetChainKeyForTests } from '../src/audit/chain.ts';
import { setPolicyForTests } from '../src/config/policy.ts';
import { setAdapters } from '../src/adapters/registry.ts';
import { resetClock } from '../src/lib/clock.ts';
import { EXPECTATIONS, gradeScenario, playScenario, scenarioTitle, shortfalls, summarise, type Measure, type ScenarioResult } from '../src/reporting/scorecard.ts';

const args = process.argv.slice(2);
const write = !args.includes('--no-write');
const only = args.filter((a) => /^S\d+$/.test(a));

function freshDb() {
  resetClock();
  setPolicyForTests(null);
  setAdapters(null);
  resetChainKeyForTests();
  const d = openDb(':memory:');
  setDb(d);
  migrate(d);
  seedAll({ history: false });
}

const commit = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
})();

const wanted = only.length ? EXPECTATIONS.filter((e) => only.includes(e.id)) : EXPECTATIONS;
const results: ScenarioResult[] = [];

for (const expect of wanted) {
  freshDb();
  const app = await buildApp();
  try {
    const sessionId = await playScenario(app, expect.id);
    results.push(gradeScenario(expect, scenarioTitle(expect.id), sessionId));
  } finally {
    await app.close();
  }
}

const card = summarise(results, commit);

const MEASURE_LABEL: Record<Measure, string> = {
  intent: 'Worked out what the call was about',
  actions: 'Did exactly the right things to the account',
  escalation: 'Took the right course on passing the call to a person',
  verification: 'Changed nothing before identity was confirmed',
  disclosure: 'Said no account detail to an unverified caller',
};

const pct = (p: number, of: number) => (of ? `${Math.round((p / of) * 100)}%` : '—');

console.log(`\nScorecard — ${card.at}${commit ? ` at ${commit}` : ''}\n`);
for (const [k, m] of Object.entries(card.measures) as [Measure, { passed: number; of: number }][]) {
  console.log(`  ${MEASURE_LABEL[k].padEnd(50)} ${String(m.passed).padStart(2)}/${String(m.of).padEnd(2)}  ${pct(m.passed, m.of)}`);
}
console.log(`\n  Finished without a person                          ${card.containment.without}/${card.containment.of}  ${pct(card.containment.without, card.containment.of)}  (a business figure, not a score)\n`);

for (const s of results) {
  const failed = s.checks.filter((c) => !c.passed);
  if (failed.length) {
    console.log(`  ${s.id} ${s.title}`);
    for (const f of failed) console.log(`      ${f.measure}: ${f.detail}`);
  }
}
for (const s of card.skipped) console.log(`  ${s.id} not scored: ${s.why}`);

if (write) {
  const rows = (Object.entries(card.measures) as [Measure, { passed: number; of: number }][])
    .map(([k, m]) => `| ${MEASURE_LABEL[k]} | ${m.passed}/${m.of} | ${pct(m.passed, m.of)} |`)
    .join('\n');
  const detail = results
    .map((s) => {
      const failed = s.checks.filter((c) => !c.passed);
      const state = s.skipped ? 'not scored' : failed.length ? failed.map((f) => `**${f.measure}** — ${f.detail}`).join('; ') : 'everything it was asked to get right';
      return `| ${s.id} | ${s.title} | ${state} |`;
    })
    .join('\n');
  const md = `# Accuracy scorecard

Produced by \`npx tsx scripts/scorecard.ts\` on ${card.at.slice(0, 10)}${commit ? `, at commit \`${commit}\`` : ''}.
**Nothing in this file is typed by hand.** Every scenario below was played against the real API, one
fresh database each, and graded against \`EXPECTATIONS\` in \`src/reporting/scorecard.ts\`. Re-run it and
you should get the same table; if you do not, the table is wrong and the code is right.

The data is synthetic and the downstream banking systems are mocks, so this measures the assistant's
own behaviour — what it understood, what it did, when it stopped — and not the accuracy of a real
bank's systems.

**How much a row of high scores is worth, honestly.** Three of the measures are checked against
things fixed before anybody looked at the output: the issue each scenario is defined as being about,
and the two rules that hold on every call — nothing happens to an account before identity is
confirmed, and no account detail reaches an unverified caller. Those are hard to argue with. The
expectations for which actions should be confirmed came from the scenario definitions in
\`src/db/scenarios.ts\`. The course to take about a person was set differently: the first run
disagreed with four scenarios, and in each case reading the call showed the assistant was right and
the expectation was wrong — a caller who has not asked for a person should be offered one and left to
decide, not transferred. So that row says the assistant agrees with a judgement made after watching
it, which is weaker evidence than the rest and is worth knowing when reading the number.

What the first run did find, and what was changed because of it: an offer of a person left no trace
in the records once the caller answered, so a caller who hung up instead of answering looked like
one who was never offered a person at all. That is now recorded.

| What was measured | Scenarios | |
|---|---|---|
${rows}

Finished without a person: ${card.containment.without}/${card.containment.of} (${pct(card.containment.without, card.containment.of)}). This is
a business figure rather than a score. A bank may well want it lower, and an assistant that escalates
nothing is not a good one.

## Scenario by scenario

| | Scenario | Result |
|---|---|---|
${detail}
${card.skipped.length ? `\nNot scored: ${card.skipped.map((s) => `${s.id} (${s.why})`).join('; ')}. Both are covered by tests of their own.\n` : ''}`;
  writeFileSync('docs/ACCURACY.md', md);
  writeFileSync('docs/accuracy.json', `${JSON.stringify(card, null, 2)}\n`);
  console.log('\nWritten to docs/ACCURACY.md and docs/accuracy.json');
}

const missed = shortfalls(card);
process.exit(missed.length ? 1 : 0);
