# Judge-readiness audit

Scope: source at `main`, tested on the in-process app with the mock banking stack.
**The deployed Cloud Run service was not reachable from the audit sandbox (no credentials, no
network route), so nothing below is a result for the deployed system.** Run the smoke checklist
against it after deploying.

## Confirmed findings

| # | Severity | Finding | Where | Status |
|---|---|---|---|---|
| 1 | High (demo) | Behind Cloud Run every request appeared to come from the Google front end (`trustProxy:false`), so IP-keyed limits (30 new calls/min, 90 inputs/min) were shared by all judges at once. | `src/api/app.ts` `buildApp` | Fixed: one trusted hop when `K_SERVICE` is set. Test: `client address behind Cloud Run` |
| 2 | Medium | No way to tell which build is deployed. | `GET /api/health` | Fixed: returns `revision` (`K_REVISION`). Test: `deployment identity` |
| 3 | Info | Demo login lets anyone choose a staff role by design (`DEMO_MODE`); the app refuses to start with `DEMO_MODE` in `NODE_ENV=production`. | `src/api/routes/staff.ts`, `src/config/env.ts` | Accepted for the demo. Not production authentication. |
| 4 | Low | Test `no stored record ... contains a full PAN` failed about 1 run in 10: the scan treated a 13-digit epoch-millisecond field as a card number (Luhn passes 10% of the time). Test-only; the app stores no card data. | `tests/e2e/scenarios.test.ts` | Fixed: timestamps stripped before the scan; 30/30 repeat runs pass |

## Probes executed (all passed, `tests/audit/audit.test.ts`, 43 tests)

- Authorization: 15 staff/admin/CRM routes refuse anonymous callers and customer call tokens (30 checks); an agent cannot use admin reset; one call token cannot read or drive another call.
- Public routes contain no secrets.
- Robustness: malformed JSON, wrong types, oversize text, prototype pollution, wrong content type: no 5xx. Input after hang-up and double hang-up: no 5xx, no executed operation.
- Duplicates: four concurrent identical messages with one `clientMessageId` give one transcript entry and at most one handoff.
- Concurrency: different messages in parallel on one call keep all entries. Twelve parallel calls stay isolated.
- Logging: a card number, NRC, and passcode typed in a call never appear in log output.
- Latency (mock, typed path): p95 under 400 ms.

Earlier layers (unchanged): 376 tests, generated-conversation fuzz (3,200 runs, 0 violations), see `docs/TESTING.md`.

## Not tested (cannot be from here)

Real microphone, voice activity and barge-in timing, Gemini Live and the Gemini intent model, TTS,
Cloud Run cold starts and the live URL, browser offline/refresh behaviour, real network drops.
Router mistakes by the real model are the main remaining unknown.

## Risks that could still affect a live demo

1. Voice quality depends on the room and browser. Keep the typed box as the fallback.
2. Gemini may route differently from the rule-based typed path. Use the phrases in the smoke list first.
3. A new revision restarts the instance; start a fresh call after deploying.
4. Single instance: do not let more than a few judges reset demo data at once.
5. Open decisions: "never mind" after asking for a person does not cancel the queued handoff; a card number given before any request shows a clarification menu.

## Smoke checklist for judges (about 5 minutes)

1. `GET /api/health` shows `status: ok` and the expected revision.
2. Start a call. Lily greets once.
3. Say "what are your opening hours" → answered with no security check.
4. Say "how do I reset my password" → answered with no security check.
5. Say "can I deposit cash at an ATM" → deposit answer. Then "and the limit?" → follow-up stays on topic.
6. Say "ok" or "hmm" → short prompt, no workflow.
7. Say "something nobody knows about" → honest "I don't have that", no transfer.
8. Say "I was charged twice" → security check starts. Complete it with the demo data table.
9. Ask a general question during the check → answered, then the check resumes.
10. Say "let me talk to a person" → offered, then queued once with one message.
11. Open the agent console: one handoff row.
12. Reload the page mid-call → call and transcript resume.
