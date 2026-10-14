/** Languages and open banking Q&A plumbing: prompt language, account tool gating, no card number leak. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { setup } from './harness.ts';
import { run } from '../../src/db/db.ts';
import { lilySystemInstruction, TOOL, LILY_TOOLS } from '../../src/live/lily.ts';
import { runTool } from '../../src/live/tools.ts';
import { isLang } from '../../src/live/languages.ts';

let app: FastifyInstance;
beforeEach(async () => { app = await setup(); });
afterEach(async () => { await app.close(); });

async function newCall(profileId = 'alex-morgan') {
  const r = await app.inject({ method: 'POST', url: '/api/calls', payload: { channel: 'voice_browser', profileId } });
  return r.json().sessionId as string;
}
const ctx = (sessionId: string) => ({ sessionId, customerText: 'what is my account', turnId: 't1', consumeCustomerText() {} });

describe('languages', () => {
  it('accepts only en, my and fil', () => {
    expect(isLang('my')).toBe(true); expect(isLang('fil')).toBe(true); expect(isLang('en')).toBe(true);
    expect(isLang('fr')).toBe(false); expect(isLang(undefined)).toBe(false);
  });
  it('puts the chosen language in the system prompt', () => {
    expect(lilySystemInstruction({ language: 'my' })).toContain('Burmese');
    expect(lilySystemInstruction({ language: 'fil' })).toContain('Tagalog');
    expect(lilySystemInstruction({})).toContain('English');
  });
  it('allows any banking question and declares the account tool', () => {
    expect(lilySystemInstruction({})).toMatch(/anything within banking/i);
    expect(LILY_TOOLS.some((t) => t.name === TOOL.account)).toBe(true);
  });
});

describe('get_account_details', () => {
  it('refuses before the card number is verified', async () => {
    const id = await newCall();
    const out = await runTool(TOOL.account, { question: 'what is my phone number' }, ctx(id));
    expect(out.ok).toBe(false);
  });
  it('after verification returns account facts but never the card number', async () => {
    const id = await newCall();
    run("UPDATE call_sessions SET verification_status = 'verified' WHERE id = ?", [id]);
    const out = await runTool(TOOL.account, { question: 'what is my phone number' }, ctx(id));
    expect(out.ok).toBe(true);
    const pan = (await app.inject({ method: 'GET', url: '/api/demo/customers' })).json().items[0].cardNumber as string;
    const s = JSON.stringify(out);
    expect(s).not.toContain(pan); expect(s).not.toContain(pan.replace(/\D/g, ''));
  });
});
