# BRD traceability matrix

Status key: **Implemented** (built and covered by automated tests) · **Partial** (built with a stated gap) · **Not implemented** · **Blocked** (needs a business decision or real infrastructure).

Test file abbreviations: `E2E` = `tests/e2e/scenarios.test.ts` · `CONV` = `tests/e2e/conversation.test.ts` · `ACT` = `tests/integration/actions-retrieval.test.ts` · `STAFF` = `tests/integration/staff-api.test.ts` · `FND` = `tests/integration/foundation.test.ts` · `ELIG` = `tests/unit/eligibility.test.ts` · `INT` = `tests/unit/intent-parsers.test.ts` · `KPI` = `tests/unit/kpi.test.ts` · `RED` = `tests/unit/redact.test.ts` · `RES` = `tests/unit/resilience.test.ts`.

## Functional requirements (BRD §7)

| ID | Requirement | Implementation | Tests | Status |
|---|---|---|---|---|
| FR-01 | Answer and disclose AI / recording notice | `conversation/messages.ts` (`GREETING_NOTICE`, `GREETING`), written as the first two turns in `startCall` | E2E S01 (asserts first turns) | Implemented |
| FR-02 | Capture issue once, preserve context | Statement stored redacted on session and case; slots merged across turns; context persisted per input; brief carries statement + facts | E2E S01, S08; ACT handoff brief | Implemented |
| FR-03 | Recognise repeat contacts | `onVerified`: prior open cases (30 days) from `prior_cases` adapter, same-issue → recurring flag, case links, `repeat_contact`; KPI repeat-7d | E2E S07; KPI | Implemented |
| FR-04 | Verify identity before disclosure/action | `verification/verification.ts` (2 factors, lockout); every protected read after `verified`; `policy/engine.ts` `session_verified` check on every action; API `VERIFICATION_REQUIRED` | E2E S10; ACT verification; ACT prepareAction | Implemented |
| FR-05 | Read priority sources in parallel | `retrieval/retrieval.ts` — 6–7 adapters via `Promise.all`, timeouts, retries, breakers; per-source rows in `integration_calls`; UI lanes | ACT parallel retrieval (wall ≪ sum); E2E S11 | Implemented |
| FR-06 | Explain evidence and eligibility | Workflows emit findings (confirmed / inferred / unavailable) with merchant, amount, date, card status, rule code + version | E2E S01, S03, S04, S06 | Implemented |
| FR-07 | Propose action and request consent | `propose()` creates proposal + operations in `awaiting_confirmation`; consent row linked to proposal; accept / decline / ask for agent | E2E S01, S05; CONV decline | Implemented |
| FR-08 | Execute permitted actions, create case | `actions/action-service.ts` + `policy/engine.ts`; case created at verification, updated through the call | E2E S01, S02, S05 | Implemented |
| FR-09 | Lost-card fast path | Lost/stolen: verification first, block proposed as the very first step after retrieval; only confirmed result described as success; time-to-block KPI | E2E S02 (<60 s), S13, S14 | Implemented |
| FR-10 | Complete dispute | `disputes/dispute-service.ts`: draft, required-field validation per rule, missing-fields list, status from intake response only; "submitted ≠ accepted" | E2E S01, S16 (pending & rejected); CONV duplicate | Implemented |
| FR-11 | Warm handoff | `handoff/handoff-service.ts` brief (verification, intent, transactions if verified, systems, facts, actions, missing info, risk, case, next step); simulated desk; `connected` only after an agent accepts | E2E S08; ACT handoff | Implemented (telephony simulated) |
| FR-12 | Safe fallback | Source guard (unavailable / stale / conflicting → handoff, no write); low confidence → handoff; failed verification → handoff | E2E S09–S13; ACT stale | Implemented |
| FR-13 | Privacy and masking | `lib/redact.ts` on transcripts, summaries, audit, logs; last-4 only; hashed DOB/phone/OTP; verification answers never stored | RED; E2E privacy; FND seed scan; ACT logging | Implemented |
| FR-14 | Audit every read/action | `audit/audit.ts` (timestamp, actor, event, resource, correlation ID, status, redacted metadata) | FND audit; E2E S01, S18; STAFF | Implemented |
| FR-15 | Fallback if assistant unavailable | `enterFallback`: controlled message, case with statement, queue routing; any orchestrator error takes the same path | E2E S17 | Implemented |
| FR-16 | Operations dashboard | `reporting/kpi.ts` + `/dashboard.html`; filters: date, issue, outcome, handoff reason, data origin | KPI; STAFF | Implemented |
| FR-17 | Idempotency and reconciliation | Unique `(type, key)`; CAS submit; downstream key = op ID; `reconcile`, guarded `retryAction` | E2E S14, S15; ACT reconciliation | Implemented |
| FR-18 | Role-based backend access | Permissions loaded from `role_permissions`; `requirePermission` on every staff route; caller token per call | FND RBAC; STAFF matrix; E2E S18; ACT token | Implemented |
| FR-19 | Synthetic label and reset | Banner on every page; `is_synthetic` constraint; `data_origin`; `npm run db:reset` and admin reset (typed confirmation) | FND reset; STAFF reset | Implemented |
| FR-20 | Integration observability | `integration_calls` (status, latency, attempts, freshness, error code) for reads and writes; KPI integration table | ACT partial failure; KPI | Implemented |

## Action policy and lifecycle (BRD §8)

