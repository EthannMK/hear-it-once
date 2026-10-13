# API reference

Base URL: `http://127.0.0.1:3000`. All bodies are JSON. All writes require `Content-Type: application/json` (form posts are refused — CSRF hardening). Responses carry `Cache-Control: no-store` and a strict CSP.

## Authentication

| Principal | How | Scope |
|---|---|---|
| Caller | `POST /api/calls` returns `callToken` and sets the HttpOnly, SameSite=Strict cookie `hio_call` (path `/api/calls`). Send the cookie or `X-Call-Token`. | Exactly one call session |
| Staff (demo) | `POST /api/auth/demo-login` sets the signed HttpOnly cookie `hio_staff` (8 h). **Demo role selection, not production auth.** | Role permissions loaded from `role_permissions` |

## Errors

```json
{ "error": { "code": "CONSENT_REQUIRED", "message": "Explicit customer consent is required for this action.", "details": { } } }
```

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_FAILED` | 400 / 415 | Body, query or header invalid (zod issues in `details`) |
| `UNAUTHENTICATED` | 401 | No caller token / staff session |
| `FORBIDDEN` | 403 | Role lacks the permission, or token belongs to another call |
| `VERIFICATION_REQUIRED` | 403 | Caller not verified for this customer |
| `NOT_FOUND` | 404 | |
| `CONFLICT` | 409 | State does not allow the operation |
| `IDEMPOTENCY_MISMATCH` | 409 | Same Idempotency-Key, different parameters |
| `OPERATION_OUTCOME_UNKNOWN` | 409 | Retry refused: reconcile first |
| `CONSENT_REQUIRED` / `POLICY_DENIED` / `SOURCE_DATA_UNSAFE` | 422 | Policy engine refused (checks in `details.operation.policy_decision`) |
| `RATE_LIMITED` | 429 | |
| `INTERNAL` | 500 | Generic message only; "No action was taken." |

## Pagination

List endpoints take `limit` (≤100, audit ≤200) and an opaque `cursor`; responses return `{ items, nextCursor }` (`null` at the end).

## Public / caller endpoints

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /api/health` | — | Liveness (`simulated: true`) |
| `GET /api/meta` | — | Demo mode, adapter mode, policy profile, intent model, supported languages, banner |
| `GET /api/scenarios` | — | The 18 scenarios with synthetic caller details and expected outcomes (DOB shown only in demo mode) |
| `POST /api/calls` | — (rate limited) | Start a call. Body: `{ scenarioId?: "S01".."S18", callerAni?, channel?: "text_simulator"|"voice_browser", moodStart? }` → `201 { sessionId, callToken, view }` |
| `GET /api/calls/:id` | caller **or** staff `call.read` | Call view (transcript, pending prompt, choices, proposal, sources, findings, operations, case, handoff; `demoDevice` OTP for the caller in demo mode only). Staff views are audited. |
| `POST /api/calls/:id/input` | caller | One input. Body is one of: `{kind:"utterance", text, clientMessageId?, asrConfidence?}` · `{kind:"choice", optionId}` · `{kind:"consent", proposalId, decision:"accept"|"decline"}` · `{kind:"request_human"}` · `{kind:"silence"}` · `{kind:"interrupt"}` · `{kind:"reconcile"}` · `{kind:"hangup"}` · `{kind:"survey", score:1..5}`. Returns the updated view. Duplicate `clientMessageId`s are ignored. |
| `POST /api/calls/:id/actions` | caller or staff `action.request`; **header `Idempotency-Key` required** | Direct action request. Body: `{ type: "block_card"|"order_replacement"|"submit_dispute"|"reverse_fee", targetRef, params, consentId? }`. Same policy engine as the conversation. `201` new, `200` idempotent replay, `4xx` rejected with the persisted operation and policy checks in `details`. |
| `GET /api/calls/:id/actions/:opId` | caller or staff `call.read` | Operation + status history |
| `POST /api/calls/:id/actions/:opId/reconcile` | caller or staff `action.reconcile` | Look up the downstream outcome of an unknown/pending operation (never re-sends) |
| `POST /api/calls/:id/actions/:opId/retry` | caller or staff `action.request` | Only allowed when reconciliation proved the request was never received |

