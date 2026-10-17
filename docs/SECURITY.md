# Security and privacy checklist

These controls exist in the prototype. **Their existence is not a compliance claim.** Jurisdiction, bank policy, PCI DSS scope, call-recording consent and AI-disclosure rules must be confirmed before any production use.

| Control | Status | Where / how | Verified by |
|---|---|---|---|
| Synthetic data only | ✅ | `bank_customers.is_synthetic CHECK (=1)`; 555-01xx fictional numbers; banner on every page | FND seed tests |
| No full PAN / CVV stored or shown | ✅ | Cards store last 4 only; free text redacted (`redactText`) before persistence; detector in tests and `check:secrets` | RED; E2E privacy (scans every table and the API view after a caller reads a test PAN + CVV aloud) |
| Verification secrets never stored in clear | ✅ | DOB and phone keyed-hashed; OTP hashed; verification answers replaced by a placeholder in the transcript; attempts store outcomes only | E2E S10; ACT verification |
| Masking in UI, logs, summaries | ✅ | `maskPhone`, `minimiseName`, last-4; brief shows transactions only for verified callers | E2E S08 |
| Server-side RBAC | ✅ | Permissions from DB on every staff route; admin cannot request or approve banking actions; caller token binds one browser to one call | STAFF matrix; FND RBAC; E2E S18 |
| Verification before protected reads/writes | ✅ | Retrieval only after `verified`; policy engine checks verification on every action | E2E S10 |
| Consent bound to the exact action | ✅ | Consent → proposal → `{type, targetRef}`; expiry; cross-session consent rejected; forged IDs rejected | E2E S18; ACT |
| Least privilege & central policy | ✅ | `src/config/policy.ts`; non-mock adapter mode forces conservative profile | ACT |
| Input validation | ✅ | Zod schemas (strict) on every body/query; body limit 32 KB; idempotency key format | STAFF; ACT |
| Output encoding | ✅ | UI renders via `textContent` only (no `innerHTML` with data) | Code review (`public/js/lib.js`) |
| CSP & security headers | ✅ | `default-src 'self'`, no inline script, `frame-ancestors 'none'`, nosniff, no-referrer, `X-Frame-Options: DENY` | STAFF headers test |
| CSRF | ✅ | SameSite=Strict cookies + JSON-only writes (form posts → 400/415) | STAFF |
| Session handling | ✅ | HMAC-signed staff tokens (8 h), HttpOnly, `Secure` in production; random 192-bit caller tokens stored hashed; `SESSION_SECRET` required in production | FND tampered token |
| Rate limiting | ✅ | Global 600/min/IP; tighter on call start, input, actions, login | — (config) |
| Prompt-injection / untrusted content | ✅ | Deterministic safety signals; LLM sees caller text as tagged data with schema-validated output; model cannot reach policy or actions | INT; CONV |
| Audit of sensitive reads and all writes | ✅ | `audit_events` with redacted metadata; staff views of calls/cases/briefs audited | FND; STAFF |
| An off switch for the assistant | ✅ | Three positions in `src/safety/control.ts`: normal, actions paused (it answers and looks things up but changes nothing), switched off (every caller goes straight to a person). Enforced in `authorizeAction` before any eligibility rule is read, so no caller text and no model output can get an action through; staff are not affected. Reason, who and when are required and audited. A setting that cannot be read is treated as switched off | `tests/e2e/safety-switch.test.ts` (paused: no proposal, no operations, policy refusal; off: handover on the way in and mid-call; RBAC) |
| Tamper-evident audit log | ✅ | Every row carries a keyed hash of itself and of the row before it; the head is kept outside the table, so removing rows from the end also shows. `GET /api/audit/verify` walks the chain and reports what it checked. Set `AUDIT_CHAIN_KEY` so the key lives outside the database — without it the chain still catches edits made outside the application, and verification says so rather than claiming more | `tests/audit/chain.test.ts` (edited field, removed row, truncated end, cleared table, hand-inserted row, forged hash, swapped rows) |
| Privacy-safe logs | ✅ | Structured logger deep-redacts every record | ACT logging |
| Secrets management | ✅ | Env vars only; `.env` git-ignored; `.env.example` placeholders; `check:secrets` scan | `npm run check:secrets` |
| Dependency checks | ✅ | `npm audit` — 0 known vulnerabilities at build time (13 Oct 2026) | `npm run audit:deps` |
| Transcript retention | ✅ | `TRANSCRIPT_RETENTION_DAYS` (default 30) purge at startup; structured records kept | STAFF retention |
| Demo-only features disabled in production | ✅ | `DEMO_MODE=true` refused when `NODE_ENV=production` | `config/env.ts` |
| Encryption in transit | ⚠️ Delegated | Terminate TLS at a reverse proxy (DEPLOYMENT.md); app sets `Secure` cookies in production | — |
| Encryption at rest | ❌ Not implemented | SQLite file is plaintext; use encrypted volumes / a managed DB with TDE in any shared environment | — |
| Production authentication (SSO/MFA) | ❌ Not implemented | Demo role picker only | — |
| Recording / AI-disclosure wording approved | ❌ Blocked | Placeholder notices | Legal |
| Penetration test / threat model review | ❌ Not done | | Security |

## Data retention and reset

- Demo transcripts older than `TRANSCRIPT_RETENTION_DAYS` are replaced with a placeholder at server start.
- Expired demo OTP display values are cleared at start and on use.
- `npm run db:reset` / admin reset wipes all demo activity and re-seeds synthetic data. The database contains nothing else.
