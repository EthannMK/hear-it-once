/**
 * GENERAL QUESTIONS NEVER START A SECURITY CHECK: follow-ups keep their subject, topic changes are
 * answered fresh, and only a personal request starts verification.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { setup, Caller } from './harness.ts';
import { all } from '../../src/db/db.ts';

let app: FastifyInstance;
beforeEach(async () => { app = await setup(); });
afterEach(async () => { await app.close(); });

const said = (c: Caller, n = 1) => all<{ text: string }>("SELECT text FROM conversation_turns WHERE session_id = ? AND speaker = 'assistant' ORDER BY seq DESC LIMIT ?", [c.sessionId, n]).map((r) => r.text).join(' ');
const verifying = (c: Caller) => all<{ type: string }>("SELECT type FROM timeline_events WHERE session_id = ? AND type = 'verification.started'", [c.sessionId]).length > 0;
const call = async () => { const c = new Caller(app); await c.start(undefined, { channel: 'voice_browser' }); return c; };

describe('general questions', () => {
  it('deposit then "at an ATM" explains ATM deposits and asks for no card', async () => {
    const c = await call();
    await c.say('I want to deposit money. What is the process?');
    await c.say('How to do at ATM machine?');
    expect(said(c)).toMatch(/Deposit|notes|deposit/);
    expect(said(c)).not.toMatch(/withdrawals with your debit card are free/i);
    expect(verifying(c)).toBe(false);
  });
  it('topic change to international transfer fees is answered, not verified', async () => {
    const c = await call();
    await c.say('How do I deposit money?');
    await c.say('What are your international transfer fees?');
    expect(said(c)).toMatch(/international transfer fees/i);
    expect(verifying(c)).toBe(false);
  });
  it('a personal fee question still starts the check', async () => {
    const c = await call();
    await c.say('Why was I charged a late fee on my card?');
    expect(verifying(c)).toBe(true);
  });
  it('the security prompt never claims details that were not given', async () => {
    const c = await call();
    await c.say('Why was I charged a late fee on my card?');
    expect(said(c, 3)).not.toMatch(/details you gave me/i);
  });
  it('the same event sent twice is answered once', async () => {
    const c = await call();
    await c.say('How do I deposit money?');
    const before = all('SELECT 1 FROM conversation_turns WHERE session_id = ?', [c.sessionId]).length;
    await c.input({ kind: 'utterance', text: 'How do I deposit money?', clientMessageId: 'dup-1' });
    await c.input({ kind: 'utterance', text: 'How do I deposit money?', clientMessageId: 'dup-1' });
    const after = all('SELECT 1 FROM conversation_turns WHERE session_id = ?', [c.sessionId]).length;
    expect(after - before).toBeLessThanOrEqual(2);
  });
});
