# Hear It Once — handover

An AI banking voice assistant demo for a Google hackathon. Lily runs on Gemini Live for the
fictional **Northstar Bank**, and a human agent picks the call up in a CRM built into the same app.

Read this first, then the code. Where this file and the code disagree, the code is right.

## Getting started

```bash
git clone https://github.com/EthannMK/hear-it-once.git && cd hear-it-once
git pull origin main          # head should be 4988959 or later
npm ci && npm test            # expect 506 passed, 7 skipped
python3 -m pytest agents/backoffice/test_tools.py -q   # expect 23 passed
PORT=3100 npm start           # mock mode; typing works with no Google credentials
```

Rules that hold throughout:

- Commit as `EthannMK <ethan.clouddev@gmail.com>`.
- **Never touch the GCP project `ulink-claimflow`.**
- Never commit tokens.
- GCP project `hear-it-once`, region `asia-southeast1`, Cloud Run service `hear-it-once`.
- Check the UI at 1280x720, 1366x768, 1440x900 and 1920x1080 before pushing. Chromium is at
  `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`. The caller's screen must not scroll; the
  agent's screen may use more room when it needs it.

## Deploying

```bash
gcloud auth login
gcloud config set project hear-it-once

# 1. the app
gcloud run deploy hear-it-once --source . --region=asia-southeast1

# 2. the ADK back-office agent on Vertex AI Agent Engine
bash agents/backoffice/deploy.sh      # prints projects/.../reasoningEngines/NNNN

# 3. point the app at it
gcloud run services update hear-it-once --region=asia-southeast1 \
  --update-env-vars AGENT_ENGINE_RESOURCE=<the resource name from step 2>

# check which build is live
curl -s "$(gcloud run services describe hear-it-once --region=asia-southeast1 --format='value(status.url)')/api/health"
```

`/api/health` returns the Cloud Run revision, so you can tell whether your build is the one serving.
Start a fresh call after any deploy: the instance restarts.

