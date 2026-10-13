# KPI definitions

Every metric is computed at request time by `src/reporting/kpi.ts` from persisted rows. No value is hard-coded. Each metric returns its definition and sample size (`n`). Targets come from `src/config/targets.ts` and are returned separately, never as observed values.

**All data in this prototype is synthetic.** "Measured demo calls" are calls actually run through the simulator; "Seeded illustrative" calls are generated history. Neither is evidence of real-world performance.

| Metric | Calculation | Proposed pilot target (BRD) | Measurable locally? |
|---|---|---|---|
| Call volume / eligible calls | Sessions in window / sessions classified into the five issue types | — | Yes |
| Average handling time | Mean (ended − answered) for ended eligible calls; includes agent time after handoff; excludes abandoned | ≥40% lower than baseline | Absolute value only — **needs a real baseline** |
| Wait / hold | Mean per ended call of recorded hold intervals (agent queue) | ≤1 min | Yes (simulated desk) |
| First-call resolution | Eligible ended non-abandoned calls with outcome `resolved` (resolution resolved/informational, no handoff, no unknown op) | ≥60% | Yes |
| Repeat contact ≤7 days | Verified eligible calls where the same customer called about the same issue in the previous 7 days | 20% fewer than baseline | Rate only — **needs baseline** |
| Customer repetition | Eligible calls with a restatement request, or flagged by QA / receiving agent | <5% | Yes |
| Block within 60 s | Applicable calls with a **confirmed** block ≤60 s after verification ÷ applicable calls (failed/unknown/declined count against) | ≥95% | Yes |
| Disputes without rework | Submitted disputes with a simulated "no rework" review ÷ submitted disputes with a simulated review | ≥90% | **Simulated only** |
| Handoff rate & reasons | Calls with a handoff request ÷ calls; reasons breakdown | — | Yes |
| Satisfaction & mood | Mean demo survey score; mood labels are simulated selections, not AI inference | Not below baseline; +10 | **Simulated only** |
| Calls per agent per shift | Completed handoffs per (agent, 8-hour block) | 50 (~78 illustrative ceiling) | **Not meaningful** with demo traffic |
| Case before call end | Resolved calls with case-created ≤ session-ended | ≥95% | Yes |
| Action correctness & safety | QA-sampled calls with a correct consequential action ÷ sampled; safety incidents counted separately | ≥95%; zero wrong card actions | Yes (QA workflow) |
| Integration failure & latency | Non-ok integration calls ÷ all; p50/p95 per source | — | Yes (mock latency) |
| AI / voice failures | Model errors, assistant-unavailable fallbacks, orchestrator errors, low-confidence speech | — | Yes |
| Unresolved operations | Ops currently unknown, pending downstream, or awaiting approval | — | Yes |
| Stage: retrieval / proposal / execution | p90 of (retrieval end − start), (proposal − retrieval end), (last outcome − consent) | ≤2 min / ≤2 min / ≤2.5 min on ≥90% | Yes — but mock latency is not real latency |
| Agent join | p90 of (connected − handoff requested) | ≤30 s | Simulated desk only |
| Answer time / availability | — | ≤30 s; ≥99.5% | **Needs real telephony and monitoring** |

Passing unit tests does not mean any target is met.
