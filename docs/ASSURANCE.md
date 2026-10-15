# Security levels, general questions and honest not-knowing

## Two assurance levels

| Level | How it is reached | What it allows |
|---|---|---|
| basic | The call's normal check (card number, or date of birth plus passcode) | Lost or stolen card block, card status, general help, and checking a charge the customer describes |
| strong | Basic, plus the last four digits of the NRC or national ID in this call | Reading account activity aloud, and requests to change an address, phone or email |

The rule: the assistant takes what the customer says and matches it against the records. It does not volunteer what the records hold.

- Asking "what were my last charges" gets a privacy answer and a question for the shop or amount. Naming a charge gets a yes or no.
- Reading activity aloud needs the second check, then a spoken yes that it is safe to say it. It applies to one answer only.
- A contact change needs the second check, is read back twice, and is never applied by the assistant. It becomes an escalation ticket. If a fraud report, a card block or a replacement happened in the same call, it becomes an urgent ticket and a handover to a specialist. Otherwise no handover.
- Three wrong second-check answers hand over as suspected social engineering. A caller who says the account belongs to someone else gets nothing and a handover.
- Each of these decisions is written to the timeline as a "Reasoning" step. Short pauses are recorded as `call.hold` events, capped at 3 seconds.

The demo NRC digits are derived from the customer id and shown in the Test guide. Real identity data is never used.

Code: `src/conversation/security.ts`, the "sensitive requests" section of `src/conversation/orchestrator.ts`, `src/workflows/inquiry.ts`.

## General questions

`src/kb/bank-info.ts` holds fictional Northstar information: branches in Yangon, Mandalay, Naypyitaw, Manila and Cebu, hours, deposits, accounts, demo rates, loans, cards, app, transfers, complaints, contacts, scam safety. Both the typed path and the voice tool answer only from it. When it has nothing, the assistant says "I don't have that in the information I'm given" and offers an agent. Calls that only asked general questions get a call tag ("General enquiry: ...") and a call summary, and count as resolved with no case.

To add knowledge, add an entry to `INFO` (or a branch to `BRANCHES`) in that file.

## What is not tested

The scripted tests cover the typed path with rule-based intent. Real Gemini voice and the Gemini intent model are not reachable from tests, so whether the live model follows the prompt rules (match don't tell, honest not-knowing) needs a live call to confirm.
