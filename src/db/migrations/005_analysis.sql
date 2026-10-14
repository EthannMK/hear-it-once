-- Post-call analysis, stored apart from the live call so a failed analysis never hides the transcript
-- and can be retried. Every field is built from recorded transcript turns and system events.
CREATE TABLE call_analysis (
  session_id        TEXT PRIMARY KEY REFERENCES call_sessions(id) ON DELETE CASCADE,
  status            TEXT NOT NULL CHECK (status IN ('pending','ready','failed')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  error             TEXT,
  summary           TEXT,
  reason_primary    TEXT,
  reason_label      TEXT,
  reason_confidence REAL,
  reason_secondary_json TEXT,
  resolution        TEXT CHECK (resolution IN ('resolved','partially_resolved','unresolved','escalated','informational')),
  unresolved_json   TEXT,
  suggested_json    TEXT,
  kb_json           TEXT,
  tags_json         TEXT,
  evidence_json     TEXT,
  transcript_turns  INTEGER,
  generated_at      TEXT,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_analysis_status ON call_analysis(status);
CREATE INDEX idx_turns_session_seq ON conversation_turns(session_id, seq);
