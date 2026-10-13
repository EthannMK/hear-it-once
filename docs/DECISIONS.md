# Assumptions and unresolved decisions

This file separates what the **BRD requires**, what was an **implementation decision**, what is an **assumption**, and what remains an **unresolved business decision**. No assumption here is approved bank policy. Every unresolved decision has a conservative mock-mode default, all held centrally in `src/config/policy.ts` unless noted.

## Unresolved business decisions (BRD §17)

| # | Decision | Alternatives | Prototype default | Needed before pilot | Owner |
|---|---|---|---|---|---|
| D1 | Operating model | Assistant-led · agent-assist | Assistant-led text simulation | Business owner approval | Sponsor |
| D2 | Pilot issue types | All five · subset | All five in mock mode | Sponsor picks subset | Sponsor |
| D3 | Which actions may run without a human | None · block only · block + replacement · all four within limits | `prototype-mock`: all four autonomously **in mock mode only**. `pilot-conservative`: every consequential action held for agent approval. Any non-mock adapter mode **forces** `pilot-conservative`. | Fraud, disputes, risk, compliance approval | Risk |
| D4 | Identity method & step-up | Knowledge + OTP · voice biometrics · app push · agent-only | Synthetic DOB + OTP (two factors); 3 attempts; no step-up beyond risk-based handoff | Bank-approved method and step-up rules | Fraud / security |
| D5 | Priority systems & contracts | 6–8 real systems | 8 logical mock read adapters + 4 write adapters | System owners confirm APIs, SLAs, freshness semantics | Integration |
| D6 | Baseline & KPI definitions | — | Seeded illustrative history + measured demo calls, both labelled synthetic | Four-week real baseline; metric sign-off (resolution, repeat, rework) | Operations |
| D7 | Language support | — | English (en-US) only | Launch languages confirmed and tested | Product |
| D8 | Legal / compliance / retention | — | Synthetic data only; transcript retention 30 days (configurable); no recording | Jurisdiction review, recording consent wording, retention schedule, PCI DSS scope | Legal / compliance |
| D9 | Voice, telephony, hosting providers | — | No paid provider; text simulator; optional browser speech | Provider, security, cost approval | IT / procurement |
| D10 | Dispute "accepted without rework" definition | — | Simulated downstream review set by admin; excluded until set | Dispute team definition | Disputes |
| D11 | Fallback when no agent is available | Callback · voicemail · retry queue · overflow vendor | Callback request recorded on the case; call ends; nothing claimed as transferred | Ops approval of fallback and SLA | Operations |

## Policy assumptions (all in `src/config/policy.ts`)

| Parameter | Value | Why this default |
|---|---|---|
| Consent required for block, replacement, dispute, fee reversal | Yes | BRD: explicit confirmation before consequential actions |
| Consent lifetime | 10 minutes | Long enough for a call, short enough to prevent stale consent |
| Verification attempts | 3 per factor; OTP TTL 5 min; 6 digits | Common industry pattern; to be replaced by bank policy |
| Fraud dispute rule `DR-FRAUD-01` | ≤120 days, ≥ $1.00, card-not-present / swiped / contactless only, card must be blocked first; chip-and-PIN goes to an agent | Conservative stand-in for network rules |
| Duplicate rule `DR-DUP-01` | Both posted, same merchant + amount, ≤24 h, distinct authorisations, no merchant credit | Avoids disputing pending authorisations that drop off |
| Incorrect amount `DR-AMT-01` | Agent-only (needs receipt) | Documentation can't be gathered by the assistant |
| Fee reversal `FP-LATE-01` | Late fee only, ≤ $40, 1 per 12 months, good standing | Typical courtesy-waiver policy; placeholder |
| Staleness limits | Card 2 min, fraud 5 min, transactions/payments/cases 15 min, fees/profile 1 h, rules 24 h | Card status must be near-real-time for a block decision |
| Snapshot age for a write | 15 min | Forces a refresh on long calls |
| Read timeout / retries / breaker | 1.5 s, 1 retry, open after 3 consecutive failures for 30 s | Keeps total retrieval well under the 2-minute stage target |
| Action timeout | 2 s → Unknown | Mock systems reply in <0.3 s; real values come from SLAs |
| Intent confidence threshold | 0.6; one clarification, then handoff | Prefer a human over a guess |
| Account-takeover signals | Contact details changed in last 14 days, or open ATO alert → no actions, handoff | Conservative |
| Third-party caller | Handoff (no authority to act for someone else) | Conservative |

## Implementation decisions

| Decision | Reason |
|---|---|
| Node 22 + TypeScript + Fastify + Zod + SQLite (`node:sqlite`) | Empty repo; BRD prefers SQLite and zero-cost local setup; built-in driver avoids native builds. `node:sqlite` is marked experimental in Node 22 — warning suppressed in npm scripts; pin Node and re-test on upgrade. |
| No-build vanilla JS frontend | One `npm install`; UI is a thin client over the API |
| Deterministic rules intent model by default | Free, offline, testable; optional LLM adapter behind config |
| Case summary is deterministic from persisted rows (not LLM-generated) | Guarantees the summary matches what systems confirmed and what actions actually did; an LLM summariser could be added for wording only |
| One issue per call; "anything else" → agent | Keeps one case per session; documented limitation |
| Per-customer circuit breakers in mock mode | Mock faults are injected per synthetic customer; a real deployment uses one breaker per downstream system (switches automatically by adapter mode) |
| Demo OTP shown in a labelled "simulated phone" panel, only to the caller, only with `DEMO_MODE=true` (refused in production) | Lets the demo run without SMS while keeping the possession factor in the flow |
| Demo staff sign-in (pick a role) | BRD §5 permits labelled demo-role selection for the local demo |

## Assumptions about the demo data

- All customers, cards (last 4 only), phone numbers (fictional 555-01xx range), dates of birth, merchants and amounts are invented.
- Seeded illustrative call history (220 calls over 28 days) is generated with a fixed seed so dashboards are reproducible; it is labelled `seeded_illustrative` everywhere and can be excluded with the dashboard's data filter.
- Simulated latency is random within fixed bounds; it says nothing about real system performance.
