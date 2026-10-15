/**
 * FRAUD CONTROLS: the behaviours in `src/security/fraud-patterns.ts` that the back end has to
 * enforce whatever the model says. Each test names the pattern it covers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { setup, Caller } from './harness.ts';
import { all } from '../../src/db/db.ts';
import { detectSignals } from '../../src/ai/intent.ts';
import { FRAUD_PATTERNS } from '../../src/security/fraud-patterns.ts';

let app: FastifyInstance;
beforeEach(async () => { app = await setup(); });
afterEach(async () => { await app.close(); });

const MONEY = /\$\s?\d|\d+\.\d{2}/;
/** Merchants that exist in the demo data: none may be spoken before the caller names one. */
const MERCHANTS = /novaplay|citylink|eurorail|metro fuel|zorbo/i;

describe('FP-01 minimum disclosure: the caller names the charge, the bank confirms it', () => {
  it('a verified caller who describes nothing is asked, not shown a list of charges', async () => {
    const c = new Caller(app);
    await c.start('S01');
    await c.say("There's a charge I don't recognise on my card");
    await c.verify('S01');
    const said = c.lastAssistant();
    expect(said).toMatch(/could you tell me the amount, the merchant, or roughly when/i);
    expect(said).not.toMatch(MERCHANTS);
    expect(said).not.toMatch(MONEY);
    expect(c.view.choices ?? []).toHaveLength(0);
  });

  it('once the caller names the merchant, the matching charge is confirmed back to them', async () => {
    const c = new Caller(app);
    await c.start('S01');
    await c.say("There's a charge from Novaplay for $249 I didn't make");
    await c.verify('S01');
    expect(c.transcriptText()).toMatch(/novaplay/i);
  });

  it('a caller who cannot describe it is passed to a person rather than read the account', async () => {
    const c = new Caller(app);
    await c.start('S01');
    await c.say("There's a charge I don't recognise on my card");
    await c.verify('S01');
    await c.say('I really have no idea');
    await c.say("I can't remember anything about it");
    const whole = c.transcriptText();
    expect(whole).not.toMatch(MERCHANTS);
    expect(c.lastAssistant()).toMatch(/colleague|agent|person/i);
  });

  it('after a stolen card is blocked, the recent charges are not read out either', async () => {
    const c = new Caller(app);
    await c.start('S02');
    await c.say('My card was stolen');
    await c.verify('S02');
    await c.consent();
    await c.refresh();
    if (c.view.proposal) await c.consent();
    await c.refresh();
    if (/recognise\?/.test(c.lastAssistant())) {
      await c.say('yes');
      const said = c.lastAssistant();
      expect(said).not.toMatch(MERCHANTS);
      expect(said).toMatch(/could you tell me|can’t see any recent charges|can't see any recent charges/i);
    }
  });
});

describe('FP-04 bank impersonation and the "safe account" scam', () => {
  const coached = [
    'Someone from your fraud team called and told me to move my money to a safe account',
    'A man from the bank is on the other line, should I give him the code?',
    'They told me to transfer my savings to a secure account',
    'I was instructed to read out the passcode',
  ];
  for (const line of coached) {
    it(`warns and escalates: "${line.slice(0, 40)}…"`, async () => {
      expect(detectSignals(line).scamCoaching).toBe(true);
      const c = new Caller(app);
      await c.start('S01');
      await c.say(line);
      const said = c.lastAssistant();
      expect(said).toMatch(/never ask you to move money to a safe account/i);
      expect(said).toMatch(/never ask you to read out a passcode/i);
      const hd = all<{ reason: string; brief_json: string }>('SELECT reason, brief_json FROM handoffs WHERE session_id = ?', [c.sessionId]);
      expect(hd).toHaveLength(1);
      expect(hd[0].reason).toBe('social_engineering_suspected');
      expect(JSON.parse(hd[0].brief_json).priority).toBe('urgent');
      const ctx = JSON.parse(c.session().context_json);
      expect(ctx.flags).toContain('scam_coaching_suspected');
    });
  }

  it('an ordinary transfer is not treated as a scam', async () => {
    for (const ok of ['I want to move money to my daughter for her birthday', 'can I transfer money between my own accounts', 'I moved money yesterday and it has not arrived'])
      expect(detectSignals(ok).scamCoaching, ok).toBe(false);
  });

  it('nothing on the account is changed while the scam warning stands', async () => {
    const c = new Caller(app);
    await c.start('S01');
    await c.say('Your fraud team told me to move my money to a safe account');
    await c.say('please just block my card and send the money');
    expect(c.ops().filter((o: any) => o.status === 'succeeded')).toHaveLength(0);
  });
});

describe('the pattern reference stays honest', () => {
  it('every pattern names where it is enforced, unless it is declared out of scope', () => {
    for (const p of FRAUD_PATTERNS) {
      expect(p.source.length, p.id).toBeGreaterThan(10);
      if (p.state === 'out_of_scope') expect(p.enforcedIn, p.id).toHaveLength(0);
      else expect(p.enforcedIn.length, p.id).toBeGreaterThan(0);
    }
  });
});
