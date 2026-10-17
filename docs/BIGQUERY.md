# Bank data in BigQuery (`ADAPTER_MODE=bigquery`)

## Two data modes, one agent

The voice agent (Lily on Gemini Live) never reads bank data herself. She calls the back end. The
back end's adapters fetch data from the bank systems, and the policy and consent rules decide what
may happen. The adapter mode decides **where** those systems live. Nothing else changes.

| | `mock` (default) | `bigquery` |
|---|---|---|
| Customers, cards, transactions, fraud alerts, payments, fees, declines, dispute rules, fee policies | Synthetic tables in the app's own SQLite file | Dataset `northstar_bank` in BigQuery, queried **live on every call** (parameterised, in parallel) |
| Identity check (card number, date of birth) | Local hashes | BigQuery `cards.pan_sha256` / `customers.dob_hash`: the caller's digits are hashed first, so BigQuery only says match or no match |
| Account changes (block, replacement, dispute, fee reversal) | Local rows | Events in BigQuery (`card_status_events`, `replacement_orders`, `dispute_submissions`, `fee_reversals`) plus `operations` (idempotency and outcome lookup) |
| Knowledge base | 11 articles + bank information in code | `kb_documents` (the same articles, bank information and about 80 Bitext banking FAQ answers) with Vertex AI embeddings; questions are matched with `VECTOR_SEARCH` |
| Call state, transcripts, cases, tickets, audit | App database | App database (unchanged; these are the CRM's records, not the bank's) |

Default stays `mock`, so every test and the current deployment behave exactly as before. You
switch to BigQuery with one environment variable.

### What happens during a call in BigQuery mode

1. The customer says what's wrong. Lily calls the back end. The orchestrator (unchanged) asks for identity.
2. The card number check runs one BigQuery query against the hash.
3. After verification, the retrieval layer reads 8 sources at once, each one a BigQuery query.
   Prior cases (the 9th source) come from the app's own case store. The "Behind the conversation"
   panel labels each source "· BigQuery".
4. Workflows and the policy engine decide. With consent, the action service calls the BigQuery
   writers. Each one checks idempotency in `operations`, writes its event, and mirrors the change
   into the app's local copy so the CRM shows it immediately.
5. The next lookup, in this call or the next, reads the card status as the loaded row overlaid
   with the newest event. A block is visible straight away.
6. When the next tester calls the same demo customer, a row in `demo_resets` makes earlier events
   stop counting, so every demo starts from the seeded state. The history stays in BigQuery.

If BigQuery is slow or fails, the existing resilience applies:
- the source shows as unavailable, and nothing is invented or decided on that data
- writes are treated as "not received", which is safe to retry
- knowledge search falls back to keywords, then to the built-in articles

Timeouts rise automatically in this mode (lookups 8 s, actions 12 s) unless you set them.

### The demo clock

The seed is written relative to "now" ("a charge 3 days ago"). BigQuery data is static, so
`dataset_meta.anchor_at` records when it was generated. Every loaded timestamp is read as
`timestamp + (now - anchor_at)`, so "3 days ago" stays 3 days ago without reloading.

### The local copy

At start-up the app replaces its local bank rows with BigQuery's, so record ids match. Disputes,
the CRM and the test panel point at those rows. Lookups during the call still go to BigQuery.
Demo card numbers stay only in the app; BigQuery holds their hashes.

## Data sources

