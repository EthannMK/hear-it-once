# Pilot-readiness checklist

BRD §18 defines three gates. This prototype targets the first one only.

## Gate 1 — Prototype demo gate

| Criterion | Status |
|---|---|
| All 18 required scenarios run end to end | ✅ UI + automated API tests |
| Backend outcomes persist across restarts | ✅ |
| Safety-negative tests pass (verification, consent, permission, stale/conflicting data, failures, timeouts, duplicates) | ✅ |
| Dashboard values derive from stored events | ✅ |
| Mocked integrations clearly disclosed (UI banner, labels, docs) | ✅ |

## Gate 2 — Controlled pilot gate (not met; all items open)

**Business & policy**
- [ ] Operating model decided (assistant-led vs agent-assist) — DECISIONS D1
- [ ] Pilot issue types selected — D2
- [ ] Autonomous-action policy approved by fraud, disputes, risk and compliance — D3 (until then: `pilot-conservative`, human approval for all card actions)
- [ ] Dispute rules, fee-waiver rules and limits replaced with approved bank policy
- [ ] Fallback when no agent is available approved — D11

**Identity & security**
- [ ] Bank-approved identity verification and step-up rules integrated — D4
- [ ] Staff SSO/MFA replaces the demo role picker; agent permissions mapped to real roles
- [ ] Threat model and penetration test completed; findings fixed
- [ ] Encryption at rest; TLS end to end; secrets in a managed vault
- [ ] PCI DSS scope assessment (voice channel can carry card numbers even though the system never stores them)
- [ ] Data residency and retention schedule approved — D8

**Integrations**
- [ ] Real adapters implemented against confirmed API contracts for each system; freshness semantics agreed — D5
- [ ] Integration tests against bank sandboxes, including failure, timeout and reconciliation behaviour of each write API (idempotency-key support confirmed per system)
- [ ] Telephony, ASR and TTS providers approved; latency and accuracy measured on representative audio — D9
- [ ] LLM provider (if any) approved; evaluation set for intent classification with accuracy thresholds

**Legal & customer experience**
- [ ] AI-disclosure and call-recording wording approved for the jurisdiction
- [ ] Accessibility review of the voice experience
- [ ] Supported languages confirmed and tested — D7

**Operations & measurement**
- [ ] Four-week real baseline captured; KPI definitions signed off — D6
- [ ] Human oversight model: QA sampling rate, daily review of handoffs and action outcomes
- [ ] Monitoring and alerting (availability, integration failures, unknown operations, safety incidents) and incident runbook
- [ ] Kill switch to route all calls to agents

## Gate 3 — Production gate (not in scope)

Independent security, privacy, legal/compliance, resilience, access-control, data-retention, vendor and operational reviews. This BRD and prototype confer no production approval.
