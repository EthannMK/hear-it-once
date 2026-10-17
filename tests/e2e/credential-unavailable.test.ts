/**
 * WHEN THE CALLER CANNOT PROVE WHO THEY ARE THE WAY WE FIRST ASKED.
 *
 * Someone who has lost their card cannot read its number, and someone who has also lost their phone
 * cannot receive a passcode. The call must stop asking, offer the other check the bank allows, and
 * bring in a person when neither can run — without ever lowering the bar to finish the call.
 *
 * These cover the reported faults: Lily looping on the card number, and a general question being
 * treated as a reason to verify.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { setup, Caller } from './harness.ts';
import { all, get } from '../../src/db/db.ts';
import { SCENARIOS } from '../../src/db/scenarios.ts';
import { isGeneralHowTo } from '../../src/conversation/orchestrator.ts';
import { readUnavailable, saysCredentialUnavailable } from '../../src/conversation/unavailable.ts';

let app: FastifyInstance;
beforeEach(async () => { app = await setup(); });
afterEach(async () => { await app.close(); });

const call = async () => { const c = new Caller(app); await c.start(undefined, { channel: 'voice_browser' }); return c; };
const said = (c: Caller, n = 3) => all<{ text: string }>("SELECT text FROM conversation_turns WHERE session_id = ? AND speaker IN ('assistant','system') ORDER BY seq DESC LIMIT ?", [c.sessionId, n]).map((r) => r.text).join(' ');
const everSaid = (c: Caller) => all<{ text: string }>("SELECT text FROM conversation_turns WHERE session_id = ? AND speaker IN ('assistant','system') ORDER BY seq", [c.sessionId]).map((r) => r.text);
const askedForCard = (c: Caller) => everSaid(c).filter((t) => /16-digit card number|read all 16 digits|first four digits/i.test(t)).length;
const verifying = (c: Caller) => all<{ type: string }>("SELECT type FROM timeline_events WHERE session_id = ? AND type = 'verification.started'", [c.sessionId]).length > 0;
const handoff = (c: Caller) => get<{ reason: string; status: string; brief_json: string }>('SELECT reason, status, brief_json FROM handoffs WHERE session_id = ?', [c.sessionId]);
const stage = (c: Caller) => get<{ state: string }>('SELECT state FROM call_sessions WHERE id = ?', [c.sessionId])?.state;
const ops = (c: Caller) => all<{ action_type: string; status: string }>('SELECT action_type, status FROM action_operations WHERE session_id = ?', [c.sessionId]);

describe('the words themselves', () => {
  it('tells a question about how something works from a report that it happened', () => {
    for (const q of ['How do I replace a lost card?', 'How do I block my card?', 'What is APR?', 'how can I freeze my card', 'Where is your nearest branch?', 'How do I make a deposit?'])
      expect(isGeneralHowTo(q), q).toBe(true);
    for (const r of ['I lost my card', 'my card was stolen', 'someone used my card', "I don't recognise a charge", 'What was my last transaction?', 'how much did I spend last week'])
      expect(isGeneralHowTo(r), r).toBe(false);
  });

  it('recognises a credential the caller cannot supply, and keeps digits as an answer', () => {
    for (const t of ["I don't have my card with me", 'I lost it, I don’t know the number', "I don't remember my card number", 'I told you I lost it', "I don't know"])
      expect(saysCredentialUnavailable(t), t).toBe(true);
    // Digits are an attempt at the answer, however it is worded.
    expect(saysCredentialUnavailable('I think it is 4999 0100 0037 1007')).toBe(false);
    expect(readUnavailable('I lost my phone and card').lostPhone).toBe(true);
    expect(readUnavailable('I lost my phone and card').lostCard).toBe(true);
  });
});

describe('scenario 1 — the card and the phone are both gone', () => {
  it('goes to a person instead of asking for a number the caller cannot read', async () => {
    const c = await call();
    await c.say("I'm Ethan. I lost my phone and card.");
    const h = handoff(c);
    expect(h?.reason).toBe('credential_unavailable');
    expect(askedForCard(c)).toBe(0);
    expect(said(c)).toMatch(/colleague|passing you/i);
  });

  it('never claims the card was blocked, and says so in the brief', async () => {
    const c = await call();
    await c.say('I lost my phone and my card was stolen');
    expect(said(c)).not.toMatch(/\b(card is|card has been|I have) blocked\b/i);
    expect(ops(c).filter((o) => o.action_type === 'block_card' && o.status === 'succeeded')).toHaveLength(0);
    const brief = JSON.parse(handoff(c)!.brief_json);
    expect(JSON.stringify(brief.missingInformation)).toMatch(/not blocked|Identity not confirmed/i);
  });

  it('carries the reason for the call into the handover so it is not asked again', async () => {
    const c = await call();
    await c.say('I lost my phone and card');
    const brief = JSON.parse(handoff(c)!.brief_json);
    expect(brief.issue.customerStatement ?? brief.issue.label).toMatch(/lost|card/i);
    expect(brief.customer.verification).not.toMatch(/^verified$/i);
  });
});

describe('scenario 2 — the card number is not to hand, the phone still is', () => {
  it('offers the second approved check instead of asking again', async () => {
    const c = await call();
    await c.say('I lost my card');
    expect(askedForCard(c)).toBe(1);
    await c.say("I don't remember my card number");
    expect(said(c)).toMatch(/another way|customer number/i);
    // Asked once, then a different route: never a second time for the same thing.
    expect(askedForCard(c)).toBe(1);
    expect(handoff(c)).toBeUndefined();
  });

  it('the second route is the full check, not a softer one', async () => {
    const s = SCENARIOS.find((x) => x.id === 'S02')!;
    const c = await call();
    await c.say('I lost my card');
    await c.say("I don't have my card with me");
    await c.say(s.customer.number);
    await c.say(s.customer.dob);
    // Date of birth alone never verifies anyone: a passcode to the registered phone comes next.
    expect(said(c)).toMatch(/passcode/i);
    expect(get<{ verification_status: string }>('SELECT verification_status FROM call_sessions WHERE id = ?', [c.sessionId])?.verification_status).not.toBe('verified');
    expect(stage(c)).toBe('awaiting_otp');
  });

  it('a wrong card number is still an ordinary attempt, not an unavailable credential', async () => {
    const c = await call();
    await c.say('I lost my card');
    await c.say('4999 1111 2222 3333');
    // The digits are read back for confirmation first; the check runs on the caller's "yes".
    expect(said(c, 1)).toMatch(/ending in 3 3 3 3/i);
    await c.say('yes');
    expect(said(c)).toMatch(/didn’t match|did not match|attempts? (left|remaining)/i);
  });
});

describe('scenario 7 — no phone, so no passcode', () => {
  it('does not keep sending a passcode to a phone that is gone', async () => {
    const s = SCENARIOS.find((x) => x.id === 'S02')!;
    const c = await call();
    await c.say('I lost my card');
    await c.say("I don't remember my card number");
    await c.say(s.customer.number);
    await c.say(s.customer.dob);
    await c.say("I lost my phone, so I can't receive an OTP");
    expect(handoff(c)?.reason).toBe('credential_unavailable');
    expect(everSaid(c).filter((t) => /passcode by text message/i.test(t))).toHaveLength(1);
  });

  it('a lost phone mentioned at the start rules the passcode route out from then on', async () => {
    const c = await call();
    await c.say('I lost my phone, so I can’t receive an OTP');
    await c.say('I don’t recognise a charge on my card');
    await c.say("I don't have my card with me");
    expect(everSaid(c).join(' ')).not.toMatch(/passcode I'?ll text|sent a 6-digit passcode/i);
    expect(handoff(c)?.reason).toBe('credential_unavailable');
  });
});

describe('scenarios 3, 4 and 10 — general questions are answered, not verified', () => {
  it.each([
    ['How do I make a deposit?', /deposit/i],
    ['What is APR?', /APR|yearly cost/i],
    ['How do I replace a lost card?', /replacement|app under Cards|branch/i],
    ['How do I block my card?', /freeze|block/i],
    ['How can I identify a card scam?', /never asks|PIN/i],
    ['Where is your nearest branch?', /branch|city/i],
  ])('%s is answered with no security check', async (question, expected) => {
    const c = await call();
    await c.say(question);
    expect(said(c, 1)).toMatch(expected);
    expect(verifying(c)).toBe(false);
    expect(askedForCard(c)).toBe(0);
  });

  it('says plainly when the bank information does not cover a how-to question', async () => {
    const c = await call();
    await c.say('How do I open a crypto trading account?');
    expect(verifying(c)).toBe(false);
    expect(said(c, 1)).toMatch(/outside what I can help with|don’t have|do not have/i);
  });

  it('moving from a general question to their own account does start the check', async () => {
    const c = await call();
    await c.say('How do I replace a lost card?');
    expect(verifying(c)).toBe(false);
    await c.say('My card was stolen yesterday');
    expect(verifying(c)).toBe(true);
    expect(askedForCard(c)).toBe(1);
  });

  it('a general question during the security check is answered without costing an attempt', async () => {
    const c = await call();
    await c.say('I lost my card');
    await c.say('How do I block my card?');
    expect(said(c, 1)).toMatch(/freeze|block/i);
    expect(get<{ card_attempts: number }>("SELECT COUNT(*) AS card_attempts FROM verification_attempts WHERE session_id = ? AND step = 'card'", [c.sessionId])?.card_attempts).toBe(0);
    expect(handoff(c)).toBeUndefined();
  });
});

describe('scenarios 5, 6 and 9 — the checks that must stay', () => {
  it('account-specific questions still require verification first', async () => {
    const c = await call();
    await c.say('What was my last transaction?');
    expect(said(c)).not.toMatch(/\$\d/);
    await c.say('I want to check a charge I do not recognise');
    expect(verifying(c)).toBe(true);
  });

  it('someone using the card without permission is treated as fraud, not as unclear', async () => {
    const c = await call();
    await c.say('I think someone used my card without permission');
    expect(get<{ issue_type: string }>('SELECT issue_type FROM call_sessions WHERE id = ?', [c.sessionId])?.issue_type).toBe('unrecognised_transaction');
    expect(verifying(c)).toBe(true);
  });

  it('asking for a person transfers the call rather than ending it', async () => {
    const c = await call();
    await c.say('Please connect me to a human');
    expect(handoff(c)?.status).toMatch(/queued|requested/);
    expect(get<{ ended_at: string | null }>('SELECT ended_at FROM call_sessions WHERE id = ?', [c.sessionId])?.ended_at).toBeNull();
  });
});
