/**
 * Configurable transcript retention (privacy-safe approach). Demo transcripts older than
 * TRANSCRIPT_RETENTION_DAYS are replaced by a placeholder; structured case/audit records
 * remain. Real retention schedules require legal/compliance approval (docs/DECISIONS.md).
 */
import { env } from '../config/env.ts';
import { run } from '../db/db.ts';
import { nowMs } from '../lib/clock.ts';

/** Applies to calls made in the demo. The illustrative history written by the seed is not a real call and is kept. */
export function purgeExpiredTranscripts(days = env().TRANSCRIPT_RETENTION_DAYS): number {
  if (!days) return 0;
  const cutoff = new Date(nowMs() - days * 86_400_000).toISOString();
  const r = run("UPDATE conversation_turns SET text = '[purged under retention policy]' WHERE created_at < ? AND text != '[purged under retention policy]' AND session_id NOT IN (SELECT id FROM call_sessions WHERE data_origin = 'seeded_illustrative')", [cutoff]);
  run("UPDATE otp_challenges SET demo_display = NULL WHERE expires_at < ?", [new Date(nowMs()).toISOString()]);
  return r.changes;
}
