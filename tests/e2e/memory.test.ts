/**
 * CALL MEMORY: the customer says things once. These tests drive the real live bridge, tools,
 * orchestrator and database with a scripted speech provider, and assert persisted state:
 * what the back end captured, with which status, and that it never asks for it again.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { setup, Caller } from './harness.ts';
import { all, get } from '../../src/db/db.ts';
import { setEnvForTests, env } from '../../src/config/env.ts';
import { ScriptedProvider, type ScriptedSession } from '../../src/live/scripted.ts';
import { TOOL } from '../../src/live/lily.ts';
import { getContext, cardCaptureFor } from '../../src/conversation/orchestrator.ts';
import { setFact, type Facts } from '../../src/conversation/facts.ts';
import { allProfileCards } from '../../src/live/profiles.ts';

let app: FastifyInstance;
let base = '';
const sockets: WebSocket[] = [];
const original = { LIVE_PROVIDER: env().LIVE_PROVIDER };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  app = await setup();
  setEnvForTests({ LIVE_PROVIDER: 'scripted' });
  ScriptedProvider.reset();
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `127.0.0.1:${(app.server.address() as { port: number }).port}`;
});
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  setEnvForTests(original);
  await app.close();
});

const pan = (profileId = 'alex-morgan') => allProfileCards().find((p) => p.id === profileId)!.cardNumber!.replace(/\D/g, '');

async function liveCall(profileId = 'alex-morgan'): Promise<{ id: string; s: ScriptedSession }> {
  const r = await app.inject({ method: 'POST', url: '/api/calls', payload: { channel: 'voice_browser', profileId } });
  const { sessionId, callToken } = r.json();
  const ws = new WebSocket(`ws://${base}/api/calls/${sessionId}/live`, { headers: { Cookie: `hio_call=${callToken}` } });
  sockets.push(ws);
  await new Promise<void>((res) => ws.on('message', (m) => { if (JSON.parse(m.toString()).type === 'ready') res(); }));
  await sleep(40);
  return { id: sessionId, s: ScriptedProvider.last };
}

/** The customer speaks; Lily answers in her own words WITHOUT calling a tool. */
async function spokenOnly(s: ScriptedSession, words: string, lily = 'Okay.') {
  s.heard(words);
  s.said(lily);
  s.turnComplete();
  await sleep(120);
}
/** Lily calls a tool now (optionally after new words from the customer) and we wait for the result. */
async function tool(s: ScriptedSession, name: string, words?: string): Promise<any> {
  const before = s.toolResponses.length;
  if (words) s.heard(words);
  s.toolCall(name, name === TOOL.banking ? { topic: 'request' } : {});
  const t0 = Date.now();
  while (s.toolResponses.length === before && Date.now() - t0 < 6000) await sleep(25);
  expect(s.toolResponses.length).toBe(before + 1);
  await sleep(30);
  return s.toolResponses.at(-1)!.response;
}
const assistantSaid = (id: string) => all<{ text: string }>("SELECT text FROM conversation_turns WHERE session_id = ? AND speaker = 'assistant' ORDER BY seq", [id]).map((t) => t.text);
const stage = (id: string) => getContext(id).stage;

