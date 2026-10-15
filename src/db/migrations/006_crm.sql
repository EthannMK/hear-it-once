-- CRM case workspace: agent corrections to case metadata, case notes, recommendation decisions and
-- complaint / escalation tickets. All tied to the existing cases table (one case database).
ALTER TABLE cases ADD COLUMN agent_overrides_json TEXT;
ALTER TABLE cases ADD COLUMN agent_notes TEXT;

CREATE TABLE case_tickets (
  id                     TEXT PRIMARY KEY,
  case_id                TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  customer_id            TEXT REFERENCES bank_customers(id),
  type                   TEXT NOT NULL CHECK (type IN ('complaint','escalation')),
  category               TEXT NOT NULL,
  reason                 TEXT NOT NULL,
  original_concern       TEXT,
  summary                TEXT NOT NULL,
  confirmed_details_json TEXT NOT NULL DEFAULT '[]',
  steps_taken_json       TEXT NOT NULL DEFAULT '[]',
  evidence_json          TEXT NOT NULL DEFAULT '[]',
  outstanding_action     TEXT,
  priority               TEXT NOT NULL CHECK (priority IN ('normal','high','urgent')),
  status                 TEXT NOT NULL CHECK (status IN ('open','in_progress','resolved','closed')),
  team                   TEXT,
  owner_id               TEXT,
  request_key            TEXT NOT NULL UNIQUE,
  created_by             TEXT NOT NULL,
  data_origin            TEXT NOT NULL DEFAULT 'demo_session',
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
-- At most one open ticket of each type per case: retries and double submits reuse it.
CREATE UNIQUE INDEX idx_ticket_open_per_type ON case_tickets(case_id, type) WHERE status IN ('open','in_progress');
CREATE INDEX idx_ticket_customer ON case_tickets(customer_id);

CREATE TABLE ticket_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id  TEXT NOT NULL REFERENCES case_tickets(id) ON DELETE CASCADE,
  event      TEXT NOT NULL,
  detail     TEXT,
  actor_id   TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- An agent's decision on a suggested next step. The suggestion itself is recomputed from case state.
CREATE TABLE case_recommendations (
  id          TEXT PRIMARY KEY,
  case_id     TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  reason      TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('accepted','rejected','edited')),
  edited_text TEXT,
  decided_by  TEXT NOT NULL,
  decided_at  TEXT NOT NULL,
  UNIQUE (case_id, kind)
);
