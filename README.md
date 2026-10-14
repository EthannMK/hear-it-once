# Hear It Once — AI card-services assistant (simulated prototype)

> **This is a simulated prototype.** It uses synthetic customers and mock bank systems only. No real card, payment, dispute, fee or customer is ever affected. It is not production-ready and makes no compliance claims.

Hear It Once answers a credit-card services call without an IVR menu, discloses that it is an AI, captures the caller's issue **once**, verifies identity, checks six to seven bank systems **in parallel**, explains what those systems confirm, proposes permitted actions, executes them **only after explicit consent and deterministic policy checks**, creates a case during the call, and hands off to a person whenever asked or whenever it can't proceed safely.

> **One conversation. Every action handled. Nothing lost.**

It ships these screens on top of one backend:

| Screen | Path | Who |
|---|---|---|
| Landing — signature mic orb, text fallback, example requests, judge scenarios, what's simulated | `/` | Anyone |
| Live call workspace — voice or text conversation beside a live operations view (stage stepper, call tags, parallel system checks, actions with their authorisation lifecycle, event stream, knowledge used, case) | `/#/call` | Anyone |
| Resolution / agent brief — customer's words, verified facts vs AI interpretation, actions by outcome, unresolved items, evidence, KB references, next step, copy summary, event history | `/#/brief/<call>` | The caller's browser, or staff |
| Operations — live overview (active calls by stage, action outcomes, categories, drill-down event trails) plus pilot KPIs, QA review, audit, admin | `/dashboard.html` | Demo QA / admin roles |
| Agent console (warm-handoff briefs, approvals, outcome) | `/agent.html` | Demo agent role |
| Scenario lab — all 18 scripted scenarios in the original simulator | `/lab.html` | Anyone |

### What's real and what's simulated

| Real (the application) | Simulated (replaceable adapters) |
|---|---|
| Conversation state machine, verification flow, policy/eligibility engine, consent, idempotency, timeout → unknown → reconciliation, cases, handoff briefs, audit, timeline events, SSE stream, KPIs | All 9 bank systems, the identity passcode (shown on a simulated phone), the 9-article knowledge base (synthetic guidance, not bank policy), the agent desk, and the seeded illustrative history |
| Browser speech recognition / synthesis where the browser supports it (Chrome, Edge); text input always works and is the fallback when the microphone is denied or unsupported | No audio is recorded or sent to the server — only recognised text |

Sentiment is an indicative keyword rule, labelled as such; it is never used to authorise anything.

### Judge scenarios (from the landing page)

| Scenario | Shows |
|---|---|
| S01 Unrecognised transaction | verification → six parallel checks → explanation → one consent → block + replacement + dispute, each confirmed by its system |
| S02 Lost or stolen card | block first, before any other question |
| S04 Payment not showing | reports only what the payment system returned |
| S05 / S06 Fee query | eligible courtesy reversal vs. a rule-based refusal with a person offered |
| S08 Ask for a person | immediate warm handoff with a full agent brief |
| S10 Verification fails | nothing disclosed or changed; safe escalation |
| S11 A bank system is down | partial data is never presented as complete |
| S13 Card block fails | never claims success; urgent escalation |
| S15 Duplicate request | "Confirm twice at once" → exactly one block |

**Free talk:** press the orb (or type) and describe any card problem. Once the issue is understood a synthetic customer who fits it is attached; the date of birth appears in the persona card and the passcode on the simulated phone. "I don't recognise a transaction for $84.50" works end-to-end. **Reset & replay** re-seeds just that scenario's customer.

## Requirements

- **Node.js 22.13 or later** (uses the built-in `node:sqlite`; no native build step).
- npm. Nothing else: no database server, no cloud services, no paid APIs.

## Quick start

```bash
npm install
cp .env.example .env
# put a long random value in SESSION_SECRET, e.g.:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npm run db:migrate      # create/upgrade the SQLite schema (data/hear-it-once.db)
npm run db:seed         # load synthetic customers, 18 demo scenarios, illustrative history
npm start               # http://127.0.0.1:3000
```

`npm start` also migrates and seeds automatically on first run, so `npm install && npm start` is enough for a quick look.

| Command | What it does |
|---|---|
| `npm start` | Run the server (API + UI) |
| `npm run dev` | Run with auto-reload |
| `npm run db:migrate` | Apply pending SQL migrations |
| `npm run db:seed` | Seed synthetic data (no-op if already seeded) |
| `npm run db:reset` | **Wipe and re-seed** all synthetic demo data (also available in the dashboard as an admin) |
| `npm test` | Run all 117 automated tests (unit, integration, API end-to-end) |
| `npm run typecheck` | TypeScript type check |
| `npm run check:secrets` | Fail if source contains secrets or full card numbers |
| `npm run audit:deps` | `npm audit` of runtime dependencies |

