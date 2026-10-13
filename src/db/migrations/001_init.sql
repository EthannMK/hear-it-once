-- Hear It Once — initial schema.
-- Two zones:
--   bank_*  : SIMULATED bank systems (synthetic data). Only mock adapters read/write them.
--   others  : application state (sessions, cases, actions, audit, reporting).
-- No table stores a full card number (PAN), CVV/CVC, plaintext OTP or plaintext DOB.

PRAGMA foreign_keys = ON;

------------------------------------------------------------------------------------------
-- Roles & staff (demo authentication; not production identity)
------------------------------------------------------------------------------------------
CREATE TABLE roles (
  name        TEXT PRIMARY KEY,
  description TEXT NOT NULL
);
CREATE TABLE role_permissions (
  role        TEXT NOT NULL REFERENCES roles(name) ON DELETE CASCADE,
  permission  TEXT NOT NULL,
  PRIMARY KEY (role, permission)
);
CREATE TABLE staff_users (
  id           TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  role         TEXT NOT NULL REFERENCES roles(name),
  is_synthetic INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL
);

------------------------------------------------------------------------------------------
-- SIMULATED BANK SYSTEMS (synthetic)
------------------------------------------------------------------------------------------
CREATE TABLE bank_customers (
  id                     TEXT PRIMARY KEY,           -- opaque internal reference
  customer_number        TEXT NOT NULL UNIQUE,       -- synthetic 8-digit number
  full_name              TEXT NOT NULL,
  dob_hash               TEXT NOT NULL,              -- HMAC of DOB; plaintext never stored
  phone_hash             TEXT NOT NULL,              -- HMAC of registered phone (ANI lookup)
  phone_masked           TEXT NOT NULL,
  email_masked           TEXT,
  segment                TEXT NOT NULL DEFAULT 'standard',
  account_standing       TEXT NOT NULL DEFAULT 'good' CHECK (account_standing IN ('good','delinquent','closed')),
  contact_changed_at     TEXT,                       -- recent contact-detail change => takeover risk signal
  profile_as_of          TEXT NOT NULL,
  is_synthetic           INTEGER NOT NULL DEFAULT 1 CHECK (is_synthetic = 1),
  created_at             TEXT NOT NULL
);
CREATE INDEX idx_bank_customers_phone ON bank_customers(phone_hash);

CREATE TABLE bank_cards (
  id               TEXT PRIMARY KEY,                 -- opaque card reference (token-like)
  customer_id      TEXT NOT NULL REFERENCES bank_customers(id),
  last4            TEXT NOT NULL CHECK (length(last4) = 4),
  network          TEXT NOT NULL,
  product          TEXT NOT NULL,
  holder_role      TEXT NOT NULL CHECK (holder_role IN ('primary','additional')),
  holder_name      TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('active','blocked','closed')),
  status_reason    TEXT,
  status_as_of     TEXT NOT NULL,
  is_synthetic     INTEGER NOT NULL DEFAULT 1 CHECK (is_synthetic = 1),
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_bank_cards_customer ON bank_cards(customer_id);

