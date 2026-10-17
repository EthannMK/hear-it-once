# Hear It Once — AI card-services assistant (simulated prototype)

> **This is a simulated prototype.** It uses synthetic customers and mock bank systems only. No real card, payment, dispute, fee or customer is ever affected. It is not production-ready and makes no compliance claims.

Hear It Once answers a credit-card services call without an IVR menu, discloses that it is an AI, captures the caller's issue **once**, verifies identity, checks six to seven bank systems **in parallel**, explains what those systems confirm, proposes permitted actions, executes them **only after explicit consent and deterministic policy checks**, creates a case during the call, and hands off to a person whenever asked or whenever it can't proceed safely.

> **One conversation. Every action handled. Nothing lost.**

Four screens on one backend:

| Screen | Path | Who |
|---|---|---|
| Demo instructions — how to drive the demo, and the five test accounts with their card and phone numbers ready to copy | `/#/demo` | Anyone |
| Customer page — a live voice call with Lily, with the chosen account beside it | `/` | Anyone |
| Agent workspace — overview, transactions, conversation, case and requests, timeline, knowledge, and an AI copilot alongside | `/#/crm` (the call page flips here when a call is handed over) | Demo agent role, signed in automatically |
| Guardrails — how each safeguard is built, then the evidence: the off switch, the audit log checked against its own hashes, the last accuracy run, the fraud patterns | `/#/guardrails` | Anyone |

English and Tagalog take calls. Burmese is built — prompt, voice and agent name — but switched off
until its quality is good enough to put in front of a customer; the switch to it is refused in the
bridge rather than discouraged in the prompt.

### What's real and what's simulated

| Real (the application) | Simulated (replaceable adapters) |
|---|---|
| Conversation state machine, verification flow, policy/eligibility engine, consent, idempotency, timeout → unknown → reconciliation, cases, handoff briefs, audit, timeline events, SSE stream, KPIs | All 9 bank systems, the identity passcode (shown on a simulated phone), the 9-article knowledge base (synthetic guidance, not bank policy), the agent desk, and the seeded illustrative history |
| The voice itself runs on the Gemini Live API: speech to speech in one model, with barge-in. Typing always works and is the fallback when the microphone is denied or the model is unavailable | Nothing is recorded; audio is streamed, and only the transcript is stored |

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
| `npm test` | Run the test suite (unit, integration, API end-to-end; 647 at the last count) |
| `npm run typecheck` | TypeScript type check |
| `npm run check:secrets` | Fail if source contains secrets or full card numbers |
| `npm run audit:deps` | `npm audit` of runtime dependencies |

Data lives in `data/hear-it-once.db` and **persists across restarts**. Tests use an in-memory database.

## Talk to Lily (live voice)

The home page is a live two-way voice agent (Gemini Live on Vertex AI) for the fictional **Northstar Bank**: demo customers and test data beside the call, card-number verification with retries, a real-time “Behind the conversation” panel, in-app human handover and a post-call summary. The agent console is a call-centre workspace (suggested solution, knowledge, CRM, case edits with audit). See [docs/NORTHSTAR.md](docs/NORTHSTAR.md) and [docs/LILY_VOICE.md](docs/LILY_VOICE.md) for architecture, configuration and what is/isn't verified.

## Deploy to Google Cloud Run

```bash
gcloud run deploy hear-it-once --source . --region=asia-southeast1 --allow-unauthenticated \
  --min-instances=1 --max-instances=1 --memory=512Mi --set-secrets=SESSION_SECRET=hio-session-secret:latest
```

Full steps (including creating the secret) are in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Demo data resets on each deploy and re-seeds automatically.


### The back-office agent (Google ADK on Vertex AI Agent Engine)

The agent behind the **AI back office** panel on the agent's screen is built with the Google Agent
Development Kit and runs on Vertex AI Agent Engine. It reads BigQuery through read-only `agent_*`
views and cannot change an account.

```bash
bash agents/backoffice/deploy.sh                    # prints the reasoningEngines/... resource name
gcloud run services update hear-it-once --region=asia-southeast1 \
  --update-env-vars AGENT_ENGINE_RESOURCE=<that resource name>
```

Without `AGENT_ENGINE_RESOURCE` the same panel answers from the bank records with built-in queries,
and says so. Details in [docs/BIGQUERY.md](docs/BIGQUERY.md); the SQL guards are covered by
`python -m pytest agents/backoffice/test_tools.py`.
## Demo sign-in

