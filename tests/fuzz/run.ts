/** Plays a sequence of actions against the real back end and records what happened at every turn. */
import type { FastifyInstance } from 'fastify';
import { Caller } from '../e2e/harness.ts';
import { all, get } from '../../src/db/db.ts';
import type { Action } from './library.ts';

export interface TurnTrace {
  action: Action;
  /** Messages the customer would read or hear for this turn (assistant and system). */
  newReplies: string[];
  handoffRows: number;
  verificationStarts: number;
  operations: number;
}
export interface Trace { seed: number; actions: Action[]; turns: TurnTrace[]; transcript: { speaker: string; text: string }[]; timeline: { type: string; title: string }[]; verified: boolean; handoffs: { status: string; reason: string }[]; }

const rows = (c: Caller) => all<{ speaker: string; text: string }>('SELECT speaker, text FROM conversation_turns WHERE session_id = ? ORDER BY seq', [c.sessionId]);

export async function play(app: FastifyInstance, seed: number, actions: Action[], opts: { profileId?: string } = {}): Promise<Trace> {
  const c = new Caller(app);
  await c.start(undefined, { channel: 'voice_browser', ...(opts.profileId ? { profileId: opts.profileId } : {}) });
  const turns: TurnTrace[] = [];
  let n = 0;
  for (const a of actions) {
    const before = rows(c).length;
    if (a.kind === 'dup') {
      // The same completed event delivered twice must be handled once.
      const id = `fuzz-${seed}-${++n}`;
      await c.input({ kind: 'utterance', text: a.text, clientMessageId: id });
      const mid = rows(c).length;
      await c.input({ kind: 'utterance', text: a.text, clientMessageId: id });
      const dupAdded = rows(c).length - mid;
      turns.push({ action: a, newReplies: dupAdded === 0 ? rows(c).slice(before).filter((t) => t.speaker !== 'customer').map((t) => t.text) : ['__DUPLICATE_EVENT_PRODUCED_OUTPUT__'], handoffRows: 0, verificationStarts: 0, operations: 0 });
    } else {
      try { await c.say(a.text); } catch (e) { if (!/400|empty|text/i.test((e as Error).message)) throw e; }
      turns.push({ action: a, newReplies: rows(c).slice(before).filter((t) => t.speaker !== 'customer').map((t) => t.text), handoffRows: 0, verificationStarts: 0, operations: 0 });
    }
    const t = turns[turns.length - 1];
    t.handoffRows = all('SELECT 1 FROM handoffs WHERE session_id = ?', [c.sessionId]).length;
    t.verificationStarts = all("SELECT 1 FROM timeline_events WHERE session_id = ? AND type = 'verification.started'", [c.sessionId]).length;
    // Only operations that left the proposal stage count. A row waiting for confirmation has done nothing.
    t.operations = c.ops().filter((o: any) => !['awaiting_confirmation', 'declined', 'cancelled', 'superseded', 'expired', 'rejected'].includes(o.status)).length;
  }
  return {
    seed, actions, turns,
    transcript: rows(c),
    timeline: all('SELECT type, title FROM timeline_events WHERE session_id = ? ORDER BY id', [c.sessionId]),
    verified: get<any>('SELECT verification_status s FROM call_sessions WHERE id = ?', [c.sessionId])?.s === 'verified',
    handoffs: all('SELECT status, reason FROM handoffs WHERE session_id = ?', [c.sessionId]),
  };
}
