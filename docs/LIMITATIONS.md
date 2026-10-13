# Known limitations

## Simulated vs real

| Capability | In this prototype | Real integration needed |
|---|---|---|
| Customer & identity profile | **Mock** (`bank_customers`) | Bank CIF / identity platform |
| Identity verification | **Mock** DOB + OTP; OTP shown in a demo "simulated phone" panel | Bank-approved method (OTP gateway, app push, biometrics), step-up rules |
| Card status & controls (block) | **Mock** card-control system with idempotent ops log | Card management / processor API |
| Transactions | **Mock** | Authorisation & posting systems |
| Fraud alerts | **Mock** | Fraud platform |
| Previous cases | App's own case store (local) | Bank CRM / case management |
| Dispute rules & intake | **Mock** rules + intake; downstream review **simulated by admin** | Dispute platform, network rules |
| Payment posting | **Mock** | Payments / ledger |
| Fee policy & reversal | **Mock** fee ledger | Billing / ledger |
| Replacement card ordering | **Mock** | Card issuing / fulfilment |
| Human agents & transfer | **Simulated desk** — a demo agent accepts in the console | Contact-centre platform / telephony |
| Speech recognition & synthesis | Optional **browser** Web Speech (Chrome/Edge), not a server provider | Approved ASR/TTS provider |
| Telephony | **None** — text simulator | SIP/telephony provider |
| Intent model | Deterministic rules (default); optional Anthropic adapter, **not exercised against a live model** | Approved LLM provider, evaluation set |
| Customer satisfaction | **Simulated** demo survey | Real survey programme |

Each mock is a *logical* boundary; all are backed by one local database. Nothing here connects to a bank.

## Functional limitations

- **One issue per call.** "Anything else?" offers an agent rather than starting a second issue in the same case.
- **English only** (en-US). Multilingual support is not claimed.
- The rules intent model understands common phrasings of the five issue types; unusual phrasing falls back to a clarification menu and then a human, by design.
- Merchant matching is lexical (merchant names in the caller's words vs. verified records); it does not handle descriptor aliases (e.g. "Amazon" vs "AMZN MKTP").
- Replacement cards always go to the address on file; address changes are out of scope (and treated as a takeover risk signal).
- Dispute evidence is limited to the customer statement and system references; no document upload.
- The agent console is a demonstration of the brief and approval flow, not a full agent desktop (no account search, no manual card tools).
- Calls-per-agent, answer time, availability and real latency cannot be measured from local demo traffic.

## Technical limitations

- **Single process, single SQLite file.** Suitable for a local demo; not for concurrent multi-node use. Per-session locking is in-process.
- `node:sqlite` is **experimental** in Node 22 (stable API, but flagged). Pin the Node version and re-run tests on upgrades.
- No encryption at rest; TLS must be terminated by a reverse proxy.
- Demo staff authentication (role picker). No SSO/MFA.
- Circuit-breaker state is in memory (resets on restart).
- The browser-speech option depends on the browser vendor's cloud recogniser; do not use it with real customer audio.
- Google Fonts are loaded from the web; offline, the UI falls back to system fonts.

## What the tests do and don't show

130 automated tests cover business rules, state transitions, permissions, consent, idempotency, timeouts and reconciliation, privacy redaction, handoff, KPI calculations and every demo scenario end to end through the HTTP API. They do **not** demonstrate real-world handling time, fraud loss, satisfaction, availability, accuracy on real speech, or behaviour against real bank systems.
