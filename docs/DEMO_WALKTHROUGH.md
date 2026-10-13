# Demo walkthrough — all 18 scenarios

**Setup:** `npm start`, open three tabs: `/` (caller), `/agent.html` (sign in as *Jordan Lee (demo agent)*), `/dashboard.html` (sign in as *Robin Patel (demo admin)* or *Casey Morgan (demo QA)*).

**In the simulator:** pick a scenario on the left → **Start call**. Suggested lines appear under the scenario; click one to put it in the input box, then press Enter. For the passcode, press **Read the code to the assistant** in the simulated-phone panel. Watch **Behind the call** for verification, parallel lookups, facts, actions (with status history), case and handoff.

**Replaying:** results persist (e.g. a blocked card stays blocked). Reset from the dashboard → *Admin: demo controls* → type `RESET SYNTHETIC DATA`, or run `npm run db:reset`.

Each scenario has an automated end-to-end test with the same ID in `tests/e2e/scenarios.test.ts`.

| ID | Steps (caller lines) | What to look for |
|---|---|---|
| **S01** Unrecognised charge | "There's a charge from Novaplay for $249 that I didn't make" → DOB 1986-04-12 → passcode → **Yes, go ahead** | Six lookups start together; facts marked *confirmed*; proposal lists block, replacement, fraud dispute (rule DR-FRAUD-01). After consent, three ✓ outcomes each with a reference; dispute "received for review — not a final decision"; case summary separates reported / confirmed / completed. |
| **S02** Lost card | "I lost my credit card" → DOB 1990-09-23 → passcode → Yes → Yes → "No, everything looks fine" | Block is the first thing offered after verification; card system confirmation time shown; then replacement; then suspicious-transaction check. Dashboard: time-to-block. |
| **S03** Duplicate, insufficient evidence | "I was charged twice at Harbor Grill" → DOB 1979-02-03 → passcode | One charge still pending → no dispute; evidence explained; agent offered. No operations created. |
| **S04** Payment pending | "I made a payment of $500 but it's not showing" → DOB 1983-11-30 → passcode | "Pending — received and waiting to settle… hasn't given a posting date, so I can't promise when." No invented date. |
| **S05** Eligible fee reversal | "Why was I charged a late fee?" → DOB 1975-06-18 → passcode → Yes | Rule FP-LATE-01 cited; reversal only after consent; ✓ confirmed by fee system. |
| **S06** Ineligible fee reversal | "Can you remove the late fee on my account?" → DOB 1992-01-27 → passcode | "A courtesy reversal has already been given in the last 12 months" + policy reference; agent offered; nothing reversed. |
| **S07** Repeat caller | "I'm calling again about my payment" → DOB 1968-08-08 → passcode | Only **after** verification: "you contacted us on … (case CASE-…) and it's still open"; recurring flag; payments specialist offered. |
| **S08** Human immediately | "I want to speak to a real person" | Handoff without pushback; status *queued* (not "transferred"). In the agent console: brief with the caller's words, unverified warning → **Accept call** → caller sees the agent join. Send a message; **Complete call**. |
| **S09** AI uncertainty | "Something is off with my stuff" → "It's the thing from before, you know" | One clarification menu, then handoff with reason "Assistant uncertain". |
| **S10** Verification fails | "There's a charge I don't recognise" → 1990-01-01 → 1990-01-02 → 1990-01-03 | Locked after 3 attempts; no passcode, no lookups, no facts; handoff "Identity verification failed". Transcript shows "[verification answer — not stored]". |
| **S11** System unavailable | "I don't recognise a QuickStream charge of $59.99" → DOB 1980-05-05 → passcode | Transaction-history lane is hatched red "Unavailable" (2 attempts); nothing changed; handoff with partial results. |
| **S12** Conflicting results | "There is a $1249 Orbit Electronics charge I never made" → DOB 1977-10-19 → passcode | Conflict banner: card system "active" vs fraud system "blocked"; no write; urgent handoff with the conflict in the brief. |
| **S13** Block fails | "My card was stolen" → DOB 1984-04-04 → passcode → Yes | ✗ "Your card is NOT blocked"; urgent handoff; brief's next step "URGENT: block the card manually". |
| **S14** Block timeout → Unknown | "Someone stole my wallet with my card" → DOB 1993-02-28 → passcode → Yes → "Can you check if it worked?" | First: "? … can't confirm it is blocked yet. I won't resend it". Action history: Submitted › Unknown. After the check: › Succeeded, attempts still 1, flow resumes with replacement. |
| **S15** Idempotency | "I lost my card" → DOB 1987-09-09 → passcode → click the suggested line **"Send consent twice"** | Two concurrent confirmations; tool result shows one block operation with 1 attempt; audit `consent.duplicate_ignored`. |
| **S16** Dispute pending | "I didn't make the Lumen Travel charge for $412.50" → DOB 1989-12-12 → passcode → Yes | Block ✓, replacement ✓, dispute "… pending — not yet filed". To see a failed submission instead: admin → faults → change S16's dispute intake fault to *Fail*. |
| **S17** Assistant unavailable | "I have a question about a fee" | Controlled system fallback message, case created with the caller's words, routed to the agent queue. Outcome *Fallback*. |
| **S18** No consent / no permission | "Please waive my late fee" → DOB 1996-06-06 → passcode → click **"Attempt without consent"** | Tool result: HTTP 422 `CONSENT_REQUIRED` with every policy check listed. QA/admin role attempts → 403 (see `npm test`). Then press **Yes, go ahead** — the legitimate path works. |

## Extra demonstrations

- **Agent approval:** set `POLICY_PROFILE=pilot-conservative` in `.env`, restart, run S05 → the reversal is held *Awaiting agent approval* and handed off; approve it in the agent console.
- **No agents available:** dashboard → admin → untick *Agents are available* → run S08 → callback fallback; nothing claimed as transferred.
- **Any fault on any customer:** dashboard → admin → *Add fault* (e.g. `customer CUS-1002 · Card status · Stale` → S02 hands off instead of blocking on stale data).
- **Speech:** in Chrome/Edge, press **Speak** and tick *Read replies aloud* — the same backend handles it, including low-confidence re-prompts and barge-in.
- **QA:** dashboard → *Recent calls* → **Review** → mark action correctness → the *Action correctness* row updates.