Data lives in `data/hear-it-once.db` and **persists across restarts**. Tests use an in-memory database.

## Talk to Lily (live voice)

The home page is a live two-way voice agent (Gemini Live on Vertex AI) with a four-scenario journey, a real-time “Behind the conversation” panel, in-app human handover and a post-call summary. See [docs/LILY_VOICE.md](docs/LILY_VOICE.md) for architecture, configuration and what is/isn't verified. The earlier demo remains at `/classic.html`.

## Deploy to Google Cloud Run

```bash
gcloud run deploy hear-it-once --source . --region=asia-southeast1 --allow-unauthenticated \
  --min-instances=1 --max-instances=1 --memory=512Mi --set-secrets=SESSION_SECRET=hio-session-secret:latest
```

Full steps (including creating the secret) are in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Demo data resets on each deploy and re-seeds automatically.

## Demo sign-in

Staff screens use **demo role selection, not real authentication** (BRD §5 allows this for the local demo). Pick a synthetic user:

| User | Role | Can |
|---|---|---|
| Jordan Lee / Sam Rivera (demo agent) | agent | take handoffs, message the caller, approve held actions, reconcile, complete calls |
| Casey Morgan (demo QA) | qa | KPIs, cases, calls, audit log, QA reviews |
| Robin Patel (demo admin) | admin | KPIs, audit, reset demo data, inject faults, toggle agent availability — **cannot** request or approve banking actions |

Callers need no sign-in: starting a call issues a per-call token (HttpOnly cookie) that binds the browser to that one call.

## Running a scenario (60 seconds)

1. Open `/`, press **Start** on **Unrecognised transaction** (S01).
2. Say or click the suggested line, press **Say it** next to the date of birth, then **Read it to the assistant** on the simulated phone.
3. Watch the right-hand operations view: the stepper moves Understand → Verify → Investigate…, the six system lanes run concurrently, tags update, KB-101 is retrieved.
4. Press **Yes, go ahead**. Each action walks Proposed → You confirmed → Authorised → Submitted → Confirmed as the simulated systems respond.
5. **Open the brief**, then open `/dashboard.html` (one-click QA or admin sign-in) to see the call in Live operations and drill into its event trail.

All 18 scenarios are scripted in [`docs/DEMO_WALKTHROUGH.md`](docs/DEMO_WALKTHROUGH.md) and available in the scenario lab. Changes persist (a blocked card stays blocked) — scenario starts from the landing page reset that customer automatically; `npm run db:reset` resets everything.

## Documentation

| Document | Contents |
|---|---|
| [docs/PLAN.md](docs/PLAN.md) | Phase 0 assessment and stack decision |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Modules, state machines, data model, request flow |
| [docs/TRACEABILITY.md](docs/TRACEABILITY.md) | Every BRD requirement → implementation → tests → status |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Assumptions and unresolved business decisions, with conservative defaults |
| [docs/API.md](docs/API.md) | API contracts, auth, errors, pagination |
| [docs/KPIS.md](docs/KPIS.md) | Metric definitions and what can / cannot be measured locally |
| [docs/SECURITY.md](docs/SECURITY.md) | Security and privacy checklist |
| [docs/LIMITATIONS.md](docs/LIMITATIONS.md) | Known limitations; simulated vs real |
| [docs/DEMO_WALKTHROUGH.md](docs/DEMO_WALKTHROUGH.md) | Step-by-step for all 18 scenarios |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Deployment guide for this stack |
| [docs/PILOT_READINESS.md](docs/PILOT_READINESS.md) | What must be true before a controlled pilot |

## Project layout

```
src/
  api/            Fastify app, routes (calls, staff, admin), read models
  conversation/   dialogue state machine (orchestrator), message templates, formatting
  ai/             intent-model adapter (rules default, optional Anthropic) + deterministic parsers
  verification/   identity verification state machine
  retrieval/      parallel fact retrieval, freshness, conflicts, circuit breakers
  workflows/      the five issue workflows (deterministic)
  policy/         central authorisation engine + eligibility rules
  actions/        action lifecycle, consent, idempotency, timeout → unknown, reconciliation
  disputes/ cases/ handoff/ reporting/ audit/ auth/ voice/
  adapters/       typed contracts + MOCK implementations of the 9 logical bank systems
  config/         env, central policy, BRD pilot targets
  db/             migrations, seed, scenarios, illustrative history, CLI
  events/ kb/     live timeline events + SSE bus; synthetic knowledge base adapter
public/           HTML/CSS/JS (no build step): index.html + js/app.js (landing, workspace, brief), orb.js, voice.js, icons.js; dashboard, agent console, scenario lab
tests/            unit, integration, e2e (all 18 scenarios through the HTTP API)
docs/             everything above
```