| Source | Used for | Licence |
|---|---|---|
| Northstar synthetic seed (`src/db/seed.ts`, exported by `scripts/bigquery/export-seed.ts`) | All 67 customers, cards, the scripted demo stories, rules, policies, curated guidance, branches | This project |
| Kaggle [kartik2112/fraud-detection](https://www.kaggle.com/datasets/kartik2112/fraud-detection) ("Credit Card Transactions Fraud Detection", Sparkov simulator; listed as CC0, check the page) | Up to 250 history transactions per customer (`source = 'kaggle_sparkov'`), Kaggle's fraud label, and the full anonymised table `reference_card_transactions` for analysis | CC0 |
| Hugging Face [bitext/Bitext-retail-banking-llm-chatbot-training-dataset](https://huggingface.co/datasets/bitext/Bitext-retail-banking-llm-chatbot-training-dataset) | Up to 3 answers per banking intent (block card, find ATM, transfers, loans…) as knowledge documents, placeholders filled with Northstar wording | CDLA-Sharing-1.0 |

What is never loaded:
- **Kaggle:** card numbers, names, street addresses, dates of birth and transaction numbers are dropped.
- **Demo customers:** Kaggle history is placed 125 to 365 days back, outside the 120-day window the
  call workflows read, so the scripted demo stories behave exactly as before. Background customers
  get history across the whole last year.
- **Fraud labels:** labelled transactions get closed historical alerts only, never open ones.

## Set it up (Cloud Shell, about 10 minutes)

1. Optional: on kaggle.com → Settings → **API Tokens → Generate New Token**, copy it, and in Cloud Shell run
   `mkdir -p ~/.kaggle && echo 'YOUR_TOKEN' > ~/.kaggle/access_token && chmod 600 ~/.kaggle/access_token`
   (a legacy `kaggle.json` in `~/.kaggle/` also works).
   Without it, the Kaggle step is skipped.
2. From the repository root:
   ```bash
   git pull origin main
   bash scripts/bigquery/setup.sh
   ```
   Defaults: project `hear-it-once`, dataset `northstar_bank` in `asia-southeast1`, Cloud Run service `hear-it-once`.
   Override with `PROJECT=... LOCATION=... DATASET=...`. The script refuses project `ulink-claimflow`.

   It runs in 8 steps:
   1. enables the APIs
   2. creates the dataset and tables
   3. exports the seed
   4. downloads and prepares the Kaggle data
   5. downloads and prepares the Bitext FAQ
   6. loads everything
   7. creates a BigQuery connection and a remote `text-embedding-005` model, then embeds the knowledge documents
   8. grants the Cloud Run service account `bigquery.jobUser`, `bigquery.dataEditor` and `bigquery.connectionUser`
3. Switch the service over. The script prints this command at the end:
   ```bash
   gcloud run services update hear-it-once --region=asia-southeast1 \
     --update-env-vars=ADAPTER_MODE=bigquery,BQ_PROJECT=hear-it-once,BQ_DATASET=northstar_bank,BQ_LOCATION=asia-southeast1,BQ_EMBEDDING_MODEL=northstar_bank.embedding_model
   ```
   To go back: `gcloud run services update hear-it-once --region=asia-southeast1 --remove-env-vars=ADAPTER_MODE`.

The script is safe to re-run: it reloads reference data and resets the demo clock. Events written
during calls are kept unless you set `RESET_EVENTS=1`.

### See it working

Make a call in BigQuery mode, then in the BigQuery console:
```sql
SELECT * FROM `hear-it-once.northstar_bank.operations` ORDER BY created_at DESC LIMIT 20;
SELECT * FROM `hear-it-once.northstar_bank.card_status_events` ORDER BY created_at DESC;
SELECT merchant_category, COUNT(*) n, SUM(amount_minor)/100 spend FROM `hear-it-once.northstar_bank.transactions` GROUP BY 1 ORDER BY 3 DESC;
SELECT category, AVG(CAST(is_fraud AS INT64)) fraud_rate FROM `hear-it-once.northstar_bank.reference_card_transactions` GROUP BY 1 ORDER BY 2 DESC;
```
In the app, `GET /api/demo/environment` shows `dataSource`. The CRM customer page shows an
"Account history: live from BigQuery" card, and the call timeline labels each lookup "· BigQuery".

## Cost

The dataset is a few tens of MB, mostly the anonymised Kaggle reference table. Each call runs about
10 small queries over clustered tables, well inside BigQuery's free monthly query allowance.
Streaming inserts cost fractions of a cent. Embedding about 120 documents once, plus one short
question per knowledge search, costs very little on Vertex AI.

## What was tested, and how

- **Normal suite:** `npm test` runs 480 tests in mock mode, unchanged.
- **Failure handling:** 4 tests in `tests/bigquery/fallbacks.test.ts` (BigQuery down → unavailable or not received; knowledge fallback; timeouts).
- **Emulator:** 7 tests in `tests/bigquery/emulator.test.ts` run against the open-source
  [BigQuery emulator](https://github.com/goccy/bigquery-emulator), which uses Google's ZetaSQL parser:
  - the real `schema.sql`
  - the real export
  - every reader, the identity hashes and the local copy
  - a full call through the HTTP API (block, replacement and dispute written to BigQuery and read back)
  - idempotent writes and fee reversal
  - demo reset
  - keyword knowledge search
  - CRM history

  Run them with:
  ```bash
  ./bigquery-emulator --project=hear-it-once --dataset=northstar_bank --port=9050 &
  BQ_EMULATOR=http://localhost:9050 npx vitest run tests/bigquery
  ```
- **Not tested from the build sandbox:**
  - real BigQuery: latency, IAM, the setup script end to end
  - `ML.GENERATE_EMBEDDING` and `VECTOR_SEARCH`, which the emulator doesn't support
  - the Kaggle and Hugging Face downloads (the prepare scripts were tested on sample files with the same columns)

  Run `setup.sh` once and make one call before relying on it in front of judges.

## Where Google ADK fits (proposal, not built)

Today the agent stack is Gemini Live (voice) plus a deterministic TypeScript back end. None of it is
an ADK agent, so nothing appears under Vertex AI Agent Engine. The lowest-risk way to use ADK:

- **A "Northstar back-office agent" built with ADK (Python) and deployed to Vertex AI Agent Engine.**
  It uses ADK's built-in BigQuery tools on `northstar_bank`, plus a knowledge tool over
  `kb_embeddings`. It is read-only by design: no tool can change an account.
- **CRM:** an "Ask about this case" box, so the human agent can ask in plain words ("has she
  disputed before?", "what does the fee policy say?", "fraud rate for this merchant category?") and
  get an answer with its sources from BigQuery.
- **Lily:** her `search_knowledge_base` tool can call the same agent for general banking questions,
  with today's search as the fallback.
- **Kept as they are:** the live voice loop, verification, consent and every account action stay in
  the deterministic back end. Moving those into an LLM agent before judging would add risk and remove
  guarantees the tests prove.