| Item | Implementation | Tests | Status |
|---|---|---|---|
| All consequential actions via backend; LLM cannot authorise | Only `action-service` executes; intent model has no access to policy/actions | INT injection; CONV injection; E2E S18 | Implemented |
| Block card: verification, target disambiguation, permission, persisted status | Card choice when >1 active card; `card_owned`, `card_blockable` checks | E2E S02; ACT other-customer card | Implemented |
| Replacement: verified, selected card, permission, confirmation | `card_blocked_first` dependency + consent | E2E S01, S02 | Implemented |
| Dispute: fields/evidence + confirmation; submitted ≠ accepted | Dispute validation; status mapping | E2E S01, S16 | Implemented |
| Fee reversal: eligible rule, limits, confirmation, confirmed result | `feeReversalEligibility` + `policy.feeReversal` | ELIG; E2E S05, S06 | Implemented |
| Lifecycle Requested → Validated → Awaiting confirmation → Submitted → Succeeded/Failed/Unknown | `action_status_history` | E2E S14 asserts full sequence | Implemented |
| Timeout after submission → Unknown until reconciled; no blind retry | `submit()` → `unknown`; `retryAction` refuses unknown | E2E S14; ACT reconciliation | Implemented |
| Op ID, idempotency key, timestamp, actor, policy decision, consent ref, outcome, safe error | `action_operations` columns | E2E S01, S05 | Implemented |
| Human approval configurable | `pilot-conservative` profile; agent approve/reject | ACT conservative profile | Implemented |

## Data & integration (BRD §9)

| Item | Implementation | Status |
|---|---|---|
| 9 logical mock adapters, typed contracts | `adapters/types.ts`, `adapters/mock/*` (customer/identity, cards, transactions, fraud, prior cases, dispute rules + intake, payments, fees + ledger, replacement) | Implemented — **all simulated** |
| Local persistent DB; survives restarts | SQLite file, WAL | Implemented (FND persistence) |
| Minimum entities | See ARCHITECTURE data model | Implemented |
| Freshness; stale/conflicting → clarify or escalate | `asOf`, staleness policy, `detectConflicts`, `assessSources` | Implemented (ACT, E2E S12) |
| Bounded retries; retry writes only when safe | Reads: 1 retry; writes: never auto-retried | Implemented (RES, ACT) |

## AI, conversation, voice (BRD §10, prompt §7)

| Item | Implementation | Tests | Status |
|---|---|---|---|
| Provider adapter for LLM; config in env | `IntentModel`, `INTENT_MODEL`, `ANTHROPIC_*` | INT LLM adapter (mocked fetch) | Implemented; live LLM **not tested** (no key/network) |
| Deterministic state machines and rules | orchestrator, verification, policy, eligibility | all | Implemented |
| Ground claims in records / outcomes | Messages built from snapshot + persisted ops; summary from rows | E2E | Implemented |
| Clarify ambiguity; never invent merchant/amount/policy/date | Choice lists; payment never invents dates | E2E S04, CONV choices | Implemented |
| Interruption, silence, correction, duplicate, timeout, unsupported | `interrupt`, `silence`, `onCorrection`, duplicate guards, ASR gate, out-of-policy | CONV | Implemented |
| Text simulator as mandatory fallback | `/` | E2E (same API) | Implemented |
| Voice | Provider-neutral interfaces; optional browser Web Speech in simulator | — (manual only) | Partial — no server-side ASR/TTS/telephony provider |
| Supported languages documented | `SUPPORTED_LANGUAGES = ['en-US']` | — | Implemented (English only) |
| Prompt injection, untrusted content | Deterministic signals; tags; schema validation | INT, CONV | Implemented |

## Security & privacy (BRD §11, prompt §6) — see SECURITY.md

| Item | Status |
|---|---|
| RBAC, server-side enforcement, input validation, output encoding, rate limiting, secure cookies, CSP, masking, audit of sensitive reads, retention purge, secret scanning, dependency audit | Implemented |
| Encryption at rest | **Not implemented** (local SQLite file; see DEPLOYMENT/LIMITATIONS) |
| TLS in transit | Delegated to a reverse proxy (documented); not built in |
| Production identity, PCI DSS scope, call-recording rules, AI disclosure law | **Blocked** — require bank / legal decisions |

## Dashboard & KPIs (BRD §12) — see KPIS.md

All 15 listed measures plus the four stage timings are computed from persisted events (KPI test). Measures that require real baselines or production telemetry are labelled "Needs real pilot data". **Implemented** for calculation; **Blocked** for real-world evaluation.

## Demo scenarios (BRD §14)

All 18 scenarios: **Implemented**, each with an end-to-end API test in `E2E` (S01–S18) asserting persisted state, plus scenario selection in the UI and documented steps in DEMO_WALKTHROUGH.md.

## Delivery checklist (BRD §19)

| Deliverable | Where | Status |
|---|---|---|
| Repository assessment & architecture | PLAN.md, ARCHITECTURE.md | Done |
| Traceability matrix | this file | Done |
| Working local app + persistent DB | `npm start` | Done |
| Seed data + safe reset | `db:seed`, `db:reset`, admin reset | Done |
| Core workflow, adapters, policy, action states, cases, handoff, audit, dashboard | `src/` | Done |
| Automated tests and results | `npm test` — 130 passing | Done |
| Env example without secrets | `.env.example` | Done |
| README with commands | README.md | Done |
| Demo script for all scenarios | DEMO_WALKTHROUGH.md | Done |
| Assumptions, decisions, simulated integrations, limitations | DECISIONS.md, LIMITATIONS.md | Done |
