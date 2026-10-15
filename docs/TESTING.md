# Testing Lily

The tests drive the real back end through the same API the browser uses. Banking systems are the built-in mocks and every customer is synthetic. Real Gemini voice and the Gemini intent model cannot be reached from tests, so the typed path with the rule-based intent classifier is what runs. Voice events are covered at the bridge level in `tests/e2e/live.test.ts` against a scripted stand-in for the speech model.

## Layers

| Layer | Where | What it proves |
| --- | --- | --- |
| Unit | `tests/unit` | Parsers, policy, redaction, state helpers |
| Integration | `tests/integration` | Orchestrator with mock adapters, verification state machine, actions |
| End to end conversations | `tests/e2e` | Whole calls: scenarios, security, languages, handoff, CRM, memory |
| Stress | `tests/e2e/stress.test.ts` | 46 judge style conversations with rules that must hold in all of them |
| Generated conversations | `tests/fuzz/fuzz.test.ts` | Seeded random sequences checked against invariants |
| Unexpected combinations | `tests/fuzz/combos.test.ts` | Hand picked turns a plain FAQ test would not try, plus a regression for every bug the generator found |

## Running

```
npm test                      # everything, about 90 seconds
npm run test:fuzz             # generated and combination tests only, a few seconds
npm run test:fuzz:long        # 2,000 generated sequences, about 2 minutes
FUZZ_SEED=123 FUZZ_RUNS=500 npx vitest run tests/fuzz
FUZZ_ONLY=20261234 npx vitest run tests/fuzz     # replay one failing seed
FUZZ_REPORT=fuzz.md npm run test:fuzz            # write the metrics table
```

In CI run `npm test` on every push and `npm run test:fuzz:long` with a new `FUZZ_SEED` each night. A new seed finds new sequences. A failure prints its seed and the replay command and writes `tests/fuzz/failures/seed-<n>.json` with the actions, the transcript, the timeline and the handoff rows.

## How the generated suite works

`tests/fuzz/library.ts` holds the building blocks. Each action has a kind: general question, acknowledgement, "let me finish", personal request, request for a person, cancel, correction, injection, unclear, off topic, two questions, language request, card number, duplicate event, noise. `rng.ts` is a seeded generator, so one seed always gives the same conversation. `run.ts` plays a sequence against the API and records, after every turn, the new replies, handoff rows, verification starts and executed operations. `invariants.ts` checks the rules below on every sequence. A second batch starts each sequence from a verified caller, to test what happens after verification.

## Invariants checked on every generated conversation

1. Verification starts only after a personal request or a card number. A general question or acknowledgement never starts it.
2. A conversation made only of general talk never transfers the call.
3. A transfer needs a reason: a request for a person, an accepted offer, a failed check or a risk flag.
4. Every customer turn gets a reply, and never more than four messages. Silence is allowed only while queued for an agent, after the goodbye, and for an identical repeat of the last sentence (treated as a duplicate transcript event).
5. No operation runs unless the caller is verified and agreed to a specific proposal.
6. The same event delivered twice produces no second output.
7. No identical message twice in one turn, and no repeated question twice in a row.
8. No 16 digit number appears in a transcript.
9. Nothing personal is spoken to a caller who is not verified.
10. One handoff row per call and one queue message per handoff. A queue number or "I'll transfer you" is spoken only if the back end has a matching handoff.
11. A general question never asks for a card number.
12. Verification, bank system queries and case creation are not repeated by later turns.

## Metrics

The fuzz run writes a table of rates: unnecessary authentication, premature escalation, duplicate response, unauthorised operation, sensitive data leakage, unconfirmed transfer or queue claim, unanswered turn. The target for every row is zero in the tested cases. A zero is not proof that none exists. It means none was found in that many sequences.

## What a run covered at the last count

2,000 generated sequences with seed 777000, 600 more from a verified start, 28 combination tests, plus the 340 existing tests. These bugs were found by the generator and fixed, each with a regression test in `combos.test.ts`:

1. A general question after an unclear turn ("what are your international transfer fees") started a security check. It now goes to the bank information first in every stage.
2. "Can I get a loan" after a clarification menu transferred the call as out of policy.
3. A follow-up inherited the earlier topic when it should not have ("can I get a loan" after a fee answer).
4. "Okay" was taken as a yes to "connect you with a person".
5. "No, let me start talking" after "anything else?" ended the call, and "let me finish" counted as a no.
6. A question after the rating prompt ended the call.
7. A general question during the card check, or during an open choice or yes or no, counted as a failed answer.
8. Punctuation only input produced the card menu instead of "I didn't catch that".
9. A stray digit inside a sentence ("alert(1)") was taken as a card digit.
10. Three non-answers inside a workflow transferred the call automatically. A person is now offered and the open question is kept if declined.
11. After verification, "What documents do I need" style questions are answered without a new case or system query. A late fee question said "a quick security check" to an already verified caller.
12. "How can I reset my password" got a PIN warning and no answer.
13. Two questions in one sentence got one answer.
14. The same nudge or not-found sentence repeated word for word.

## Not covered, and why

1. Real speech: end of turn detection, voice activity, background noise, barge-in timing, text to speech playback and microphone failure. The browser and Gemini audio path needs a real call. The bridge tests cover reconnects, tool dispatch, barge-in handling and duplicate events against a scripted model.
2. The Gemini intent model and Gemini Live behaviour. The rules that decide what may happen are deterministic and tested. Whether the live model follows the prompt, for example matching without telling, must be checked in real calls.
3. Backend timeouts and failing bank APIs are covered for the actions and verification code in `tests/integration`, not as random faults inside the generated sequences. Adding a fault injecting adapter to the generator is the next step.
4. Session expiry and cross call state in a long running deployment, beyond the isolation tests.
5. Saying "never mind" after asking for a person does not cancel the handoff. The call stays queued. Cancelling would be a new feature and needs a decision first.
6. A card number given before any request is met with a clarification menu. A friendlier flow would be to keep the card and ask what the caller needs. This also needs a decision.

## Defects found in judge testing (15 October 2026)

Reported by a tester working through the demo by voice and by typing, then fixed with the tests named here.

| Defect | Fix | Test |
|---|---|---|
| Two agents speaking at once after a language change | A replaced provider session is given a new epoch, so frames still arriving from the closing socket are dropped, and the browser is told to stop playing what the outgoing agent had already streamed | `tests/e2e/live.test.ts` "only one agent is ever heard" |
| The call stayed open after the caller said goodbye | A farewell at the closing question, or during the rating question, closes the call | `tests/e2e/closing.test.ts` "the call closes when the caller is finished" |
| "None, thank you", "proceed", "oo", "yes right" were not understood | Yes/no reading now strips courtesy words and covers the ways callers say yes, no and "that is everything", including Tagalog and Burmese | `tests/e2e/closing.test.ts` "answers callers actually give" |
| After blocking a stolen card, a bare question about unrecognised charges confused the caller | The question says why it is being asked, and is skipped when the card has no recent charges | `tests/e2e/closing.test.ts` "the stolen-card review question" |
| The handover was not a visible moment | Lily says she has transferred the caller, and the screen moves to the agent's workspace for the same case | `tests/e2e/closing.test.ts` "the handover is spoken, not just shown" |