CREATE TABLE bank_transactions (
  id               TEXT PRIMARY KEY,
  customer_id      TEXT NOT NULL REFERENCES bank_customers(id),
  card_id          TEXT REFERENCES bank_cards(id),
  kind             TEXT NOT NULL CHECK (kind IN ('purchase','payment','fee','refund','credit','cash_advance')),
  merchant_name    TEXT,
  merchant_category TEXT,
  amount_minor     INTEGER NOT NULL,                 -- positive = debit to customer
  currency         TEXT NOT NULL DEFAULT 'USD',
  txn_at           TEXT NOT NULL,
  posted_at        TEXT,
  status           TEXT NOT NULL CHECK (status IN ('pending','posted','reversed')),
  entry_mode       TEXT CHECK (entry_mode IN ('ecommerce','chip','chip_pin','contactless','swipe','recurring','manual')),
  auth_code        TEXT,
  related_payment_id TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_bank_txn_customer_time ON bank_transactions(customer_id, txn_at);

CREATE TABLE bank_fraud_alerts (
  id               TEXT PRIMARY KEY,
  customer_id      TEXT NOT NULL REFERENCES bank_customers(id),
  card_id          TEXT REFERENCES bank_cards(id),
  transaction_id   TEXT REFERENCES bank_transactions(id),
  alert_type       TEXT NOT NULL,                    -- e.g. suspicious_ecommerce, account_takeover_risk
  risk_level       TEXT NOT NULL CHECK (risk_level IN ('low','medium','high')),
  status           TEXT NOT NULL CHECK (status IN ('open','closed')),
  reported_card_status TEXT,                         -- fraud system's view of card status
  reported_amount_minor INTEGER,                     -- fraud system's view of txn amount
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_bank_fraud_customer ON bank_fraud_alerts(customer_id);

CREATE TABLE bank_payments (
  id                     TEXT PRIMARY KEY,
  customer_id            TEXT NOT NULL REFERENCES bank_customers(id),
  amount_minor           INTEGER NOT NULL,
  currency               TEXT NOT NULL DEFAULT 'USD',
  initiated_at           TEXT NOT NULL,
  channel                TEXT NOT NULL,
  source_account_masked  TEXT NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN ('pending','posted','returned','failed')),
  status_detail          TEXT,
  posted_at              TEXT,
  expected_posting_date  TEXT,                       -- only when the payment system supplies it
  status_as_of           TEXT NOT NULL,
  created_at             TEXT NOT NULL
);
CREATE INDEX idx_bank_payments_customer ON bank_payments(customer_id);

CREATE TABLE bank_fees (
  id               TEXT PRIMARY KEY,
  customer_id      TEXT NOT NULL REFERENCES bank_customers(id),
  transaction_id   TEXT REFERENCES bank_transactions(id),
  fee_type         TEXT NOT NULL,
  amount_minor     INTEGER NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'USD',
  charged_at       TEXT NOT NULL,
  reversed_at      TEXT,
  reversal_reason  TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_bank_fees_customer ON bank_fees(customer_id);

CREATE TABLE bank_dispute_rules (
  rule_code             TEXT PRIMARY KEY,
  reason                TEXT NOT NULL CHECK (reason IN ('fraud_unrecognised','duplicate_charge','incorrect_amount')),
  description           TEXT NOT NULL,
  max_days_since_txn    INTEGER NOT NULL,
  min_amount_minor      INTEGER NOT NULL,
  allowed_entry_modes   TEXT NOT NULL,               -- JSON array
  requires_card_block   INTEGER NOT NULL,
  required_fields       TEXT NOT NULL,               -- JSON array
  automatable           INTEGER NOT NULL,            -- may the assistant submit without an agent?
  active                INTEGER NOT NULL DEFAULT 1,
  version               TEXT NOT NULL
);

CREATE TABLE bank_fee_policies (
  rule_code             TEXT PRIMARY KEY,
  fee_type              TEXT NOT NULL UNIQUE,
  reversible            INTEGER NOT NULL,
  description           TEXT NOT NULL,
  version               TEXT NOT NULL
);

-- The simulated downstream systems' own record of write operations (card control,
-- card issuing, dispute intake, fee ledger). Used for idempotency and reconciliation.
CREATE TABLE bank_operations (
  id               TEXT PRIMARY KEY,                 -- external reference returned to us
  system           TEXT NOT NULL,
  operation        TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL,
  payload_hash     TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('succeeded','failed','pending')),
  failure_code     TEXT,
  downstream_status TEXT,                            -- e.g. simulated dispute review status
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (system, idempotency_key)
);

-- Demo fault injection, scoped to a synthetic customer, a scenario, or global.
CREATE TABLE mock_faults (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  scope        TEXT NOT NULL CHECK (scope IN ('customer','scenario','global')),
  scope_ref    TEXT NOT NULL DEFAULT '*',
  target       TEXT NOT NULL,                        -- source name or write system or 'assistant'
  fault        TEXT NOT NULL CHECK (fault IN ('unavailable','timeout','stale','fail','timeout_after_submit','pending','error')),
  enabled      INTEGER NOT NULL DEFAULT 1,
  note         TEXT,
  UNIQUE (scope, scope_ref, target, fault)
);

