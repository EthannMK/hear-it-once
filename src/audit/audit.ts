/**
 * Audit service (FR-14). Persists timestamp, actor, event, resource, correlation ID,
 * status and REDACTED metadata for every sensitive read and every write.
 */
import { run, all, get } from '../db/db.ts';
import { nowIso } from '../lib/clock.ts';
import { redactDeep } from '../lib/redact.ts';

export interface Actor {
  type: 'customer_session' | 'agent' | 'qa' | 'admin' | 'system' | 'assistant';
  id: string;
}

export const SYSTEM: Actor = { type: 'system', id: 'system' };
export const ASSISTANT: Actor = { type: 'assistant', id: 'hear-it-once-assistant' };

export interface AuditInput {
  actor: Actor;
  event: string;
  status: 'ok' | 'denied' | 'failed' | 'error' | 'info' | 'unknown';
  resourceType?: string;
  resourceId?: string | null;
  sessionId?: string | null;
  correlationId?: string | null;
  metadata?: Record<string, unknown>;
  dataOrigin?: 'demo_session' | 'seeded_illustrative';
  at?: string;
}

export function audit(e: AuditInput): void {
  run(
    `INSERT INTO audit_events (ts, correlation_id, session_id, actor_type, actor_id, event, resource_type, resource_id, status, metadata_json, data_origin)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      e.at ?? nowIso(),
      e.correlationId ?? null,
      e.sessionId ?? null,
      e.actor.type,
      e.actor.id,
      e.event,
      e.resourceType ?? null,
      e.resourceId ?? null,
      e.status,
      JSON.stringify(redactDeep(e.metadata ?? {})),
      e.dataOrigin ?? 'demo_session',
    ],
  );
}

export interface AuditQuery {
  sessionId?: string;
  event?: string;
  from?: string;
  to?: string;
  limit: number;
  cursor?: number;
}

export function queryAudit(q: AuditQuery) {
  const where: string[] = [];
  const p: unknown[] = [];
  if (q.sessionId) (where.push('session_id = ?'), p.push(q.sessionId));
  if (q.event) (where.push('event LIKE ?'), p.push(`${q.event}%`));
  if (q.from) (where.push('ts >= ?'), p.push(q.from));
  if (q.to) (where.push('ts <= ?'), p.push(q.to));
  if (q.cursor) (where.push('id < ?'), p.push(q.cursor));
  const rows = all<Record<string, unknown>>(
    `SELECT * FROM audit_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`,
    [...p, q.limit + 1],
  );
  const hasMore = rows.length > q.limit;
  const items = rows.slice(0, q.limit).map((r) => ({ ...r, metadata: JSON.parse(String(r.metadata_json)), metadata_json: undefined }));
  return { items, nextCursor: hasMore ? (rows[q.limit - 1].id as number) : null };
}

export function countAudit(event: string, sessionId?: string): number {
  const r = get<{ n: number }>(
    `SELECT COUNT(*) n FROM audit_events WHERE event = ? ${sessionId ? 'AND session_id = ?' : ''}`,
    sessionId ? [event, sessionId] : [event],
  );
  return r?.n ?? 0;
}
