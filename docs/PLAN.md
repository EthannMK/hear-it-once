# Phase 0 — Repository assessment and technical plan

## Repository assessment (13–14 Oct 2026)

- The working repository was **empty**: no code, manifests, database, or prior implementation. No existing stack to follow.
- The user's computer was not reachable from the build session, so no local repository could be inspected there.
- Inputs: *Hear It Once — Revised Implementation BRD v1.0 (13 Oct 2026)* and the master implementation prompt.
- The BRD authorises a **simulated, local-first, zero-infrastructure-cost prototype only** — no real card actions, production data, or live bank integration.

## Stack decision

| Concern | Choice | Why |
|---|---|---|
| Runtime / language | Node.js 22 + TypeScript (run with `tsx`, type-checked with `tsc`) | One language end to end; strong typing for adapter contracts; no build step to run. |
| HTTP | Fastify 5 | Mature, fast, schema-friendly, first-class plugins for cookies, rate limiting, static files. |
| Validation | Zod | Typed request/response contracts shared by routes and services. |
| Persistence | SQLite via Node's built-in `node:sqlite` | BRD §9.2 recommends SQLite for a single-user local prototype; built-in driver means no native compilation. WAL mode, FKs, migrations. |
| Frontend | Static HTML + vanilla ES modules, no build | Keeps the demo installable with one `npm install`; the UI is a thin client over the same APIs. |
| Tests | Vitest | Fast TS-native unit, integration and API end-to-end tests (Fastify `inject`). |
| AI | Provider-neutral `IntentModel` adapter; default deterministic rules model (free, offline); optional Anthropic adapter | BRD: no paid services required for the core demo; LLM never authorises actions. |
| Voice | Provider-neutral ASR/TTS/telephony interfaces; text simulator (mandatory fallback); optional browser Web Speech in the simulator | BRD §10: text-first; voice optional. |

Rejected: microservices / message queues (BRD §16 says avoid), Postgres (no concrete need; would add infrastructure), React/Vite (adds a build chain without changing the demonstrated behaviour).

## Architecture (modules)

```
public/            simulator, agent console, ops dashboard (thin clients)
src/api/           Fastify routes: validation, authn/authz, error mapping, rate limits
src/conversation/  orchestrator: deterministic dialogue state machine + response templates
src/ai/            IntentModel adapter (rules | anthropic), untrusted-input guard
src/voice/         ASR / TTS / telephony interfaces + text-simulator channel
src/verification/  identity state machine (identify → DOB → OTP), lockout
src/retrieval/     parallel fact retrieval: timeouts, retries, circuit breaker, freshness, conflicts
src/workflows/     the five issue workflows (pure decision functions over a snapshot)
src/policy/        central policy engine + deterministic eligibility rules
src/actions/       action service: lifecycle, consent, idempotency, timeout → Unknown, reconciliation
src/disputes/      structured dispute builder/validator/submission
src/cases/         case service + grounded summary
src/handoff/       warm handoff, agent brief, simulated agent desk
src/reporting/     KPI calculations from persisted events
src/audit/         audit events (redacted)
src/adapters/      typed contracts + MOCK implementations of 9 logical bank systems
src/db/            migrations, seed, reset, scenarios
src/config/        env, central policy, BRD targets
```

The LLM/intent model only classifies and extracts. Eligibility, permission, consent, limits and execution are deterministic backend code.

## Milestones

1. **Foundation** — config, migrations, synthetic seed + reset, demo RBAC, typed mock adapters with fault injection, audit + redaction.
2. **Core workflows** — verification state machine, parallel retrieval, classification, eligibility, action service, disputes, cases, handoff.
3. **Customer & agent experience** — text simulator with scenario selector, agent console with brief, action status, reconciliation.
4. **Dashboard** — KPI calculations from events, filters, illustrative-vs-measured separation, QA review.
5. **Quality & delivery** — API end-to-end tests for all 18 scenarios, privacy tests, docs, traceability matrix.

Unresolved business decisions are listed in `DECISIONS.md`; each has a conservative mock-mode default.