------------------------------------------------------------------------------------------
-- APPLICATION STATE
------------------------------------------------------------------------------------------
CREATE TABLE call_sessions (
  id                      TEXT PRIMARY KEY,
  correlation_id          TEXT NOT NULL UNIQUE,
  channel                 TEXT NOT NULL CHECK (channel IN ('text_simulator','voice_browser','telephony')),
  data_origin             TEXT NOT NULL CHECK (data_origin IN ('demo_session','seeded_illustrative')),
  scenario_id             TEXT,
  caller_ani_hash         TEXT,
  caller_token_hash       TEXT,                       -- binds the caller's browser to the session
  state                   TEXT NOT NULL,
  context_json            TEXT NOT NULL DEFAULT '{}', -- orchestrator working state (redacted)
  issue_type              TEXT,
  issue_statement         TEXT,                       -- redacted original words
  issue_fields_json       TEXT,
  customer_id             TEXT REFERENCES bank_customers(id),
  verification_status     TEXT NOT NULL DEFAULT 'not_started'
                           CHECK (verification_status IN ('not_started','identified','in_progress','verified','failed','abandoned')),
  verification_level      TEXT,
  eligible                INTEGER NOT NULL DEFAULT 0,  -- one of the five BRD issue types
  outcome                 TEXT CHECK (outcome IN ('resolved','handed_off','abandoned','verification_failed','fallback','in_progress','ended_unresolved')),
  resolution_status       TEXT CHECK (resolution_status IN ('resolved','partially_resolved','unresolved','informational')),
  handoff_reason          TEXT,
  repeat_contact          INTEGER NOT NULL DEFAULT 0,
  issue_restatements      INTEGER NOT NULL DEFAULT 0,
  mood_start              TEXT,                       -- SIMULATED label (demo selector / seed)
  mood_end                TEXT,
  csat                    INTEGER CHECK (csat BETWEEN 1 AND 5),
  qa_flagged              INTEGER NOT NULL DEFAULT 0,
  answered_at             TEXT NOT NULL,
  issue_captured_at       TEXT,
  verified_at             TEXT,
  retrieval_started_at    TEXT,
  retrieval_completed_at  TEXT,
  proposal_at             TEXT,
  consent_at              TEXT,
  execution_completed_at  TEXT,
  case_created_at         TEXT,
  handoff_requested_at    TEXT,
  agent_joined_at         TEXT,
  ended_at                TEXT,
  version                 INTEGER NOT NULL DEFAULT 0,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
CREATE INDEX idx_sessions_answered ON call_sessions(answered_at);
CREATE INDEX idx_sessions_customer ON call_sessions(customer_id, answered_at);
CREATE INDEX idx_sessions_issue ON call_sessions(issue_type);

CREATE TABLE conversation_turns (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id         TEXT NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  seq                INTEGER NOT NULL,
  speaker            TEXT NOT NULL CHECK (speaker IN ('customer','assistant','agent','system')),
  kind               TEXT NOT NULL DEFAULT 'utterance',
  text               TEXT NOT NULL,                  -- always redacted before insert
  sensitive_redacted INTEGER NOT NULL DEFAULT 0,
  client_message_id  TEXT,
  asr_confidence     REAL,
  created_at         TEXT NOT NULL,
  UNIQUE (session_id, seq)
);
CREATE UNIQUE INDEX uq_turn_client_msg ON conversation_turns(session_id, client_message_id) WHERE client_message_id IS NOT NULL;

CREATE TABLE verification_attempts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  customer_id   TEXT REFERENCES bank_customers(id),
  step          TEXT NOT NULL CHECK (step IN ('identify','dob','otp')),
  method        TEXT NOT NULL,
  outcome       TEXT NOT NULL CHECK (outcome IN ('passed','failed','locked','issued')),
  failure_reason TEXT,                               -- never the supplied value
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_verif_session ON verification_attempts(session_id);

CREATE TABLE otp_challenges (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  customer_id   TEXT NOT NULL REFERENCES bank_customers(id),
  code_hash     TEXT NOT NULL,
  demo_display  TEXT,                                -- DEMO_MODE only: simulated device inbox; purged on use
  expires_at    TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  consumed_at   TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE retrieval_snapshots (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  issue_type     TEXT,
  started_at     TEXT NOT NULL,
  completed_at   TEXT,
  wall_ms        INTEGER,
  sum_source_ms  INTEGER,
  conflicts_json TEXT NOT NULL DEFAULT '[]',
  summary_json   TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE integration_calls (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT REFERENCES call_sessions(id) ON DELETE CASCADE,
  snapshot_id     TEXT REFERENCES retrieval_snapshots(id) ON DELETE CASCADE,
  correlation_id  TEXT NOT NULL,
  source          TEXT NOT NULL,
  operation       TEXT NOT NULL,
  direction       TEXT NOT NULL CHECK (direction IN ('read','write')),
  status          TEXT NOT NULL CHECK (status IN ('ok','error','timeout','unavailable','circuit_open','stale')),
  latency_ms      INTEGER NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 1,
  source_as_of    TEXT,
  stale           INTEGER NOT NULL DEFAULT 0,
  error_code      TEXT,
  is_simulated    INTEGER NOT NULL DEFAULT 1,
  started_at      TEXT NOT NULL,
  data_origin     TEXT NOT NULL DEFAULT 'demo_session'
);
CREATE INDEX idx_integration_source_time ON integration_calls(source, started_at);
CREATE INDEX idx_integration_session ON integration_calls(session_id);

CREATE TABLE cases (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL REFERENCES call_sessions(id),
  customer_id           TEXT REFERENCES bank_customers(id),
  issue_type            TEXT,
  status                TEXT NOT NULL CHECK (status IN ('open','pending','awaiting_agent','resolved','closed')),
  resolution_status     TEXT,
  verification_outcome  TEXT NOT NULL,
  customer_reported     TEXT,                         -- redacted, customer's words
  transaction_refs_json TEXT NOT NULL DEFAULT '[]',
  sources_checked_json  TEXT NOT NULL DEFAULT '[]',
  eligibility_json      TEXT,
  actions_json          TEXT NOT NULL DEFAULT '[]',
  summary               TEXT,
  next_steps            TEXT,
  handoff_notes         TEXT,
  previous_case_ids_json TEXT NOT NULL DEFAULT '[]',
  recurring_issue       INTEGER NOT NULL DEFAULT 0,
  risk_flags_json       TEXT NOT NULL DEFAULT '[]',
  data_origin           TEXT NOT NULL DEFAULT 'demo_session',
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  closed_at             TEXT
);
CREATE INDEX idx_cases_customer ON cases(customer_id, created_at);
CREATE INDEX idx_cases_status ON cases(status);
CREATE UNIQUE INDEX uq_case_per_session ON cases(session_id);

CREATE TABLE case_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id     TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_case_events_case ON case_events(case_id);

CREATE TABLE proposals (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  case_id       TEXT REFERENCES cases(id),
  snapshot_id   TEXT REFERENCES retrieval_snapshots(id),
  actions_json  TEXT NOT NULL,                       -- [{type, targetRef, params}]
  explanation   TEXT NOT NULL,
  rule_refs_json TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL CHECK (status IN ('proposed','accepted','declined','expired','superseded')),
  created_at    TEXT NOT NULL,
  decided_at    TEXT
);

CREATE TABLE consents (
  id            TEXT PRIMARY KEY,
  proposal_id   TEXT NOT NULL UNIQUE REFERENCES proposals(id) ON DELETE CASCADE,
  session_id    TEXT NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  decision      TEXT NOT NULL CHECK (decision IN ('accepted','declined')),
  captured_via  TEXT NOT NULL,                       -- 'button' | 'utterance'
  utterance_turn_id INTEGER,
  expires_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE action_operations (
  id                 TEXT PRIMARY KEY,
  idempotency_key    TEXT NOT NULL,
  action_type        TEXT NOT NULL,
  session_id         TEXT REFERENCES call_sessions(id),
  case_id            TEXT REFERENCES cases(id),
  customer_id        TEXT REFERENCES bank_customers(id),
  target_ref         TEXT NOT NULL,
  params_json        TEXT NOT NULL,
  params_hash        TEXT NOT NULL,
  consent_id         TEXT REFERENCES consents(id),
  actor_type         TEXT NOT NULL,
  actor_id           TEXT NOT NULL,
  policy_decision_json TEXT,
  status             TEXT NOT NULL CHECK (status IN ('requested','validated','rejected','awaiting_confirmation','awaiting_approval','submitted','succeeded','failed','unknown')),
  external_ref       TEXT,
  error_code         TEXT,
  error_message      TEXT,                           -- safe message only
  attempts           INTEGER NOT NULL DEFAULT 0,
  approved_by        TEXT,
  requested_at       TEXT NOT NULL,
  submitted_at       TEXT,
  completed_at       TEXT,
  last_reconciled_at TEXT,
  data_origin        TEXT NOT NULL DEFAULT 'demo_session',
  updated_at         TEXT NOT NULL,
  UNIQUE (action_type, idempotency_key)
);
CREATE INDEX idx_actions_session ON action_operations(session_id);
CREATE INDEX idx_actions_status ON action_operations(status);

CREATE TABLE action_status_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id  TEXT NOT NULL REFERENCES action_operations(id) ON DELETE CASCADE,
  from_status   TEXT,
  to_status     TEXT NOT NULL,
  note          TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE disputes (
  id                   TEXT PRIMARY KEY,
  case_id              TEXT NOT NULL REFERENCES cases(id),
  session_id           TEXT REFERENCES call_sessions(id),
  operation_id         TEXT REFERENCES action_operations(id),
  customer_id          TEXT NOT NULL REFERENCES bank_customers(id),
  card_id              TEXT NOT NULL REFERENCES bank_cards(id),
  transaction_id       TEXT NOT NULL REFERENCES bank_transactions(id),
  merchant             TEXT NOT NULL,
  amount_minor         INTEGER NOT NULL,
  currency             TEXT NOT NULL,
  txn_date             TEXT NOT NULL,
  reason_code          TEXT NOT NULL,
  rule_code            TEXT,
  customer_explanation TEXT,
  evidence_json        TEXT NOT NULL DEFAULT '[]',
  validation_json      TEXT NOT NULL DEFAULT '{}',
  missing_fields_json  TEXT NOT NULL DEFAULT '[]',
  prior_case_refs_json TEXT NOT NULL DEFAULT '[]',
  status               TEXT NOT NULL CHECK (status IN ('draft','validation_failed','submitting','submitted','pending','rejected','needs_review','failed','unknown')),
  external_ref         TEXT,
  downstream_status    TEXT,                          -- SIMULATED downstream review status
  rework_required      INTEGER,                       -- SIMULATED; null = not yet known
  summary              TEXT,
  data_origin          TEXT NOT NULL DEFAULT 'demo_session',
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_active_dispute_per_txn ON disputes(transaction_id)
  WHERE status NOT IN ('failed','rejected','validation_failed','draft');

CREATE TABLE handoffs (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES call_sessions(id),
  case_id           TEXT REFERENCES cases(id),
  reason            TEXT NOT NULL,
  reason_detail     TEXT,
  brief_json        TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('requested','queued','connected','completed','no_agent','failed','cancelled')),
  agent_id          TEXT REFERENCES staff_users(id),
  requested_at      TEXT NOT NULL,
  connected_at      TEXT,
  completed_at      TEXT,
  outcome           TEXT,
  agent_notes       TEXT,
  customer_repeated_issue INTEGER,
  fallback          TEXT,
  data_origin       TEXT NOT NULL DEFAULT 'demo_session',
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_handoffs_status ON handoffs(status);
CREATE UNIQUE INDEX uq_open_handoff_per_session ON handoffs(session_id) WHERE status IN ('requested','queued','connected');

CREATE TABLE hold_intervals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  reason      TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  ended_at    TEXT
);

CREATE TABLE session_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_session_events_type ON session_events(event_type, created_at);
CREATE INDEX idx_session_events_session ON session_events(session_id);

CREATE TABLE qa_reviews (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id        TEXT NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  reviewer_id       TEXT NOT NULL REFERENCES staff_users(id),
  in_sample         INTEGER NOT NULL DEFAULT 1,
  action_correct    INTEGER,                          -- 1/0/null (no consequential action)
  safety_incident   INTEGER NOT NULL DEFAULT 0,       -- wrong or unauthorised consequential action
  customer_repeated_issue INTEGER NOT NULL DEFAULT 0,
  score             INTEGER CHECK (score BETWEEN 0 AND 100),
  notes             TEXT,
  data_origin       TEXT NOT NULL DEFAULT 'demo_session',
  created_at        TEXT NOT NULL
);

CREATE TABLE audit_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             TEXT NOT NULL,
  correlation_id TEXT,
  session_id     TEXT,
  actor_type     TEXT NOT NULL,
  actor_id       TEXT NOT NULL,
  event          TEXT NOT NULL,                      -- e.g. source.read, action.submitted, case.viewed
  resource_type  TEXT,
  resource_id    TEXT,
  status         TEXT NOT NULL,
  metadata_json  TEXT NOT NULL DEFAULT '{}',         -- redacted
  data_origin    TEXT NOT NULL DEFAULT 'demo_session'
);
CREATE INDEX idx_audit_ts ON audit_events(ts);
CREATE INDEX idx_audit_session ON audit_events(session_id);
CREATE INDEX idx_audit_event ON audit_events(event);

CREATE TABLE app_settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
