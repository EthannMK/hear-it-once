-- Northstar Bank demo: full demo card numbers (SYNTHETIC, shown on the judge screen and checked by
-- the server during card-number verification), a per-call verification mode, and the agent
-- workspace's editable case fields.
ALTER TABLE bank_cards ADD COLUMN demo_pan TEXT;

ALTER TABLE call_sessions ADD COLUMN profile_id TEXT;
ALTER TABLE call_sessions ADD COLUMN verification_mode TEXT NOT NULL DEFAULT 'dob_otp';
ALTER TABLE call_sessions ADD COLUMN agent_tags_json TEXT;
ALTER TABLE call_sessions ADD COLUMN call_reason_summary TEXT;
ALTER TABLE call_sessions ADD COLUMN suggestion_override TEXT;
ALTER TABLE call_sessions ADD COLUMN resolution_text TEXT;
ALTER TABLE call_sessions ADD COLUMN next_steps_text TEXT;
ALTER TABLE call_sessions ADD COLUMN agent_notes_text TEXT;
ALTER TABLE call_sessions ADD COLUMN agent_edited_at TEXT;

-- Allow the new 'card' verification step.
CREATE TABLE verification_attempts_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  customer_id   TEXT REFERENCES bank_customers(id),
  step          TEXT NOT NULL CHECK (step IN ('identify','dob','otp','card')),
  method        TEXT NOT NULL,
  outcome       TEXT NOT NULL CHECK (outcome IN ('passed','failed','locked','issued')),
  failure_reason TEXT,
  created_at    TEXT NOT NULL
);
INSERT INTO verification_attempts_new (id, session_id, customer_id, step, method, outcome, failure_reason, created_at)
  SELECT id, session_id, customer_id, step, method, outcome, failure_reason, created_at FROM verification_attempts;
DROP TABLE verification_attempts;
ALTER TABLE verification_attempts_new RENAME TO verification_attempts;
CREATE INDEX idx_verif_session ON verification_attempts(session_id);
