# Fraud controls, and where every answer comes from

Two questions a reviewer should be able to answer from this page alone: what the agent is allowed to
say, and where the words it says come from. The pattern reference itself is code, in
`src/security/fraud-patterns.ts`, so a control can be traced from the attack it exists to stop to
the file that enforces it and the test that proves it.

## The rule that shapes the conversation

**The caller states the detail; the bank confirms it.** Lily does not read out a merchant, an
amount, an address or a phone number that the caller has not already given. This is the control
behind the biggest category of contact-centre abuse: the call made not to transact but to collect.
A fraudster holding a stolen card number learns nothing by calling us, because everything we
confirm, they had to know first.

It is also why the demo asks "could you tell me the amount, the merchant, or roughly when it
happened?" instead of listing recent charges. Listing them would be faster and would demo worse for
anyone who knows what the channel is actually used for.

Reading activity aloud is possible, but only after a second identity check and an explicit yes, and
only to the verified cardholder.

## Patterns and controls

| # | Pattern | Control here | State |
|---|---|---|---|
| FP-01 | Data harvesting through the service channel | Minimum disclosure: the caller names it, the bank confirms it | Enforced |
| FP-02 | Knowledge answers are not secrets (NIST SP 800-63-4) | Knowledge alone never unlocks an action; passcode or card number identifies, step-up for contact changes | Enforced |
| FP-03 | Account takeover by contact-detail change | No contact change on the call: second check, read back twice, queued for a human; replacements go to the address on file | Enforced |
| FP-04 | Bank impersonation and the "safe account" scam | Warning given in plain words, nothing changed, urgent handover | Enforced |
| FP-05 | Card-number testing | Three attempts, then the path closes; no hint about the right number | Enforced |
| FP-06 | Pressure and the sympathetic story | The requirement lives in the back end, not the agent's judgement | Enforced |
| FP-07 | Instructions planted in caller speech | Caller words are data; the model cannot grant verification or consent | Enforced |
| FP-08 | Third-party and coached callers | Only the checked cardholder is discussed; third party goes to a person | Enforced |
| FP-09 | Claiming success that did not happen | Every outcome cites a recorded operation; failures are stated as failures | Enforced |
| FP-10 | Spoofed caller ID and voice cloning | Out of scope: no telephony layer here, and no caller is trusted on their number or voice | Out of scope |

Tests: `tests/e2e/fraud-controls.test.ts`, `tests/e2e/security.test.ts`, `tests/e2e/live.test.ts`,
and the generated-conversation invariants in `tests/fuzz/`.

## Where the data comes from

Nothing in this system is answered from the open web or from the model's own memory.

| Answer | Source | Notes |
|---|---|---|
| Customer, cards, transactions, fraud alerts, disputes, fees, payments | Mock bank adapters, `src/adapters/mock/` | Synthetic data for a fictional bank. No real customer data exists in this project |
| General bank questions (hours, ATM limits, fees, transfers, passwords) | `src/kb/bank-info.ts` | A fixed, written knowledge base. When it has no entry, Lily says so rather than guessing |
| Policy decisions (what needs verification, what needs consent, eligibility) | `src/config/policy.ts` and the workflows in `src/workflows/` | Deterministic, server-side |
| Identity checks | `src/verification/` | One-time passcode to the registered number, or card number held by the caller |
| What Lily says | Gemini Live on Vertex AI | The model phrases and listens. It decides no fact: every figure, status and outcome comes from the sources above through a tool call the back end gates |
| Fraud-pattern reference | `src/security/fraud-patterns.ts` | Compiled from the published sources below |

Because the knowledge base is fixed and written, this build does not use Google Search grounding.
Adding open-web grounding to a banking agent would introduce exactly the risk the controls above
exist to prevent, and nothing in the demo needs it.

## Sources for the fraud patterns

- SecureLogix, *Call Center Fraud*: attack sequence (information gathering, pretext call, agent
  social engineering, IVR mining, fraudulent action), and controls including restricting agent
  access to sensitive data. https://www.securelogix.com/topics/call-center-fraud
- Federal Reserve FedPayments Improvement, *Account Takeover Fraud: Detection and Prevention by
  Channel*: phone-channel pretexts, red flags, and enhanced verification for address and phone
  changes, resets and card replacement.
  https://fedpaymentsimprovement.org/wp-content/uploads/account-takeover-fraud-detection-prevention-channel.pdf
- Parloa knowledge hub, *Is KBA still safe?*: knowledge-based authentication weaknesses, and NIST
  SP 800-63-4 treating knowledge answers as unacceptable. Vendor-published; the NIST position is
  the part relied on here. https://www.parloa.com/knowledge-hub/is-kba-still-safe/
- Sardine, *Bank impersonation scams*: the "safe account" script step by step, and the two things a
  real bank never asks for. https://www.sardine.ai/learn/bank-impersonation-scam
- OWASP Top 10 for LLM Applications, LLM01 prompt injection, applied to a voice channel.

Figures cited in those sources (for example TransUnion's finding that 6% of US contact-centre calls
in 2024 were high risk for fraud) are theirs, not measurements of this system.
