/**
 * TURN TAKING AND ESCALATION: a greeting is followed by listening, not a card menu. Acknowledgements,
 * "let me talk" and unclear input never transfer the call. A real handover sends one message.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { setup, Caller } from './harness.ts';
import { all, get } from '../../src/db/db.ts';

let app: FastifyInstance;
beforeEach(async () => { app = await setup(); });
afterEach(async () => { await app.close(); });

const turns = (c: Caller) => all<{ speaker: string; text: string }>('SELECT speaker, text FROM conversation_turns WHERE session_id = ? ORDER BY seq', [c.sessionId]);
const last = (c: Caller) => turns(c).filter((t) => t.speaker !== 'customer').at(-1)!.text;
const handoffs = (c: Caller) => all('SELECT 1 FROM handoffs WHERE session_id = ?', [c.sessionId]).length;
const call = async () => { const c = new Caller(app); await c.start(undefined, { channel: 'voice_browser' }); return c; };
const MENU = /lost or stolen card, a charge you don't recognise/i;

describe('turn taking', () => {
  it('"OK" after the greeting invites the caller to speak and shows no card menu', async () => {
    const c = await call();
    await c.say('OK.');
    expect(last(c)).toMatch(/what can I help|take your time/i);
    expect(last(c)).not.toMatch(MENU);
    expect(c.view.choices ?? []).toHaveLength(0);
  });
  it('acknowledgements of any kind never start a workflow', async () => {
    for (const w of ['yes', 'right', 'mm-hmm', 'okay', 'hmm']) {
      const c = await call();
      await c.say(w);
      expect(last(c), w).not.toMatch(MENU);
      expect(handoffs(c), w).toBe(0);
    }
  });
  it('"I haven\'t said anything yet" and "let me start talking" get a patient reply, not a repeat or a transfer', async () => {
    const c = await call();
    await c.say('OK.');
    await c.say("I haven't said anything yet.");
    expect(last(c)).toMatch(/listening|take your time|go ahead/i);
    await c.say('No, let me start talking.');
    expect(last(c)).toMatch(/listening|take your time|go ahead/i);
    expect(handoffs(c)).toBe(0);
    expect(c.view.handoff?.status ?? 'none').toBe('none');
  });
  it('after the invitation the caller can state a request and it works normally', async () => {
    const c = await call();
    await c.say('OK.');
    await c.say("No, let me start talking.");
    await c.say('How do I deposit money?');
    expect(last(c)).toMatch(/deposit/i);
  });
  it('unclear input offers a person but does not transfer until the caller says yes', async () => {
    const c = await call();
    await c.say('Something is off with my stuff');
    await c.say("It's the thing from before, you know");
    await c.say('Just the usual problem with it');
    expect(handoffs(c)).toBe(0);
    expect(last(c)).toMatch(/connect you with a person/i);
    await c.say('no');
    expect(last(c)).toMatch(/tell me what you need/i);
    expect(handoffs(c)).toBe(0);
  });
  it('unclear input then yes hands over once with the reason recorded', async () => {
    const c = await call();
    await c.say('Something is off with my stuff');
    await c.say("It's the thing from before, you know");
    await c.say('Just the usual problem with it');
    await c.say('yes');
    expect(handoffs(c)).toBe(1);
    expect(get<any>('SELECT reason FROM handoffs WHERE session_id = ?', [c.sessionId]).reason).toBe('ai_uncertain');
  });
  it('asking for a human transfers with exactly one handoff message', async () => {
    const c = await call();
    await c.say('I want to speak to a person');
    expect(handoffs(c)).toBe(1);
    const after = turns(c).filter((t) => t.speaker !== 'customer' && /queue|case CASE-/i.test(t.text));
    expect(after).toHaveLength(1);
    expect(after[0].text).toMatch(/number \d+ in the queue/);
  });
  it('the same final transcript delivered twice is answered once', async () => {
    const c = await call();
    await c.input({ kind: 'utterance', text: 'How do I deposit money?', clientMessageId: 'same-1' });
    const n = turns(c).length;
    await c.input({ kind: 'utterance', text: 'How do I deposit money?', clientMessageId: 'same-1' });
    expect(turns(c).length).toBe(n);
  });
  it('no agent available gives only the callback message, never a transfer claim', async () => {
    const { run } = await import('../../src/db/db.ts');
    run("INSERT INTO app_settings (key, value) VALUES ('agents_available', 'false')");
    const c = await call();
    await c.say('I want to speak to a person');
    const said = turns(c).filter((t) => t.speaker !== 'customer').map((t) => t.text).join(' ');
    expect(said).not.toMatch(/I'll transfer you now/i);
    expect(said).toMatch(/callback/i);
  });
});
