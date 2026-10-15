# Call memory and the Agent CRM

## Call memory: the customer says it once

**Why the assistant used to repeat questions.** On a live voice call the speech model (Gemini Live) decides when to call the back end. Whenever Lily answered in her own words first ("A charge you don't recognise, is that right?"), the customer's turn was saved to the transcript, but the back end never processed it. The next tool call only carried the customer's newest words ("yes"). The back end had no issue on record, so it asked what the problem was again. The same gap lost card digits read out between tool calls, and a tool call that arrived after Lily finished speaking got no words at all. Card numbers given before the security step were dropped, and details given during it (an amount, say) were read as card digits.

**What the back end now does** (`src/conversation/facts.ts`, `observeSpeech` in the orchestrator):

- Every customer turn reaches the back end, including turns Lily answered without a tool. Details in it (amount, merchant, date, last four digits) go into the call facts. Card digits are kept in memory with the rest of the number. The words are held, in memory only, for the next back-end step of the same stage.
- Each fact has a status: `provided` (the customer said it), `confirmed` (a bank system returned it), `verified` (passed a security check), `conflicting` or `needs_clarification`, and its source. A customer statement can never raise a fact to confirmed or verified, and never overwrites one. A differing value is kept beside it and the fact becomes `conflicting`.
- Corrections ("actually it was $249") replace the customer's value and keep the earlier one in history. A different amount or merchant from the bank record is flagged and raised with one short question.
- "My card ends in 4821" is recorded as customer-provided. It is not identity verification. Lily then asks only for the full number. A full number given early is read back at the security step instead of being asked for again.
- Consent is never taken from earlier words. A "yes" Lily answered herself is not consent; the back end asks again.
- Every tool result carries `already_known`, and a reconnect recap includes it, so Lily is told what not to ask again. The back end, not the model's memory, stays authoritative.
- Facts are saved with the call (`context_json`), without full card numbers, passcodes or dates of birth. Held words and card digits live in memory only and are per call.

## Agent CRM (`/#/crm`, `src/crm/crm.ts`)

The second screen is a case workspace built from the same rows the call writes. There is no separate case store.

- **Key information:** identity, card, matched charge, fraud flags and dispute eligibility, each from records.
- **Suggested next step:** rule-based suggestions with a reason. The agent can accept, edit or reject them. A decision is recorded and audited; it never changes the account. Account actions keep their own consent and approval checks, and show as waiting for the customer, waiting for approval, sent, completed (with the bank reference), failed or unknown.
- **Case summary:** what the customer reported, what they likely want, the transaction, verification, systems checked, confirmed findings, open questions and the outcome. Anything missing says so.
- **What we know:** each fact with its status and source, including corrections and conflicts.
- **Tags and status:** category, issue type, priority, status, resolution and escalation reason come from rules in `src/config/taxonomy.ts`. Agents can change any of them; the server only accepts values from the taxonomy and rejects stale edits. Sentiment is shown as indicative only and never raises priority above high or triggers an action. Marking a case resolved also resolves the shared case record.
- **Tickets:** complaint or escalation tickets are filled in from the case: the customer's concern, summary, confirmed details, steps taken, evidence, outstanding action, priority, team and history. One open ticket per type per case. A repeated request key, or a second request, returns the existing ticket. Every handover opens an escalation ticket automatically, and a spoken formal complaint opens a complaint ticket.
- **Timeline:** the call's meaningful events plus agent decisions and ticket changes. Internal plumbing is left out.

The five demo customers have a few older, closed interactions seeded (`src/db/seed-crm.ts`), so the profile and "Earlier cases" are not empty. All data is synthetic.
