# Lily — live voice agent

Lily is the voice of Hear It Once: a two-way, interruptible conversation in the browser, built on **Gemini Live on Vertex AI**. Everything she says about a customer's account comes from the existing deterministic back end; the speech model handles language and turn-taking only.

## Journey (Northstar Bank)

One page, two interfaces. The judge page (`/`) shows **Demo customers and test data** beside the live call. Pick who you are calling as, press **Call as ...**, then talk about anything: a charge, a decline, a fee, or a new topic half way through. Nothing is scripted and no scenario is chosen. Lily asks for the **full 16-digit demo card number** (shown on screen, fictional), the server checks it, and wrong numbers are retried (three failures prepare a human handover). The agent page (`/agent.html`) is the call-centre workspace: queue, customer and call, AI summary, suggested solution, knowledge, prefilled CRM search and case management. See [NORTHSTAR.md](NORTHSTAR.md).

| Screen | Where | Notes |
|---|---|---|
| Judge: demo customers + call + summary | `/` (`public/lily/*`) | Stitch light design system, no build step |
| Agent workspace | `/agent.html` | Live over SSE (`/api/handoffs/stream`), no refresh |

There are only these two screens. Older pages redirect to `/`.

## Architecture

```
Browser mic ─16 kHz PCM16─▶ WS /api/calls/:id/live ─▶ LiveBridge ─▶ Gemini Live (Vertex AI, ADC)
Browser speaker ◀24 kHz PCM16─┘                         │  tool calls
                                                        ▼
                    handle_banking_request / request_human_agent / search_knowledge_base
                                                        ▼
        orchestrator → policy engine → action service → mock bank adapters → timeline_events (SSE/WS)
```

* **Honesty is enforced server-side.** Lily has no direct access to account data or actions. Identity verification (DOB + one-time passcode), consent, eligibility rules and idempotent actions are in the back end; consent only counts when it comes from the customer's own transcribed words. If a tool fails or is blocked, the tool result says so and Lily must relay that.
* **Barge-in.** The provider's `interrupted` signal makes the bridge tell the browser to flush queued audio at once; the interrupted turn is stored as interrupted.
* **Behind the conversation** shows real `timeline_events` (verification, lookups, policy decisions, consent, actions, knowledge searches, voice connection events). Nothing is a timer animation.
* **Handover** has distinct states — requested, waiting, accepted (and no-agent fallback) — and is an *in-app* handover to the demo agent console, not a telephone transfer.
* **Text fallback.** If voice or the microphone is unavailable, the same conversation works by typing.
* **Secrets/credentials.** The browser never sees credentials; the server authenticates to Vertex AI with the Cloud Run service identity (Application Default Credentials).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `LIVE_PROVIDER` | `gemini` | `gemini`, `off`, or `scripted` (tests only) |
| `GOOGLE_CLOUD_PROJECT` | — | e.g. `hear-it-once` |
| `GOOGLE_CLOUD_LOCATION` | `us-central1` | Vertex AI region for Live |
| `LIVE_MODEL` | `gemini-3.8-live,gemini-3.8-live@global,gemini-live-2.5-flash-native-audio` | Comma-separated, best first. The first the project can open is used; a model that cannot open is skipped for later calls. `model@location` sets a location for one entry. Gemini 3.8 Live may need access to be granted on Vertex AI |
| `LIVE_VOICE` | `Aoede` | Prebuilt voice |

## Enable on Cloud Run

```bash
gcloud services enable aiplatform.googleapis.com
PROJECT_NUMBER=$(gcloud projects describe hear-it-once --format='value(projectNumber)')
gcloud projects add-iam-policy-binding hear-it-once \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" --role=roles/aiplatform.user

gcloud run deploy hear-it-once --source . --region=asia-southeast1 --allow-unauthenticated \
  --min-instances=1 --max-instances=1 --memory=512Mi --timeout=3600 --session-affinity \
  --set-secrets=SESSION_SECRET=hio-session-secret:latest \
  --set-env-vars=LIVE_PROVIDER=gemini,GOOGLE_CLOUD_PROJECT=hear-it-once,GOOGLE_CLOUD_LOCATION=us-central1,LIVE_MODEL=<confirmed-model-id>
```

`--timeout=3600` lets a call WebSocket stay open; single instance is required for SQLite and in-process WebSocket state. Vertex AI billing/quota must be active for the project.

## What has and has not been tested

Tested automatically (`tests/e2e/live.test.ts`, `tests/e2e/frontend.test.ts`): the WebSocket bridge, tool dispatch, verification/consent/policy enforcement, small-talk and topic changes, secondary intents, barge-in handling, reconnect, handover, audit/timeline events, no inline scripts/styles under the CSP — against a **scripted stand-in** for the speech model. A browser smoke test (Playwright with a fake microphone) covered landing → call → handover accepted in the agent console in real time → summary.

**Not tested here:** the real Gemini Live connection and real human speech (no Google credentials or microphone in the build environment). Please do a real microphone test on the deployed service and confirm the model ID, voice, and echo behaviour on your device (use headphones if Lily hears herself).

## Languages and scope
The customer screen is English only. A picker chooses the call language (English, Burmese or Tagalog), sent as `?lang=en|my|fil` on the live WebSocket. Lily speaks and understands that language. Backend replies and the agent workspace stay in English. Burmese voice quality on the native-audio model is not verified from the build sandbox.
Lily answers any banking or personal-finance question from general knowledge. Facts about the test account come only from tools (`get_account_details`, `handle_banking_request`) after card-number verification. Balances and limits are not in the demo data.

## Card collection, ending a call and post-call analysis
Card collection reads back only the last four digits, waits for a yes, and uses the corrected number if the caller changes it. The full number is held in memory until confirmed and is never stored. The check has a time limit (`cardCheckTimeoutMs`, 4 s), retries once, drops duplicate checks for the same call, and reports `verified`, `not_verified`, `temporarily_unavailable` or `invalid_input`. A timeout uses no attempt. Timing and outcome counts come from `cardCheckMetrics()`.
End Call and Transfer are separate. Ending is idempotent, saves the transcript, then runs analysis, which has its own status (`pending`, `ready`, `failed`) and can be retried with `POST /api/calls/:id/analysis/retry`. A transfer marks the call `transferring` until an agent accepts. Lifecycle comes from `lifecycle()`: active, transferring, connected_to_agent, completed, failed.
`GET /api/calls/:id/transcript` returns every segment in order with a count. `GET /api/calls/:id/analysis` returns summary, reason, resolution, suggested solutions and knowledge. Agents see ended calls under "Ended calls" in `/agent.html`.
Resolution values: resolved, partially_resolved, unresolved, escalated, informational.

## Call script, card capture, agent desk
Lily follows a call-centre script (in `lily.ts`): opening, active listening, verification reason, hold protocol (ask permission, say why and how long, thank on return, check in if long), transfer, empathy and closing. The bank name is Northstar Bank.
Card digits are collected across turns and kept in memory only. Each turn says what was heard. When all 16 are heard the last four are read back and the caller confirms or corrects (a four digit reply replaces the last four). The call screen shows "What Lily heard". The live session uses a longer end-of-speech window so a pause between digit groups does not cut the caller off.
When a handover starts, the customer page embeds the agent desk (`/agent.html?embed=1&session=ID`), signed in as the demo agent and focused on that call. Pages are framed same-origin only.
From Google ADK we use the same ideas the Live toolkit documents: session resumption, context window compression, tool calls with blocking behaviour, transcription of both sides and input guardrails. ADK has no built-in call-centre script or hold features, so those are written here.
