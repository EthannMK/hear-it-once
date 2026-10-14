-- Structured, customer-readable timeline of every meaningful state transition in a call.
CREATE TABLE timeline_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,               -- e.g. call.initiated, source.completed, action.confirmed
  stage       TEXT NOT NULL,               -- understand|verify|investigate|explain|confirm|act|record|resolve|handoff
  title       TEXT NOT NULL,               -- human-readable, already redacted
  detail      TEXT,
  status      TEXT NOT NULL CHECK (status IN ('info','running','ok','warn','failed','blocked','pending')),
  source      TEXT,                        -- component or (simulated) system
  ref         TEXT,                        -- correlation / case / operation id
  data_json   TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_timeline_session ON timeline_events(session_id, id);

-- Knowledge-base references used during a call (articles themselves are synthetic fixtures in code).
CREATE TABLE kb_references (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  article_id  TEXT NOT NULL,
  query       TEXT NOT NULL,
  score       REAL NOT NULL,
  reason      TEXT NOT NULL,
  supports_next_step INTEGER NOT NULL DEFAULT 0,
  agent_review INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  UNIQUE (session_id, article_id)
);
