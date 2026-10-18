# Architecture

A single Node.js process (Fastify) with a SQLite database. Modules are separated by responsibility so mocks can be replaced by approved providers without rewriting workflows. No microservices or queues: the BRD asks for a simple local-first prototype, and every action the customer is told about must be confirmed synchronously in the call.

## Module map

```
             ┌──────── public/ (simulator · agent console · dashboard) ────────┐
             │           thin clients over the same JSON API                   │
             └──────────────────────────────┬───────────────────────────────────┘
                                            │ HTTPS/JSON (caller token or staff cookie)
┌───────────────────────────────────────────▼──────────────────────────────────────────┐
│ api/  validation (zod) · authn/authz (RBAC from DB) · rate limits · CSP · error map   │
├───────────────────────────────┬───────────────────────────────┬──────────────────────┤
│ conversation/orchestrator     │ handoff/  (brief, desk)       │ reporting/kpi        │
│  dialogue state machine       │ cases/    (grounded summary)  │ reporting/retention  │
│  ├ ai/intent (classify only)  │ disputes/ (draft→validate)    │ audit/               │
│  ├ verification/ (2-factor)   │                               │                      │
│  ├ retrieval/ (parallel)      │                               │                      │
│  ├ workflows/ (5 issue types) │                               │                      │
│  └ actions/ ──► policy/engine (authorise every action, re-derive eligibility)         │
├───────────────────────────────┴───────────────────────────────┴──────────────────────┤
│ adapters/types.ts — typed contracts for 9 logical bank systems + identity + writers    │
│ adapters/mock/*   — SIMULATED implementations (latency, faults, idempotent writes)     │
├───────────────────────────────────────────────────────────────────────────────────────┤
│ db/  SQLite (node:sqlite, WAL, FKs) — app tables + bank_* simulated-system tables      │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

| BRD layer | Module |
|---|---|
| Frontend / interaction | `public/`, `src/api/` |
| Voice / telephony adapter | `src/voice/interfaces.ts` (ASR, TTS, telephony contracts); text simulator; optional in-browser Web Speech |
| Conversation orchestration | `src/conversation/orchestrator.ts` |
| LLM / intent adapter | `src/ai/intent.ts` (`RulesIntentModel` default, `AnthropicIntentModel` optional) |
| Identity verification | `src/verification/verification.ts` + `adapters/mock/identity.ts` |
| Issue workflow engine | `src/workflows/*` |
| Banking integration adapters | `src/adapters/types.ts`, `src/adapters/mock/*`, `src/adapters/registry.ts` |
| Central policy & authorisation | `src/config/policy.ts` (values), `src/policy/engine.ts`, `src/policy/eligibility.ts` |
| Action execution | `src/actions/action-service.ts` |
| Case management | `src/cases/case-service.ts`, `src/disputes/dispute-service.ts` |
| Audit & observability | `src/audit/audit.ts`, `src/lib/logger.ts`, `integration_calls`, `session_events` |
| Reporting & KPIs | `src/reporting/kpi.ts` |
| Persistence | `src/db/*` |

## The AI boundary

The intent model **classifies and extracts only**. It never sees policy, never authorises, and its confidence is never used for identity or authorisation. Numeric slots (amounts, dates, OTPs) always come from deterministic parsers. Safety signals (asks for a human, third-party caller, prompt injection, distress) are deterministic regexes evaluated before any model output is used. Caller text is untrusted data: it is redacted, stored, parsed — never executed or concatenated into instructions. The optional LLM adapter wraps caller text in tags, neutralises tag-closing characters, validates output with a schema, and falls back to the rules model on any failure.

## State machines

**Dialogue** (`CallContext.stage`): `awaiting_issue → (clarifying_issue) → identifying? → awaiting_dob → awaiting_otp → workflow → wrap_up → awaiting_survey → ended`, with exits to `handoff` (any time) and `fallback` (assistant failure). The context is persisted after every input, so a reload or restart resumes the call.

**Verification**: identification (caller ID or customer number — never proof) → knowledge factor (DOB, compared as a keyed hash) → possession factor (one-time passcode to the registered phone; shown in a labelled simulated-phone panel in demo mode). Three failures at any step lock verification. Nothing protected is read before `verified`.

**Action lifecycle** (BRD §8):

```
requested → validated → awaiting_confirmation → [awaiting_approval] → submitted → succeeded
     │           │               │                      │                  ├──────→ failed
     └───────────┴───────────────┴──────────→ rejected  │                  └──────→ unknown ─(reconcile)→ succeeded | failed | submitted
                                                         └→ rejected (agent)
```

- Every proposed action becomes an `action_operations` row in `awaiting_confirmation` when the proposal is made; consent moves it forward.
- Submission is an **atomic compare-and-set** on status, so concurrent or duplicate confirmations cannot execute twice. The downstream call uses the operation ID as its idempotency key, and the mock systems de-duplicate on it.
- A timeout **after** sending → `unknown`. `unknown` can never be retried; it must be **reconciled** by looking up the idempotency key downstream. Retry is allowed only when reconciliation proves the request was never received (`NOT_RECEIVED`) or the service refused the connection (`DOWNSTREAM_UNAVAILABLE`).
- A pending downstream response stays `submitted` (shown as *Pending*), never `succeeded`.
- Dependent actions (replacement, fraud dispute) are not attempted until the card block is confirmed; after a successful reconciliation the remaining actions resume under the same consent.

## Request flow (unrecognised charge)

1. `POST /api/calls` → session created; AI disclosure + recording notice written as the first turns.
2. Caller statement → intent + slots; statement stored redacted; verification starts.
3. DOB → OTP → `verified`. Case created immediately.
4. `retrieveFacts` runs 6 adapters concurrently (timeout 1.5 s each, one retry, per-source circuit breaker), persists one `integration_calls` row per source, detects cross-source conflicts.
5. Workflow guard: required sources must be `ok`, fresh and conflict-free, else safe handoff.
6. Workflow matches the transaction from verified data, checks card, fraud, prior cases, rule `DR-FRAUD-01`; records findings as confirmed / inferred / unavailable.
7. Dispute draft built and validated against the rule's required fields; proposal + operations created; caller asked to confirm.
8. Consent → `authorizeAction` re-derives every check (verification, consent linked to this exact action, sources, ownership, eligibility, dependencies) → submit → outcome persisted → case summary regenerated from rows.
9. Customer is told exactly what succeeded, failed, is pending or unknown.

## Data model

Two zones in one database (see `src/db/migrations/001_init.sql`):

- **Simulated bank systems** (`bank_*`): customers (hashed DOB/phone), cards (last 4 only), transactions, fraud alerts, payments, fees, dispute rules, fee policies, and `bank_operations` (the downstream systems' own idempotent operation log). Only mock adapters touch these tables.
- **Application state**: `call_sessions`, `conversation_turns` (redacted), `verification_attempts` (outcomes only), `otp_challenges` (hashed), `retrieval_snapshots`, `integration_calls`, `cases`, `case_events`, `proposals`, `consents`, `action_operations` (+ `action_status_history`), `disputes`, `handoffs`, `hold_intervals`, `session_events`, `qa_reviews`, `audit_events`, `roles`, `role_permissions`, `staff_users`, `mock_faults`, `app_settings`.

Integrity: foreign keys, unique `(action_type, idempotency_key)`, one case per session, at most one open handoff per session, at most one active dispute per transaction (partial unique indexes), timestamps everywhere, indexes for time and session lookups. No column holds a full PAN, CVV, plaintext DOB or plaintext OTP.

## Replacing a mock with a real provider

Implement the interface in `src/adapters/types.ts`, register it in `src/adapters/registry.ts` behind a new `ADAPTER_MODE`. Any non-`mock` mode **forces the `pilot-conservative` policy profile** (human approval for every consequential action) until a bank owner approves otherwise. Workflows, policy, actions and UI do not change.

## The memory boundary

The back-office agent on Vertex AI Agent Engine has a Memory Bank. It is worth being exact about
what that does and does not mean, because "the assistant remembers you" is the kind of sentence
that quietly turns into "the assistant decided something about you".

Memory holds **soft context**: a preferred name, that someone travels often, that they raised this
merchant before, that the last call needed a person. It exists so a customer is not treated as a
stranger on their second call.

Memory holds **nothing a decision rests on**. Identity, verification state, card status, balances,
limits and eligibility are read from the bank's records on every call, every time. A memory may
colour how the assistant talks to someone; it may never decide anything about them.

Four things hold that line, and none of them is a prompt:

1. **On the way in** (`src/memory/memory-bank.ts`) lines are built from the call analysis the app
   already computed, not from free model output. Each is redacted, then checked against
   `DECIDING_FACTS` — verification, identity, card status, balance, limit, eligibility, approval,
   or any bare number. A line that matches is dropped, not reworded.
2. **On the way out** a memory is wrapped by `untrusted()` under the standard preamble before a
   model reads it. It is model-written text derived from customer speech, which is exactly the
   threat FP-07 describes, so it gets the same treatment as a merchant name.
3. **Nothing that authorises reads it.** `authorizeAction` does not import the memory module. A
   memory claiming the caller is verified changes nothing, and there is a test that proves a card
   block is still refused with one planted in the store.
4. **A customer can be forgotten.** `DELETE /api/crm/customers/:id/memory` clears everything scoped
   to them and audits it.

The write happens when a call's analysis completes (`src/analysis/analysis.ts`), scoped to the
customer id. It is deliberately not awaited and cannot throw: the call record is finished and
correct by then, and a memory is a nicety that must never be able to fail it.