describe('the customer explains the problem once', () => {
  it('keeps the problem said before a tool call, so a later "yes" moves on instead of asking again', async () => {
    const { id, s } = await liveCall();
    // Lily restates instead of calling the tool; the customer's next words are just "yes".
    await spokenOnly(s, "There's a charge on my card I don't recognise, it wasn't me.", "A charge you don't recognise, is that right?");
    const out = await tool(s, TOOL.banking, 'Yes, that is right.');
    expect(out.ok).toBe(true);
    expect(stage(id)).toBe('awaiting_card');
    expect(assistantSaid(id).join(' ')).not.toMatch(/which of these is closest/i);
    expect(getContext(id).facts?.issue_type?.value).toMatch(/unrecognised|don.t recognise/i);
    expect(out.already_known.issue).toMatch(/wasn't me|recognise/);
  });

  it('acts on words already heard when the tool call arrives after Lily finished speaking', async () => {
    const { id, s } = await liveCall();
    await spokenOnly(s, 'I lost my card yesterday.', "I'm sorry, let me help.");
    const out = await tool(s, TOOL.banking); // no new words
    expect(out.error).toBeUndefined();
    expect(stage(id)).toBe('awaiting_card');
  });

  it('remembers the original issue through verification and does not ask what happened again', async () => {
    const { id, s } = await liveCall();
    await tool(s, TOOL.banking, "There's a Novaplay charge for $249 I didn't make");
    await tool(s, TOOL.card, pan());
    await tool(s, TOOL.card, 'yes');
    expect(get<{ verification_status: string }>('SELECT verification_status FROM call_sessions WHERE id = ?', [id])!.verification_status).toBe('verified');
    const said = assistantSaid(id).join('\n');
    expect(said).not.toMatch(/what happened|how can I help|which of these/i);
    const f = getContext(id).facts!;
    expect(f.issue?.value).toMatch(/Novaplay/);
    expect(f.transaction?.status).toBe('confirmed');
    expect(f.amount?.status).toBe('confirmed');
  });
});

describe('card reference', () => {
  it('a card number given with the problem is confirmed at the security step, not asked for again', async () => {
    const { id, s } = await liveCall();
    const out = await tool(s, TOOL.banking, `I don't recognise a charge, my card number is ${pan()}`);
    const said = assistantSaid(id).join('\n');
    expect(said).toMatch(/gave me your card number a moment ago/);
    expect(said).not.toMatch(/read me your 16-digit card number/);
    expect(out.already_known.card_reference).toMatch(/not yet checked/);
    // The transcript never holds the full number.
    expect(all<{ text: string }>('SELECT text FROM conversation_turns WHERE session_id = ?', [id]).map((t) => t.text).join(' ')).not.toContain(pan());
    await tool(s, TOOL.card, 'yes');
    expect(getContext(id).verification.status).toBe('verified');
  });

  it('assembles digits read between tool calls instead of losing them', async () => {
    const { id, s } = await liveCall();
    await tool(s, TOOL.banking, "There's a charge I don't recognise");
    const d = pan();
    await spokenOnly(s, d.slice(0, 4), 'Got it.');
    await spokenOnly(s, d.slice(4, 8), 'Okay.');
    expect(cardCaptureFor(id)?.count).toBe(8);
    await tool(s, TOOL.card, d.slice(8));
    expect(assistantSaid(id).at(-1)).toMatch(new RegExp(`ending in ${d.slice(-4).split('').join(' ')}`));
    await tool(s, TOOL.card, 'yes');
    expect(getContext(id).verification.status).toBe('verified');
    // No group of card digits was written to the transcript either.
    const text = all<{ text: string }>('SELECT text FROM conversation_turns WHERE session_id = ?', [id]).map((t) => t.text).join(' ');
    expect(text).not.toContain(d.slice(4, 8));
  });

  it('records "ends in 4821" as customer-provided, asks only for the full number, and flags a different verified card', async () => {
    const { id, s } = await liveCall();
    await tool(s, TOOL.banking, "I need help with a charge on my card, it wasn't me. My card ends in 4821.");
    expect(getContext(id).facts?.card_reference).toMatchObject({ status: 'provided', source: 'customer' });
    expect(assistantSaid(id).at(-1)).toMatch(/card ending 4 8 2 1.*full 16-digit card number/);
    // Knowing the last four is not verification.
    expect(getContext(id).verification.status).not.toBe('verified');
    const acct = await tool(s, TOOL.account);
    expect(acct.ok).toBe(false);
    await tool(s, TOOL.card, pan());
    await tool(s, TOOL.card, 'yes');
    const card = getContext(id).facts!.card_reference!;
    expect(card.status).toBe('verified');
    expect(card.customerValue).toBe('card ending 4821');
    expect(assistantSaid(id).join(' ')).toMatch(/earlier you mentioned the card ending 4821/);
  });
});

describe('consent is never taken from earlier words', () => {
  it('a "yes" Lily answered herself is not consent; the back end asks again and changes nothing', async () => {
    const { id, s } = await liveCall();
    await tool(s, TOOL.banking, "There's a Novaplay charge for $249 I didn't make");
    await tool(s, TOOL.card, pan());
    await tool(s, TOOL.card, 'yes');
    expect(getContext(id).pending?.kind).toBe('consent');
    await spokenOnly(s, 'yes', 'Would you like me to explain the steps first?');
    await tool(s, TOOL.banking);
    expect(all("SELECT * FROM action_operations WHERE session_id = ? AND status = 'succeeded'", [id])).toHaveLength(0);
    expect(assistantSaid(id).at(-1)).toMatch(/should I go ahead\? Please say yes or no/);
    await tool(s, TOOL.banking, 'Yes, go ahead.');
    expect(all("SELECT * FROM action_operations WHERE session_id = ? AND status = 'succeeded'", [id]).length).toBeGreaterThan(0);
  });
});

describe('corrections, conflicts and isolation', () => {
  it('a corrected amount replaces the earlier one and keeps it in history', async () => {
    const c = new Caller(app);
    await c.start(undefined, { profileId: 'alex-morgan' });
    await c.say('There is a charge of $250 from Novaplay I did not make');
    expect(getContext(c.sessionId).facts?.amount?.value).toBe('$250.00');
    await c.say(`Actually it was $249`);
    const amount = getContext(c.sessionId).facts!.amount!;
    // Before verification, the customer's correction stands as customer-provided.
    expect(amount.history?.some((h) => h.value === '$250.00')).toBe(true);
    expect(['provided', 'confirmed']).toContain(amount.status);
  });

  it('flags a customer amount that differs from the bank record instead of overwriting it', async () => {
    const c = new Caller(app);
    await c.start(undefined, { profileId: 'alex-morgan' });
    await c.say('There is a Novaplay charge of $260 I did not make');
    await c.say(pan());
    await c.say('yes');
    const f = getContext(c.sessionId).facts!;
    expect(f.amount?.status).toBe('conflicting');
    expect(f.amount?.customerValue).toBe('$260.00');
    expect(f.amount?.value).toBe('$249.00');
    expect(c.transcriptText()).toMatch(/you mentioned \$260\.00, and the charge on record is \$249\.00/);
  });

  it('a customer statement never overrides a verified or confirmed fact', () => {
    const facts: Facts = {};
    setFact(facts, 'identity', 'Verified', 'verified', 'verification');
    expect(setFact(facts, 'identity', 'not me', 'provided', 'customer')).toBe('kept_authoritative');
    expect(facts.identity!.status).toBe('verified');
    setFact(facts, 'amount', '$10.00', 'confirmed', 'bank_system');
    expect(setFact(facts, 'amount', '$11.00', 'provided', 'customer')).toBe('conflict');
    expect(facts.amount!.value).toBe('$10.00');
  });

  it('a new call does not inherit the previous caller’s card digits or facts', async () => {
    const a = await liveCall('alex-morgan');
    await tool(a.s, TOOL.banking, `I don't recognise a charge, my card number is ${pan()}`);
    expect(cardCaptureFor(a.id)).not.toBeNull();
    const b = await liveCall('tom-becker');
    expect(cardCaptureFor(b.id)).toBeNull();
    expect(getContext(b.id).facts).toEqual({});
    await tool(b.s, TOOL.banking, 'Why was I charged a late fee?');
    expect(assistantSaid(b.id).join(' ')).not.toMatch(/gave me your card number/);
  });

  it('facts are persisted with the call and survive a reload', async () => {
    const c = new Caller(app);
    await c.start(undefined, { profileId: 'alex-morgan' });
    await c.say('There is a Novaplay charge of $249 I did not make');
    const raw = get<{ context_json: string }>('SELECT context_json FROM call_sessions WHERE id = ?', [c.sessionId])!.context_json;
    expect(JSON.parse(raw).facts.merchant.value).toBe('Novaplay');
    expect(raw).not.toContain(pan());
  });
});
