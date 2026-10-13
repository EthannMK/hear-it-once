# Hear It Once — AI card-services assistant (simulated prototype)

> **This is a simulated prototype.** It uses synthetic customers and mock bank systems only. No real card, payment, dispute, fee or customer is ever affected. It is not production-ready and makes no compliance claims.

Hear It Once answers a credit-card services call without an IVR menu, discloses that it is an AI, captures the caller's issue **once**, verifies identity, checks six to seven bank systems **in parallel**, explains what those systems confirm, proposes permitted actions, executes them **only after explicit consent and deterministic policy checks**, creates a case during the call, and hands off to a person whenever asked or whenever it can't proceed safely.

It ships three screens on top of one backend:

| Screen | Path | Who |
|---|---|---|
| Caller simulator (text, plus optional browser speech) | `/` | Anyone running the demo |
| Agent console (warm-handoff briefs, approvals, outcome) | `/agent.html` | Demo agent role |
| Operations dashboard (KPIs, QA review, audit log, admin) | `/dashboard.html` | Demo QA / admin roles |

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

1. Open `/`, pick **S01 Unrecognised charge**, press **Start call**.
2. Click the suggested lines in order (or type your own): the issue, the date of birth, then **Read the code to the assistant** in the simulated-phone panel.
3. Watch *Behind the call*: verification steps, the parallel lookup lanes (all sources start together), what the systems confirm, the proposal.
4. Press **Yes, go ahead**. Each action shows its real persisted status and history.
5. Open `/dashboard.html` as the QA user to see the call in the KPIs and audit log.

All 18 scenarios are scripted in [`docs/DEMO_WALKTHROUGH.md`](docs/DEMO_WALKTHROUGH.md). Changes persist (a blocked card stays blocked) — reset from the dashboard's admin panel or with `npm run db:reset` to replay.

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
public/           HTML/CSS/JS for the three screens (no build step)
tests/            unit, integration, e2e (all 18 scenarios through the HTTP API)
docs/             everything above
```
