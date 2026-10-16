/**
 * CLOSING THE CALL: the ways callers actually say "that is everything" and "goodbye", and what the
 * back end does with them. Reported from judge testing (defects D-01 to D-04).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { setup, Caller } from './harness.ts';
import { parseYesNo, FAREWELL } from '../../src/ai/parsers.ts';

let app: FastifyInstance;
beforeEach(async () => { app = await setup(); });
afterEach(async () => { await app.close(); });

const stageOf = (c: Caller) => JSON.parse(c.session().context_json).stage as string;

/** Get the call to the "anything else?" question through a general enquiry and a goodbye-free path. */
async function toWrapUp(c: Caller) {
  await c.start('S01');
  await c.say("There's a charge from Novaplay for $249 I don't recognise");
  await c.verify('S01');
  const v = c.view;
  if (v.proposal) await c.consent();
  return c.view;
}

describe('answers callers actually give', () => {
  const yes = ['yes', 'Yes right', 'yes, please', 'proceed', 'Proceed.', 'go ahead', 'carry on', 'correct', 'oo', 'opo', 'sige po', 'tama po', 'of course'];
  const no = ['no', 'None, thank you', 'nothing else', "that's all", "that's it, thanks", "I'm done", 'all good', 'no more', 'not right now', 'hindi po', 'no thanks'];
  for (const t of yes) it(`reads "${t}" as yes`, () => expect(parseYesNo(t)).toBe('yes'));
  for (const t of no) it(`reads "${t}" as no`, () => expect(parseYesNo(t)).toBe('no'));
  for (const t of ['I was about to say something', 'let me explain', 'what are your opening hours', 'my card is blocked'])
    it(`leaves "${t}" unanswered`, () => expect(parseYesNo(t)).toBeNull());
  for (const t of ['goodbye', 'Bye.', 'ok thanks, bye', 'have a good day'])
    it(`reads "${t}" as a farewell`, () => expect(FAREWELL.test(t)).toBe(true));
  for (const t of ['I want to say goodbye to my overdraft', 'bye-laws question'])
    it(`does not read "${t}" as a farewell`, () => expect(FAREWELL.test(t)).toBe(false));
});

describe('the call closes when the caller is finished', () => {
  it('"None, thank you" is a no to "anything else?", not a new request or a transfer', async () => {
    const c = new Caller(app);
    await toWrapUp(c);
    await c.say('None, thank you.');
    expect(stageOf(c)).toBe('awaiting_survey');
    expect(c.lastAssistant()).not.toMatch(/connect you to an agent/i);
  });

  it('a goodbye at the closing question ends the call instead of leaving it open', async () => {
    const c = new Caller(app);
    await toWrapUp(c);
    await c.say('All right, thank you. Goodbye.');
    await c.refresh();
    expect(stageOf(c)).toBe('ended');
    expect(c.view.status ?? c.view.call?.status ?? 'ended').not.toBe('active');
    expect(c.lastAssistant()).toMatch(/Northstar Bank/i);
  });

  it('a goodbye during the rating question ends the call and is not read as a new request', async () => {
    const c = new Caller(app);
    await toWrapUp(c);
    await c.say('nothing else');
    expect(stageOf(c)).toBe('awaiting_survey');
    await c.say('All right, thank you, bye');
    expect(stageOf(c)).toBe('ended');
  });
});

describe('the stolen-card review question (D-05)', () => {
  it('says why it is asking, and the caller can decline without a charge list', async () => {
    const c = new Caller(app);
    await c.start('S02');
    await c.say('My card was stolen');
    await c.verify('S02');
    await c.consent();                 // block the card
    await c.refresh();
    if (c.view.proposal) await c.consent(); // order the replacement
    await c.refresh();
    const asked = c.transcriptText();
    if (/recognise\?/.test(asked)) {
      // The question must carry its reason, never arrive bare after a replacement.
      expect(asked).toMatch(/since the card was out of your hands/i);
      await c.say('yes');
      expect(c.lastAssistant()).toMatch(/could you tell me the amount|can’t see any recent charges|can't see any recent charges/i);
    } else {
      expect(asked).toMatch(/no recent charges on that card/i);
    }
  });
});

describe('the handover is spoken, not just shown (C-01)', () => {
  it('Lily says the call has been transferred once the agent accepts, and says it once', async () => {
    const { acceptHandoff } = await import('../../src/handoff/handoff-service.ts');
    const { all } = await import('../../src/db/db.ts');
    const c = new Caller(app);
    await c.start('S01');
    await c.say('I want to speak to a human agent please');
    await c.say('yes');
    const hd = all<{ id: string; status: string }>('SELECT id, status FROM handoffs WHERE session_id = ?', [c.sessionId]);
    expect(hd).toHaveLength(1);
    acceptHandoff(hd[0].id, { type: 'agent', id: 'STF-AGENT-1' });
    await c.refresh();
    const said = c.view.transcript.filter((t: any) => t.speaker === 'assistant' && /transferred you to/i.test(t.text));
    expect(said).toHaveLength(1);
    expect(said[0].text).toMatch(/won't need to repeat anything/i);
  });
});

describe('more ways of saying yes (from judge testing)', () => {
  it('"uu" is a yes wherever "oo" is', () => {
    expect(parseYesNo('uu')).toBe('yes');
    expect(parseYesNo('uu po')).toBe('yes');
  });

  it('"right" answers a question Lily just asked, but is not an answer on its own', () => {
    expect(parseYesNo('right')).toBeNull();
    expect(parseYesNo('right', { answeringPrompt: true })).toBe('yes');
    expect(parseYesNo('exactly', { answeringPrompt: true })).toBe('yes');
    // Still not a yes when it is the caller thinking aloud.
    expect(parseYesNo('right, so what happened was my card got declined')).toBeNull();
  });

  it('"right" confirms the card read-back', async () => {
    const { allProfileCards } = await import('../../src/live/profiles.ts');
    const pan = allProfileCards().find((p) => p.id === 'jamie-tan')!.cardNumber!.replace(/\D/g, '').replace(/(\d{4})(?=\d)/g, '$1 ');
    const c = new Caller(app);
    await c.start(undefined, { channel: 'voice_browser' });
    await c.say('I lost my card');
    await c.say(pan);
    expect(c.lastAssistant()).toMatch(/1 1 3 3/);
    await c.say('right');
    const { get } = await import('../../src/db/db.ts');
    expect(get<any>('SELECT verification_status FROM call_sessions WHERE id = ?', [c.sessionId]).verification_status).toBe('verified');
  });

  it('a soft word never stands in for agreeing to be transferred', async () => {
    const c = new Caller(app);
    await c.start('S09');
    await c.say('Something is off with my stuff');
    await c.say("It's the thing from before, you know");
    await c.say('hmm');
    const { all } = await import('../../src/db/db.ts');
    expect(all<any>('SELECT id FROM handoffs WHERE session_id = ?', [c.sessionId])).toHaveLength(0);
  });
});