### Action `params`

| type | targetRef | params |
|---|---|---|
| `block_card` | card reference | `{ reason: "lost"|"stolen"|"fraud" }` |
| `order_replacement` | card reference | `{ deliveryAddress: "address_on_file" }` |
| `submit_dispute` | transaction id | `{ disputeId: "DSP-…" }` (a validated draft) |
| `reverse_fee` | fee id | `{ ruleCode: "FP-LATE-01" }` |

## Staff endpoints

| Method & path | Permission | Purpose |
|---|---|---|
| `GET /api/auth/demo-users` | — | Synthetic staff users |
| `POST /api/auth/demo-login` `{userId}` | — (rate limited) | Demo sign-in |
| `POST /api/auth/logout` · `GET /api/auth/me` | — | |
| `GET /api/handoffs?status=` | `handoff.read` | Queue |
| `GET /api/handoffs/:id` | `handoff.read` | Brief + call view + case (audited) |
| `POST /api/handoffs/:id/accept` | `handoff.accept` | Queued → connected (the simulated desk's confirmation) |
| `POST /api/handoffs/:id/message` `{text}` | `handoff.message` | Agent message to the caller (connected agent only) |
| `POST /api/handoffs/:id/complete` `{outcome, notes, customerRepeatedIssue}` | `handoff.complete` | Finish the call (accepting agent only) |
| `POST /api/actions/:id/approve` · `/reject {reason}` | `action.approve` | Human approval for held actions (re-authorised at approval time) |
| `POST /api/actions/:id/reconcile` | `action.reconcile` | |
| `GET /api/cases` · `GET /api/cases/:id` | `case.read` | Cases (views audited) |
| `GET /api/calls?from&to&issueType&outcome&origin` | `call.read` | Calls list |
| `GET /api/audit?event&sessionId&from&to` | `audit.read` | Audit log (redacted metadata) |
| `GET /api/kpis?from&to&issueType&outcome&handoffReason&origin=all|demo_session|seeded_illustrative` | `kpi.read` | Metrics, definitions, sample sizes, targets (separate), breakdowns |
| `GET /api/policy` | `policy.read` | Active policy and BRD targets |
| `POST /api/qa/reviews` | `qa.review` | `{sessionId, actionCorrect, safetyIncident, customerRepeatedIssue, score, notes}` |

## Admin endpoints (synthetic data only)

| Method & path | Permission | Purpose |
|---|---|---|
| `POST /api/admin/reset` `{confirm:"RESET SYNTHETIC DATA"}` | `demo.reset` | Wipe and re-seed |
| `GET /api/admin/faults` · `PUT /api/admin/faults` | `demo.faults` | Inject/remove mock faults: `{scope, scopeRef, target, fault, enabled}` |
| `PUT /api/admin/settings` `{agentsAvailable}` | `demo.faults` | Toggle simulated agent availability |
| `POST /api/admin/disputes/:id/simulate-review` `{outcome}` | `demo.faults` | SIMULATED downstream review for the rework metric |

## Example: direct action without consent (scenario S18)

```bash
curl -s -X POST localhost:3000/api/calls/$SID/actions \
  -H 'content-type: application/json' -H "x-call-token: $TOKEN" -H 'idempotency-key: demo-0001' \
  -d '{"type":"reverse_fee","targetRef":"FEE-…","params":{"ruleCode":"FP-LATE-01"}}'
# → 422 {"error":{"code":"CONSENT_REQUIRED", ... "details":{"operation":{ "status":"rejected", "policy_decision":{"checks":[...]}}}}}
```
