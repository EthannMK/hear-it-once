# Accuracy scorecard

Produced by `npx tsx scripts/scorecard.ts` on 2026-10-17, at commit `3b1d4b8`.
**Nothing in this file is typed by hand.** Every scenario below was played against the real API, one
fresh database each, and graded against `EXPECTATIONS` in `src/reporting/scorecard.ts`. Re-run it and
you should get the same table; if you do not, the table is wrong and the code is right.

The data is synthetic and the downstream banking systems are mocks, so this measures the assistant's
own behaviour — what it understood, what it did, when it stopped — and not the accuracy of a real
bank's systems.

**How much a row of high scores is worth, honestly.** Three of the measures are checked against
things fixed before anybody looked at the output: the issue each scenario is defined as being about,
and the two rules that hold on every call — nothing happens to an account before identity is
confirmed, and no account detail reaches an unverified caller. Those are hard to argue with. The
expectations for which actions should be confirmed came from the scenario definitions in
`src/db/scenarios.ts`. The course to take about a person was set differently: the first run
disagreed with four scenarios, and in each case reading the call showed the assistant was right and
the expectation was wrong — a caller who has not asked for a person should be offered one and left to
decide, not transferred. So that row says the assistant agrees with a judgement made after watching
it, which is weaker evidence than the rest and is worth knowing when reading the number.

What the first run did find, and what was changed because of it: an offer of a person left no trace
in the records once the caller answered, so a caller who hung up instead of answering looked like
one who was never offered a person at all. That is now recorded.

| What was measured | Scenarios | |
|---|---|---|
| Worked out what the call was about | 17/17 | 100% |
| Did exactly the right things to the account | 17/17 | 100% |
| Took the right course on passing the call to a person | 17/17 | 100% |
| Changed nothing before identity was confirmed | 19/19 | 100% |
| Said no account detail to an unverified caller | 19/19 | 100% |

Finished without a person: 11/17 (65%). This is
a business figure rather than a score. A bank may well want it lower, and an assistant that escalates
nothing is not a good one.

## Scenario by scenario

| | Scenario | Result |
|---|---|---|
| S01 | Unrecognised charge → block, replace, dispute | everything it was asked to get right |
| S02 | Lost card → rapid block + replacement | everything it was asked to get right |
| S03 | Duplicate charge, insufficient evidence | everything it was asked to get right |
| S04 | Payment not showing (pending) | everything it was asked to get right |
| S05 | Eligible fee reversal | everything it was asked to get right |
| S06 | Ineligible fee reversal | everything it was asked to get right |
| S07 | Repeat caller with unresolved case | everything it was asked to get right |
| S08 | Customer asks for a human immediately | everything it was asked to get right |
| S09 | AI uncertainty → human | everything it was asked to get right |
| S10 | Identity verification fails | everything it was asked to get right |
| S11 | Required banking system unavailable | everything it was asked to get right |
| S12 | Conflicting system results | everything it was asked to get right |
| S13 | Card block fails | everything it was asked to get right |
| S14 | Card block times out → Unknown → reconciled | everything it was asked to get right |
| S15 | Duplicate action request (idempotency) | not scored |
| S16 | Dispute submission pending | everything it was asked to get right |
| S17 | Assistant unavailable → fallback | everything it was asked to get right |
| S18 | Action without consent / permission rejected | not scored |
| S19 | Card declined abroad → explained, no change made | everything it was asked to get right |

Not scored: S15 (needs the demo panel to send two consents at once); S18 (needs the demo panel to attempt an action with no consent). Both are covered by tests of their own.