BigQuery mode (`ADAPTER_MODE=bigquery`) is set up by `scripts/bigquery/setup.sh`. The transactions
table gained card-system columns; the script carries `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for
datasets that already exist.

## How it fits together

| Part | Where |
|---|---|
| Voice loop (Gemini Live on Vertex) | `src/live/` — `bridge.ts` holds the session, `tools.ts` the server-gated tools, `lily.ts` the prompt |
| Conversation state machine | `src/conversation/orchestrator.ts` (~2,000 lines; stages, verification, consent, handover) |
| Banking workflows | `src/workflows/` (one file per issue type) |
| Bank records | `src/adapters/mock/` for the simulated bank, `src/adapters/bigquery/` for BigQuery mode |
| Agent CRM read model | `src/crm/crm.ts` and `src/workspace/workspace.ts` |
| AI back office | `src/backoffice/backoffice.ts` (app side) and `agents/backoffice/` (the ADK agent) |
| Caller's screen | `public/lily/app.js` |
| Agent's screen | `public/lily/crm.js` |
| Styles | `public/lily/lily.css` (one file, CSS variables at the top) |
| Fraud controls reference | `src/security/fraud-patterns.ts`, explained in `docs/FRAUD_CONTROLS.md` |

## What was built in this session (commits 01b47ee, 0b46727, 4988959)

**The blocked/active contradiction is fixed.** `refreshDemoFixtures` in `src/db/seed.ts` puts the
bank records back when the same demo customer calls again. It now also records a `demo_data_reset`
event on that customer's earlier cases, and the summaries say so, so a case can never be read as
the account's current state. Covered by `tests/e2e/repeat-call.test.ts`.

**Transactions carry what a card agent works from.** New columns (`mcc`, `merchant_city`,
`merchant_country`, `network_ref`, `acquirer`) in migration `007_txn_detail.sql`, derived in
`src/db/txn-detail.ts` from the transaction id so a row always reads the same. `backfillTxnDetail()`
fills older databases at startup. The same columns flow through BigQuery: `scripts/bigquery/schema.sql`,
`agents/backoffice/views.sql`, `src/adapters/bigquery/replica.ts`, and both loaders.

**The agent screen is tabbed rather than a stack of cards.** Three panels, each with tabs:

- customer: Account · Transactions · History
- case: AI summary (with the status and priority tagging) · Actions · Requests
- right: AI back office · Timeline · Conversation

A tab that needs the room takes the whole screen and the other columns step aside
(`focusPanel` in `crm.js`, `.cx-grid.focus-*` in the CSS). Transactions open as a full-width ledger;
History is one block per earlier call. The line that matters most from the history — the last call
and whether it is still open — also appears in the AI panel.

**Brand and animation.** New SVG marks at `public/brand/`, a new `public/favicon.svg`, and the tab
title is now "Hear It Once". The hero animation is a statement row being found, checked and settled,
drawn on canvas from the call's own state (`heroLedger` and `drawLedger` in `app.js`).

**The seat-change scene** holds for ten seconds (`SCENE_MS`), counts down, and has a "Stay on this"
button that pauses it.

**Tests added.** `tests/e2e/backoffice.test.ts` (parseEngineStream, shapeAnswer, built-in answers,
accountOverview, `/api/crm/latest`), `tests/e2e/repeat-call.test.ts`, transaction-reference tests in
`tests/unit/intent-parsers.test.ts`, and `agents/backoffice/test_tools.py` for the SQL refusals
against a fake BigQuery client.

## What is left

1. **Deploy and check the agent end to end.** Not done: the deploy needs Ethan's gcloud session.
   Once `AGENT_ENGINE_RESOURCE` is set:
   - Confirm `parseEngineStream` matches what the real `:query` and `:streamQuery` return. The unit
     tests cover the documented shapes (newline JSON, `data:` lines, camelCase parts), but nobody
     has seen a real response yet. If it differs, fix the parser and add the real shape to the test.
   - Confirm `agents/backoffice/views.sql` compiles in BigQuery, including the new columns.
2. **Priority plus skills-based call routing** (optional, from the original brief). Nothing started.
3. **The Kaggle history rows** get `mcc`, `merchant_country` and references from
   `scripts/bigquery/prepare_kaggle.py`, but that has not been run against the real CSV in this
   session. Run it before relying on BigQuery mode in front of judges.
4. **A design decision Ethan has not made:** whether date of birth should be asked on top of the
   card number. It is deliberately out. Date of birth is knowledge-based, sits in every breach dump,
   and NIST retired it as an authenticator; see FP-02 in `docs/FRAUD_CONTROLS.md`. If a judge asks
   for it, add it as a policy switch, off by default, and keep the passcode as the real check.
5. **Outstanding question from the judges' Q&A**, listed in the session but not resolved: they
   prefer ADK and Agent Engine for the whole agent, and mention Memory Bank. Only the back office
   uses ADK today; the voice loop and the state machine are our own TypeScript on Cloud Run. Moving
   them would mean rebuilding the verification and turn-taking that the tests cover. Ethan was
   deciding whether that is a hard requirement.

## Things that will catch you out

- **The CSP is strict.** No inline `<script>` or `<style>` in any page under `public/`. Put code in
  a `.js` file and styles in a `.css` file, or the browser silently refuses to run them.
- **`npm test` needs `npm ci` first.** Without `@google-cloud/bigquery` installed, whole test files
  fail to load and the failure looks unrelated.
- **The dev database is `./data/hear-it-once.db`,** not whatever you pass as `DB_PATH`. The env var
  is `HIO_DB_PATH`. Seeding happens once; a schema change needs either a fresh database or a
  backfill like `backfillTxnDetail`.
- **`tsx` does not reload.** Restart the server after changing anything under `src/`.
- **Do not `pkill -f "tsx src/server.ts"`** — it kills the shell that runs it. Loop over
  `pgrep -f "[t]sx src/server.ts"` and `kill` each pid.
- **The privacy test is doing its job.** `tests/e2e/scenarios.test.ts` scans every stored row for
  anything that passes a Luhn check. It caught a reference generator that printed negative numbers
  as hyphenated digit groups. If it fails, look at what you just added before assuming it is flaky.
- **The caller's screen polls** every two seconds while queued or in typed mode; there is no
  websocket push in typed mode. Give it a moment in browser tests rather than reloading.
- **When the agent accepts a handover the caller's screen moves to the agent's seat** after a few
  seconds. In a browser test, click "Stay on the caller's screen" if you need to keep typing as the
  customer.

## Working agreements with Ethan

- Short sentences, plain English, no bullet-point walls in chat. Sign off as **Paing Thit Htoo**.
- Say plainly what was tested and what was not. Never claim a deployed check that was not run.
- Code comments read like documentation for the next developer: why, not a log of the investigation.
  Never name him in a comment.
- He sends defects one at a time and expects them logged before they are fixed.
