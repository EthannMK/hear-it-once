# Northstar Bank demo: free conversation and the agent workspace

Everything here is **synthetic**. Northstar Bank is fictional. Customers, phone numbers, account references and the 16-digit card numbers are invented dummy test data. The card numbers are deliberately not valid payment numbers (they fail the Luhn check). Verification is a **demonstration check, not production identity verification**. The knowledge articles are **illustrative demo policy**.

## What the judge does
1. Open `/`. The left panel lists five demo customers with full, unmasked demo card numbers, status, transactions, fees, declines and restrictions (read from the database through `GET /api/demo/customers`).
2. Pick a customer, press **Call as ...**. The pick becomes the server-side active customer (`profileId`). It is caller-ID identification only.
3. Speak naturally. Lily asks for the card number. Try a wrong one: she says it does not match, shows attempts left and asks again. A correct retry verifies. Three wrong numbers stop the check and prepare a human handover.
4. Change topic any time ("also, what is this fee?"). The call is already verified, so the new topic is looked up straight away and the tags gain a secondary intent.
5. Ask for a person. The page shows **Waiting for a human agent** until an agent actually accepts.

## How the conversation works
Lily only handles language and turn-taking. A deterministic orchestrator holds all authority.
* Each customer utterance is classified in context. A clearly different topic (confidence at least 0.7) starts a secondary topic, even in the middle of a question.
* Tools: `handle_banking_request`, `search_knowledge_base`, `verify_card_number`, `request_human_agent`. The card tool uses the customer's own transcribed digits, never digits the model supplies. The tool result carries only matched or not and attempts remaining, never the expected number.
* Lookups (card status, transactions, fees, declines) run through the mock bank adapters. Lily states a result only when the backend returned it, and an action only when the backend confirmed it.
* Every attempt is a timeline event (`verification.retry`, `verification.passed`, `verification.failed`) shown in "Behind the conversation". Card numbers never reach audit, logs or the transcript.

## Agent workspace (`/agent.html`)
Sign in as a demo agent. The queue has Waiting, Accepted and Completed groups and updates over SSE.
* **Customer and call:** name, phone, account ref, full demo card number, duration, status, primary and secondary intents.
* **Suggested solution:** boxed and labelled AI recommendation, not a confirmed action. Reasoning, supporting facts, confirmed versus not confirmed, and a revise box.
* **Conversation:** timestamped transcript (customer, Lily, agent, system), AI summary, concerns, unresolved items, verification attempts and backend activity.
* **Knowledge:** matching articles with why they match and an "Illustrative demo policy" label.
* **CRM search:** prefilled from name, phone, account ref and intent. Editable. Card-number-like queries are refused and the query text is never audited.
* **Case management:** Accept handover, edit tags, call-reason summary, notes, resolution and next steps. Edits are validated server-side (`PATCH /api/handoffs/:id/workspace`), require acceptance, and write `agent.workspace.*` audit events.

## Configuration
| Variable | Default | Purpose |
|---|---|---|
| `LIVE_PROVIDER` | `gemini` | `gemini`, `scripted` (tests) or `off` |
| `LIVE_MODEL` | `gemini-3.8-live,gemini-3.8-live@global,gemini-live-2.5-flash-native-audio` | One or more Gemini Live model IDs, best first. Verify with `npm run check:live` |
| `LIVE_VOICE` | `Aoede` | Voice name |
| `GOOGLE_CLOUD_PROJECT` | from Cloud Run | Vertex AI project |
| `GOOGLE_CLOUD_LOCATION` | `us-central1` | Vertex AI region |
| `INTENT_MODEL` | `gemini` in Docker | `gemini` reads the whole sentence when keyword rules are unsure, with rules as fallback. `rules` is offline only |
| `INTENT_GEMINI_MODEL` | `gemini-2.5-flash` | Model used for intent classification |
| `DEMO_MODE` | on locally and in the Dockerfile | Required for `/api/demo/customers` and demo sign-in |

## Check which Live model works (Cloud Shell)
```
git clone https://github.com/EthannMK/hear-it-once && cd hear-it-once && npm ci
export GOOGLE_CLOUD_PROJECT=hear-it-once GOOGLE_CLOUD_LOCATION=us-central1
gcloud auth application-default login --no-launch-browser
npm run check:live
```
It opens a real Live session per candidate model and prints which ones work and the exact `gcloud run services update ... LIVE_MODEL=` command. You can pass your own IDs: `npm run check:live -- my-model-id`.

## Notes
* Demo-profile calls do not reset data, so an action such as a card block persists until demo data is reset by an admin.
* Simulated: the bank back end, the agent desk and the "transfer" (in-app handover, not telephony). Not tested in CI: real Gemini audio, because it needs GCP credentials and a microphone.
