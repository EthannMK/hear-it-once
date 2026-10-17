-- Call tagging: the labels an agent puts on a call when wrapping it up (mis-sold, repeat contact,
-- vulnerable customer, and so on). Tags are the agent's own classification and are kept apart from
-- the AI's category and issue type, which stay in the case's own columns.
CREATE TABLE IF NOT EXISTS case_tags (
  case_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'agent',
  actor_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (case_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_case_tags_tag ON case_tags (tag);
