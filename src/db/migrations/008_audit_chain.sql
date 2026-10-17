-- Each audit row carries the hash of the row before it, so the log cannot be edited after the fact
-- without the break showing. See src/audit/chain.ts.
ALTER TABLE audit_events ADD COLUMN prev_hash TEXT;
ALTER TABLE audit_events ADD COLUMN row_hash TEXT;