Staff screens use **demo role selection, not real authentication** (BRD §5 allows this for the local demo). Pick a synthetic user:

| User | Role | Can |
|---|---|---|
| Jordan Lee / Sam Rivera (demo agent) | agent | take handoffs, message the caller, approve held actions, reconcile, complete calls |
| Casey Morgan (demo QA) | qa | KPIs, cases, calls, audit log, QA reviews |
| Robin Patel (demo admin) | admin | KPIs, audit, reset demo data, inject faults, toggle agent availability — **cannot** request or approve banking actions |

Callers need no sign-in: starting a call issues a per-call token (HttpOnly cookie) that binds the browser to that one call.

## Trying it (60 seconds)

1. Open `/`, pick a test identity and press **Start talking to Lily**.
2. Ask anything about banking. For questions about the test account, read the full dummy card number shown on screen when Lily asks. A wrong number gets a retry, three wrong ones prepare a handover.
3. Say "I want to speak to a person" and the screen hands over by itself: the agent workspace opens on that case with everything Lily found already on it. Accept the handover and carry on talking. Ending the call normally takes you to the same case.
4. Open **3 · Guardrails**: the seven things that hold the system together in plain sentences, then the evidence behind them — where the off switch stands, the audit log checked against its own hashes while you watch, the last accuracy run, and the ten fraud patterns the call policy answers with the file that enforces each.

`npm run db:reset` resets all demo data. `npm run scorecard` plays every scenario and rewrites
[docs/ACCURACY.md](docs/ACCURACY.md).

## Documentation

| Document | Contents |
|---|---|
| [docs/BIGQUERY.md](docs/BIGQUERY.md) | Bank data and knowledge in BigQuery (`ADAPTER_MODE=bigquery`), Kaggle and Bitext data, setup script, and the ADK back-office agent on Agent Engine |
| [docs/CRM.md](docs/CRM.md) | Call memory (structured facts) and the Agent CRM: summary, tags, suggestions, tickets |
| [docs/PLAN.md](docs/PLAN.md) | Phase 0 assessment and stack decision |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Modules, state machines, data model, request flow |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Assumptions and unresolved business decisions, with conservative defaults |
| [docs/API.md](docs/API.md) | API contracts, auth, errors, pagination |
| [docs/KPIS.md](docs/KPIS.md) | Metric definitions and what can / cannot be measured locally |
| [docs/SECURITY.md](docs/SECURITY.md) | Security and privacy checklist, including the off switch, the tamper-evident audit log and what is done about prompt injection |
| [docs/ACCURACY.md](docs/ACCURACY.md) | What the assistant gets right, measured by a run rather than asserted (`npm run scorecard`) |
| [docs/FRAUD_CONTROLS.md](docs/FRAUD_CONTROLS.md) | The documented contact-centre fraud patterns the call policy answers, and where each control lives |
| [docs/LIMITATIONS.md](docs/LIMITATIONS.md) | Known limitations; simulated vs real |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Deployment guide for this stack |
| [docs/PILOT_READINESS.md](docs/PILOT_READINESS.md) | What must be true before a controlled pilot |

## Licence

MIT — see [LICENSE](LICENSE). The third-party datasets behind the BigQuery mode keep their own
terms: the Sparkov transaction history from Kaggle is CC0 and the Bitext retail-banking FAQ is
CDLA-Sharing-1.0. Both are listed with their sources in [docs/BIGQUERY.md](docs/BIGQUERY.md).

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
  crm/            Agent CRM read model, tags, suggestions, tickets
  disputes/ cases/ handoff/ reporting/ audit/ auth/ voice/
  adapters/       typed contracts + MOCK implementations of the 9 logical bank systems
  config/         env, central policy, BRD pilot targets
  db/             migrations, seed, scenarios, illustrative history, CLI
  events/ kb/     live timeline events + SSE bus; synthetic knowledge base adapter
public/           HTML/CSS/JS, no build step: index.html, lily/app.js (the call), lily/crm.js
                  (the agent workspace), lily/demo.js (instructions), lily/safety.js (guardrails)
tests/            unit, integration, e2e (all 18 scenarios through the HTTP API)
docs/             everything above
```
