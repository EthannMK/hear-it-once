/**
 * IDENTIFY BY CARD NUMBER: no profile is picked. The card number the caller gives identifies
 * and verifies them, so a judge can switch scenarios just by giving another card.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { setup, Caller } from './harness.ts';
import { all, get } from '../../src/db/db.ts';
import { allProfileCards } from '../../src/live/profiles.ts';

let app: FastifyInstance;
beforeEach(async () => { app = await setup(); });
afterEach(async () => { await app.close(); });

const group = (p: string) => p.replace(/(\d{4})(?=\d)/g, '$1 ');
const panOf = (id: string) => group(allProfileCards().find((p) => p.id === id)!.cardNumber!.replace(/\D/g, ''));
const said = (c: Caller, n = 3) => all<{ text: string }>("SELECT text FROM conversation_turns WHERE session_id = ? AND speaker = 'assistant' ORDER BY seq DESC LIMIT ?", [c.sessionId, n]).map((r) => r.text).join(' ');
const sess = (c: Caller) => get<any>('SELECT customer_id, profile_id, verification_status FROM call_sessions WHERE id = ?', [c.sessionId])!;

describe('identify by card number', () => {
  it('asks for the card, then knows who the caller is and carries on', async () => {
    const c = new Caller(app);
    await c.start(undefined, { channel: 'voice_browser' });
    await c.say('I lost my card');
    expect(said(c, 1)).toMatch(/16-digit card number/);
    await c.say(panOf('jamie-tan'));
    expect(said(c, 1)).toMatch(/1 1 3 3/);
    await c.say('yes');
    expect(sess(c).verification_status).toBe('verified');
    expect(sess(c).profile_id).toBe('jamie-tan');
    expect(c.view.persona?.name ?? '').toMatch(/Jamie/);
  });
  it('a different card on the next call is a different customer', async () => {
    const a = new Caller(app);
    await a.start(undefined, { channel: 'voice_browser' });
    await a.say('I lost my card');
    await a.say(panOf('alex-morgan'));
    await a.say('yes');
    const b = new Caller(app);
    await b.start(undefined, { channel: 'voice_browser' });
    await b.say('I lost my card');
    await b.say(panOf('priya-shah'));
    await b.say('yes');
    expect(sess(a).profile_id).toBe('alex-morgan');
    expect(sess(b).profile_id).toBe('priya-shah');
  });
  it('a wrong card gets a retry and three wrong ones hand over', async () => {
    const c = new Caller(app);
    await c.start(undefined, { channel: 'voice_browser' });
    await c.say('I lost my card');
    await c.say('4999 0000 0000 0000');
    await c.say('yes');
    expect(sess(c).verification_status).not.toBe('verified');
    expect(said(c, 1)).toMatch(/card/i);
    await c.say('4999 1111 1111 1111');
    await c.say('yes');
    await c.say('4999 2222 2222 2222');
    await c.say('yes');
    expect(sess(c).verification_status).not.toBe('verified');
    expect(sess(c).profile_id).toBeFalsy();
    expect(said(c, 2)).toMatch(/person|colleague|team|human|agent/i);
  });
  it('typed secure entry works and the card never lands in the transcript', async () => {
    const c = new Caller(app);
    await c.start(undefined, { channel: 'voice_browser' });
    await c.say('I lost my card');
    const raw = panOf('priya-shah').replace(/\s/g, '');
    await c.say(raw);
    await c.say('yes');
    expect(sess(c).verification_status).toBe('verified');
    const dump = JSON.stringify(all('SELECT text FROM conversation_turns WHERE session_id = ?', [c.sessionId]));
    expect(dump).not.toContain(raw);
  });
});
