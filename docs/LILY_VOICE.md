# Lily — live voice agent

Lily is the voice of Hear It Once: a two-way, interruptible conversation in the browser, built on **Gemini Live on Vertex AI**. Everything she says about a customer's account comes from the existing deterministic back end; the speech model handles language and turn-taking only.

## Journey

Landing (four demo scenarios) → **Connect with Lily** → connection animation → live call (real microphone, real playback, live transcript, "Behind the conversation" panel) → optional in-app handover to a person in the Agent console → summary with **What Lily did** → **Start another demo**.

| Screen | Where | Notes |
|---|---|---|
| Landing + call + summary | `/` (`public/lily/*`) | Stitch light design system, no build step |
| Agent console | `/agent.html` | Live over SSE (`/api/handoffs/stream`) — no refresh |
| Operations dashboard, lab | `/dashboard.html`, `/lab.html` | Same theme |
| Previous hackathon demo | `/classic.html` | Kept intact |

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
| `LIVE_MODEL` | `gemini-live-2.5-flash-native-audio` | **Confirm the current Live model ID in Vertex AI Studio and set it here** |
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
