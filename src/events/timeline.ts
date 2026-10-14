/**
 * CALL TIMELINE — the live operations stream.
 *
 * Every meaningful state transition writes one structured, human-readable event. Events are
 * persisted (timeline_events) and pushed to live subscribers (server-sent events), so the
 * operations panel reflects real application state, not an animation. Titles and details are
 * redacted before storage; protected account data is only ever emitted after verification.
 */
import { EventEmitter } from 'node:events';
import { all, run } from '../db/db.ts';
import { nowIso } from '../lib/clock.ts';
import { redactText } from '../lib/redact.ts';

export type Stage = 'understand' | 'verify' | 'investigate' | 'explain' | 'confirm' | 'act' | 'record' | 'resolve' | 'handoff';
export type TimelineStatus = 'info' | 'running' | 'ok' | 'warn' | 'failed' | 'blocked' | 'pending';

export interface TimelineInput {
  type: string;
  stage: Stage;
  title: string;
  detail?: string | null;
  status?: TimelineStatus;
  source?: string | null;
  ref?: string | null;
  data?: Record<string, unknown>;
}

export interface TimelineEvent extends Required<Omit<TimelineInput, 'data'>> {
  id: number;
  sessionId: string;
  at: string;
  data: Record<string, unknown>;
}

const bus = new EventEmitter();
bus.setMaxListeners(1000);

export function emitTimeline(sessionId: string, e: TimelineInput): TimelineEvent {
  const at = nowIso();
  const title = redactText(e.title).slice(0, 300);
  const detail = e.detail ? redactText(e.detail).slice(0, 1000) : null;
  const r = run(
    'INSERT INTO timeline_events (session_id, type, stage, title, detail, status, source, ref, data_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [sessionId, e.type, e.stage, title, detail, e.status ?? 'info', e.source ?? null, e.ref ?? null, JSON.stringify(e.data ?? {}), at],
  );
  const ev: TimelineEvent = { id: r.lastInsertRowid, sessionId, type: e.type, stage: e.stage, title, detail, status: e.status ?? 'info', source: e.source ?? null, ref: e.ref ?? null, data: e.data ?? {}, at };
  bus.emit(sessionId, ev);
  return ev;
}

export function subscribe(sessionId: string, fn: (e: TimelineEvent) => void): () => void {
  bus.on(sessionId, fn);
  return () => bus.off(sessionId, fn);
}

export function listTimeline(sessionId: string, afterId = 0): TimelineEvent[] {
  return all<Record<string, unknown>>('SELECT * FROM timeline_events WHERE session_id = ? AND id > ? ORDER BY id', [sessionId, afterId]).map((r) => ({
    id: Number(r.id),
    sessionId: String(r.session_id),
    type: String(r.type),
    stage: r.stage as Stage,
    title: String(r.title),
    detail: (r.detail as string) ?? null,
    status: r.status as TimelineStatus,
    source: (r.source as string) ?? null,
    ref: (r.ref as string) ?? null,
    data: JSON.parse(String(r.data_json)),
    at: String(r.created_at),
  }));
}
