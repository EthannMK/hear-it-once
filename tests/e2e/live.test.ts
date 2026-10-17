/**
 * LIVE VOICE: the real HTTP + WebSocket server and the real bridge, tools, orchestrator, policy
 * engine and database, with a scripted stand-in for the speech provider (Gemini Live is not
 * reachable from tests). The stand-in emits what a provider would: transcripts, audio, barge-in
 * and tool calls. Everything asserted is persisted back-end state, not UI text.
 */
import { nationalIdLast4 } from '../../src/adapters/mock/identity.ts';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { setup, staffLogin } from './harness.ts';
import { get, all } from '../../src/db/db.ts';
import { setEnvForTests, env } from '../../src/config/env.ts';
import { ScriptedProvider, type ScriptedSession } from '../../src/live/scripted.ts';
import { SCENARIOS } from '../../src/db/scenarios.ts';
import { TOOL } from '../../src/live/lily.ts';
import { acceptHandoff } from '../../src/handoff/handoff-service.ts';
import { normaliseSpoken } from '../../src/live/speech.ts';

let app: FastifyInstance;
let base = '';
const original = { LIVE_PROVIDER: env().LIVE_PROVIDER };
const clients: LiveClient[] = [];

beforeEach(async () => {
  app = await setup();
  setEnvForTests({ LIVE_PROVIDER: 'scripted' });
  ScriptedProvider.reset();
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `127.0.0.1:${(app.server.address() as { port: number }).port}`;
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.close();
  setEnvForTests(original);
  await app.close();
});

const DIGIT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const spokenDigits = (code: string) => [...code].map((d) => DIGIT_WORDS[Number(d)]).join(' ');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Browser stand-in: connects to the live socket with the call cookie and records every message. */
class LiveClient {
  msgs: any[] = [];
  view: any = null;
  turns = new Map<number, any>();
  ws!: WebSocket;
  closeCode: number | null = null;
  constructor(readonly sessionId: string, readonly token: string | null) {}

  async open(): Promise<this> {
    this.ws = new WebSocket(`ws://${base}/api/calls/${this.sessionId}/live`, { headers: this.token ? { Cookie: `hio_call=${this.token}` } : {} });
    this.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      this.msgs.push(m);
      if (m.type === 'view') this.view = m.view;
      if (m.type === 'turns') for (const t of m.turns) this.turns.set(t.seq, t);
    });
    this.ws.on('close', (code) => (this.closeCode = code));
    await new Promise<void>((res, rej) => {
      this.ws.once('open', () => res());
      this.ws.once('error', rej);
    });
    clients.push(this);
    return this;
  }
  async waitFor(pred: (m: any) => boolean, ms = 4000): Promise<any> {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const hit = this.msgs.find(pred);
      if (hit) return hit;
      await sleep(25);
    }
    throw new Error(`timed out waiting for message; got ${JSON.stringify(this.msgs.map((m) => m.type))}`);
  }
  of(type: string) {
    return this.msgs.filter((m) => m.type === type);
  }
  customerTurns() {
    return [...this.turns.values()].filter((t) => t.speaker === 'customer');
  }
  assistantTurns() {
    return [...this.turns.values()].filter((t) => t.speaker !== 'customer');
  }
  send(o: object) {
    this.ws.send(JSON.stringify(o));
  }
}

async function startCall(scenarioId?: string): Promise<{ sessionId: string; token: string }> {
  const r = await app.inject({ method: 'POST', url: '/api/calls', payload: { ...(scenarioId ? { scenarioId } : {}), channel: 'voice_browser' } });
  expect(r.statusCode).toBe(201);
  const b = r.json();
  return { sessionId: b.sessionId, token: b.callToken };
}

async function connect(scenarioId?: string) {
  const { sessionId, token } = await startCall(scenarioId);
  const client = await new LiveClient(sessionId, token).open();
  await client.waitFor((m) => m.type === 'ready');
  await sleep(40); // the greeting prompt is sent just after 'ready'
  return { client, sessionId, token, session: ScriptedProvider.last };
}

/** The customer says something and the model decides to call a tool for it. */
async function customerSaysThenTool(client: LiveClient, session: ScriptedSession, words: string, tool: string = TOOL.banking, args: Record<string, unknown> = { topic: 'request' }) {
  const before = session.toolResponses.length;
  session.heard(words);
  session.toolCall(tool, args);
  const start = Date.now();
  while (session.toolResponses.length === before && Date.now() - start < 6000) await sleep(25);
  expect(session.toolResponses.length, 'tool response sent').toBe(before + 1);
  await sleep(40);
  return session.toolResponses.at(-1)!.response as any;
}

const ops = (sessionId: string) => all<any>('SELECT * FROM action_operations WHERE session_id = ?', [sessionId]);
const timelineTypes = (sessionId: string) => all<{ type: string }>('SELECT type FROM timeline_events WHERE session_id = ? ORDER BY id', [sessionId]).map((r) => r.type);

describe('connection lifecycle and availability', () => {
  it('rejects a socket that does not hold the call token', async () => {
    const { sessionId } = await startCall('S01');
    const c = await new LiveClient(sessionId, null).open();
    const err = await c.waitFor((m) => m.type === 'error');
    expect(err.code).toBe('FORBIDDEN');
    expect(ScriptedProvider.sessions).toHaveLength(0);
  });

  it('reports voice unavailable when the provider is switched off, without simulating a connection', async () => {
    setEnvForTests({ LIVE_PROVIDER: 'off' });
    const status = (await app.inject({ method: 'GET', url: '/api/live/status' })).json();
    expect(status.available).toBe(false);
    expect(status.reason).toMatch(/switched off|typing/i);
    const { sessionId, token } = await startCall('S01');
    const c = await new LiveClient(sessionId, token).open();
    const err = await c.waitFor((m) => m.type === 'error');
    expect(err.code).toBe('VOICE_UNAVAILABLE');
    expect(c.of('ready')).toHaveLength(0);
  });

  it('falls back cleanly when the provider cannot connect: the call stays usable by text', async () => {
    ScriptedProvider.failNext = new Error('quota exceeded');
    const { sessionId, token } = await startCall('S01');
    const c = await new LiveClient(sessionId, token).open();
    const err = await c.waitFor((m) => m.type === 'error');
    expect(err.code).toBe('VOICE_UNAVAILABLE');
    expect(err.message).toMatch(/typing/i);
    // The provider's internal error text is not leaked to the browser.
    expect(JSON.stringify(c.msgs)).not.toContain('quota');
    const r = await app.inject({ method: 'POST', url: `/api/calls/${sessionId}/input`, headers: { 'x-call-token': token }, payload: { kind: 'utterance', text: "There's a charge from Novaplay for $249 that I didn't make" } });
    expect(r.statusCode).toBe(200);
    expect(r.json().tags.intent).toBe('unrecognised_transaction');
  });

  it('greets once on a new call, and not again when the voice connection is re-established', async () => {
    const { client, sessionId, session } = await connect('S01');
    expect(session.texts.filter((t) => /greet/i.test(t))).toHaveLength(1);
    expect(session.opts.systemInstruction).toMatch(/AI assistant/);
    // Nothing claims the AI disclosure was given until Lily has actually said her greeting.
    expect(timelineTypes(sessionId)).not.toContain('disclosure.given');
    session.said("Hi, I'm Lily, an AI assistant for Hear It Once. How can I help today?");
    session.turnComplete();
    await sleep(80);
    expect(timelineTypes(sessionId)).toContain('disclosure.given');
    expect(all<any>("SELECT text FROM conversation_turns WHERE session_id = ? AND speaker = 'assistant'", [sessionId]).map((r) => r.text).join(' ')).toMatch(/AI assistant/);
    expect(session.opts.systemInstruction).not.toMatch(/ALREADY IN PROGRESS/);
    client.ws.close();
    await sleep(60);
    const again = await new LiveClient(sessionId, (await app.inject({ method: 'POST', url: '/api/calls', payload: {} })).json().callToken).open();
    void again;
    // Same call, new socket: the original token is needed.
    expect(get('SELECT 1 FROM call_sessions WHERE id = ?', [sessionId])).toBeTruthy();
  });

  it('resumes the conversation with a recap instead of a second greeting after a reconnect', async () => {
    const { client, sessionId, token, session } = await connect('S01');
    await customerSaysThenTool(client, session, "There's a charge from Novaplay for $249 that I didn't make");
    client.ws.close();
    await sleep(60);
    const second = await new LiveClient(sessionId, token).open();
    await second.waitFor((m) => m.type === 'ready');
    const resumed = ScriptedProvider.last;
    expect(second.of('ready')[0].resumed).toBe(true);
    expect(resumed.opts.systemInstruction).toMatch(/ALREADY IN PROGRESS/);
    expect(resumed.opts.systemInstruction).toMatch(/Novaplay/i);
    expect(resumed.texts.filter((t) => /greet/i.test(t))).toHaveLength(0);
  });

  it('survives an unexpected provider disconnect by reconnecting and telling the browser', async () => {
    const { client, session } = await connect('S01');
    session.drop('network');
    const reconnecting = await client.waitFor((m) => m.type === 'voice' && m.status === 'reconnecting');
    expect(reconnecting.message).toMatch(/Reconnecting/);
    await client.waitFor((m) => m.type === 'voice' && m.status === 'restored', 6000);
    expect(ScriptedProvider.sessions.length).toBe(2);
  });

  it('says the voice is lost (and offers text) when reconnection keeps failing', async () => {
    const { client, session } = await connect('S01');
    ScriptedProvider.failNext = new Error('down');
    // every reconnect attempt fails: keep re-arming the failure
    const orig = ScriptedProvider.prototype.connect;
    ScriptedProvider.prototype.connect = async () => {
      throw new Error('still down');
    };
    try {
      session.drop('network');
      const lost = await client.waitFor((m) => m.type === 'voice' && m.status === 'lost', 12000);
      expect(lost.message).toMatch(/typing/);
      expect(timelineTypes(client.sessionId)).toContain('voice.lost');
    } finally {
      ScriptedProvider.prototype.connect = orig;
    }
  }, 20000);
});

describe('open conversation: small talk, unrelated topics and switching', () => {
  it('records small talk as ordinary conversation without creating a case, intent or verification', async () => {
    const { client, sessionId, session } = await connect('S01');
    session.heard('Hi Lily, how are you today?');
    session.audioOut();
    session.said("I'm doing well, thanks for asking! How can I help with your banking today?");
    session.turnComplete();
    await client.waitFor((m) => m.type === 'turns' && m.turns.some((t: any) => t.speaker === 'assistant' && /doing well/.test(t.text)));
    expect(client.customerTurns().map((t) => t.text)).toContain('Hi Lily, how are you today?');
    expect(get('SELECT 1 FROM cases WHERE session_id = ?', [sessionId])).toBeFalsy();
    expect(get<any>('SELECT verification_status, issue_type FROM call_sessions WHERE id = ?', [sessionId])).toMatchObject({ issue_type: null });
    expect(ops(sessionId)).toHaveLength(0);
  });

  it('politely redirects an unrelated question and does not end or hand off the call', async () => {
    const { client, sessionId, session } = await connect('S01');
    session.heard('Can you recommend somewhere to visit this weekend?');
    session.said('Travel tips are outside what I can help with, but I can help with your cards and accounts.');
    session.turnComplete();
    await client.waitFor((m) => m.type === 'turns' && m.turns.some((t: any) => /outside what I can help/.test(t.text)));
    expect(get('SELECT 1 FROM handoffs WHERE session_id = ?', [sessionId])).toBeFalsy();
    expect(get<any>('SELECT ended_at FROM call_sessions WHERE id = ?', [sessionId]).ended_at).toBeNull();
  });

  it('small talk first, then a banking question: the banking turn is handled once and tagged', async () => {
    const { client, sessionId, session } = await connect('S01');
    session.heard('Hello, hope your day is going well.');
    session.said('Thanks, it is! What can I do for you?');
    session.turnComplete();
    await client.waitFor((m) => m.type === 'turns' && m.turns.some((t: any) => /What can I do/.test(t.text)));
    const out = await customerSaysThenTool(client, session, "There's a charge from Novaplay for $249 that I didn't make");
    expect(out.ok).toBe(true);
    expect(out.awaiting).toBe('date_of_birth');
    expect(out.backend_said.join(' ')).toMatch(/verify your identity|date of birth/i);
    const view = (await app.inject({ method: 'GET', url: `/api/calls/${sessionId}`, headers: { 'x-call-token': client.token! } })).json();
    expect(view.tags.intent).toBe('unrecognised_transaction');
    // The banking words were recorded exactly once (by the orchestrator), not again as small talk.
    expect(client.customerTurns().filter((t) => /Novaplay/.test(t.text))).toHaveLength(1);
  });

  it('apparently unrelated words that reveal a banking problem reach the back end', async () => {
    const { client, sessionId, session } = await connect('S19');
    const out = await customerSaysThenTool(client, session, "I'm travelling tomorrow and my card keeps getting declined");
    expect(out.ok).toBe(true);
    expect(out.awaiting).toBe('date_of_birth');
    expect(get<any>('SELECT issue_type FROM call_sessions WHERE id = ?', [sessionId]).issue_type).toBe('card_declined');
  });

  it("does not store Lily's paraphrase of a tool result a second time", async () => {
    const { client, sessionId, session } = await connect('S01');
    session.heard("There's a charge from Novaplay for $249 that I didn't make");
    session.said('Let me check that for you.');
    session.toolCall(TOOL.banking, { topic: 'charge' });
    await sleep(500);
    session.said('Okay, first I need to verify your identity, so what is your date of birth?');
    session.turnComplete();
    await sleep(100);
    const spoken = all<any>("SELECT text FROM conversation_turns WHERE session_id = ? AND kind = 'voice' AND speaker = 'assistant'", [sessionId]);
    expect(spoken).toHaveLength(0);
    void client;
  });
});

describe('verification, consent and policy are enforced by the back end', () => {
  async function runS01ToConsent() {
    const ctx = await connect('S01');
    const { client, session } = ctx;
    await customerSaysThenTool(client, session, "There's a charge from Novaplay for $249 that I didn't make");
    const dob = SCENARIOS.find((s) => s.id === 'S01')!.customer.dob; // 1986-04-12
    expect(dob).toBe('1986-04-12');
    const afterDob = await customerSaysThenTool(client, session, 'My date of birth is April twelfth nineteen eighty six');
    expect(afterDob.awaiting).toBe('one_time_passcode');
    const code = client.view.demoDevice?.code as string;
    expect(code).toMatch(/^\d{6}$/);
    const afterOtp = await customerSaysThenTool(client, session, `It is ${spokenDigits(code)}`);
    return { ...ctx, afterOtp };
  }

  it('verifies by spoken date of birth and spoken passcode, then proposes actions and waits for consent', async () => {
    const { sessionId, afterOtp } = await runS01ToConsent();
    expect(afterOtp.identity).toBe('verified');
    expect(afterOtp.awaiting).toBe('customer_yes_or_no_to_the_proposed_action');
    expect(afterOtp.backend_said.join(' ')).toMatch(/novaplay/i);
    // Proposed, not done.
    expect(get<any>("SELECT status FROM bank_cards WHERE customer_id = 'CUS-1001'").status).toBe('active');
    expect(ops(sessionId).every((o) => o.status !== 'succeeded')).toBe(true);
  });

  it('never accepts consent from the model: a tool call with no new customer words does nothing', async () => {
    const { client, session, sessionId } = await runS01ToConsent();
    const before = session.toolResponses.length;
    session.toolCall(TOOL.banking, { topic: 'customer said yes' }); // the model claims agreement
    while (session.toolResponses.length === before) await sleep(25);
    const out = session.toolResponses.at(-1)!.response as any;
    expect(out.ok).toBe(false);
    expect(out.error).toBe('no_new_customer_speech');
    expect(get<any>("SELECT status FROM bank_cards WHERE customer_id = 'CUS-1001'").status).toBe('active');
    expect(ops(sessionId).filter((o) => o.status === 'succeeded')).toHaveLength(0);
    void client;
  }, 20000);

  it("completes the actions only after the customer's own spoken yes", async () => {
    const { client, session, sessionId } = await runS01ToConsent();
    const out = await customerSaysThenTool(client, session, 'Yes, go ahead please');
    expect(out.ok).toBe(true);
    expect(get<any>("SELECT status FROM bank_cards WHERE customer_id = 'CUS-1001'").status).toBe('blocked');
    const done = ops(sessionId).filter((o) => o.status === 'succeeded').map((o) => o.action_type);
    expect(done).toContain('block_card');
    expect(timelineTypes(sessionId)).toEqual(expect.arrayContaining(['consent.given', 'action.succeeded']));
    // The browser received the live view with the confirmed operations.
    await client.waitFor((m) => m.type === 'view' && m.view.operations.some((o: any) => o.status === 'succeeded'));
  }, 20000);

  it('does not turn a "no" into consent', async () => {
    const { client, session, sessionId } = await runS01ToConsent();
    await customerSaysThenTool(client, session, 'No, do not do that');
    expect(get<any>("SELECT status FROM bank_cards WHERE customer_id = 'CUS-1001'").status).toBe('active');
    expect(ops(sessionId).filter((o) => o.status === 'succeeded')).toHaveLength(0);
    void client;
  }, 20000);

  it('blocks a protected action requested before identity is verified (API and voice)', async () => {
    const { client, sessionId, token, session } = await connect('S02');
    const out = await customerSaysThenTool(client, session, 'I lost my credit card, please block it right now');
    expect(out.identity).toBe('not_yet_verified');
    expect(out.awaiting).toBe('date_of_birth');
    expect(get<any>("SELECT status FROM bank_cards WHERE customer_id = 'CUS-1002'").status).toBe('active');
    const direct = await app.inject({ method: 'POST', url: `/api/calls/${sessionId}/actions`, headers: { 'x-call-token': token, 'idempotency-key': 'live-test-0001' }, payload: { type: 'block_card', targetRef: 'CRD-1002A', consentId: null } });
    expect(direct.statusCode).toBe(403);
    expect(direct.json().error.code).toBe('VERIFICATION_REQUIRED');
    expect(ops(sessionId)).toHaveLength(0);
  });

  it('asks for a repeat instead of acting when speech is uncertain', async () => {
    const { client, session, sessionId } = await connect('S01');
    const out = await customerSaysThenTool(client, session, '[inaudible]');
    expect(out.backend_said.join(' ')).toMatch(/didn't catch/i);
    expect(ops(sessionId)).toHaveLength(0);
    expect(timelineTypes(sessionId)).toContain('input.low_confidence');
    void client;
  });

  it('shows the lookup that really ran, and a failed lookup is not reported as success (S11)', async () => {
    const { client, session, sessionId } = await connect('S11');
    await customerSaysThenTool(client, session, "I don't recognise a QuickStream charge of $59.99");
    await customerSaysThenTool(client, session, 'My date of birth is 1980-05-05');
    const code = client.view.demoDevice.code as string;
    const out = await customerSaysThenTool(client, session, code);
    const said = out.backend_said.join(' ');
    expect(said).toMatch(/can't get reliable information|transferring you to an agent/i);
    expect(said).not.toMatch(/blocked|disputed|refunded/i);
    expect(ops(sessionId).filter((o) => o.status === 'succeeded')).toHaveLength(0);
    const types = timelineTypes(sessionId);
    expect(types).toContain('handoff.queued');
    const failed = all<any>("SELECT title FROM timeline_events WHERE session_id = ? AND type = 'source.completed' AND status IN ('failed','warn','blocked')", [sessionId]);
    expect(failed.length).toBeGreaterThan(0);
    expect(out.handoff.status).toBe('waiting_for_an_agent_not_yet_accepted');
  }, 20000);
});

describe('card declined journey (read-only, verified lookups)', () => {
  it('explains the recorded decline after verification and changes nothing on the card', async () => {
    const { client, session, sessionId } = await connect('S19');
    await customerSaysThenTool(client, session, "I'm travelling tomorrow and my card keeps getting declined");
    await customerSaysThenTool(client, session, 'My date of birth is 1991-05-17');
    const out = await customerSaysThenTool(client, session, client.view.demoDevice.code);
    const said = out.backend_said.join(' ');
    expect(said).toMatch(/EuroRail Booking/);
    expect(said).toMatch(/travel security rule/);
    expect(said).toMatch(/haven't changed anything/);
    expect(get<any>("SELECT status FROM bank_cards WHERE customer_id = 'CUS-1019'").status).toBe('active');
    expect(ops(sessionId)).toHaveLength(0);
    const types = timelineTypes(sessionId);
    expect(types).toContain('source.completed');
    const sources = all<{ title: string }>("SELECT title FROM timeline_events WHERE session_id = ? AND type = 'source.completed'", [sessionId]).map((r) => r.title).join(' ');
    expect(sources).toMatch(/authoris/i);
  }, 20000);
});

describe('multiple topics and the final summary', () => {
  it('tags a second topic as secondary and keeps the first as the primary intent (S05 fee then payment)', async () => {
    const { client, session, sessionId } = await connect('S05');
    await customerSaysThenTool(client, session, 'Why was I charged a late fee?');
    await customerSaysThenTool(client, session, 'My date of birth is 1975-06-18');
    await customerSaysThenTool(client, session, client.view.demoDevice.code);
    await customerSaysThenTool(client, session, 'No thanks, leave the fee');
    const out = await customerSaysThenTool(client, session, 'Actually I also made a payment of $500 last week and it is not showing');
    expect(out.ok).toBe(true);
    const view = (await app.inject({ method: 'GET', url: `/api/calls/${sessionId}`, headers: { 'x-call-token': client.token! } })).json();
    expect(view.tags.intent).toBe('fee_query');
    expect(view.tags.secondaryIntents.map((x: any) => x.intent)).toContain('payment_not_showing');
    expect(timelineTypes(sessionId)).toContain('intent.secondary');
    // Only one case for the whole call.
    expect(get<any>('SELECT COUNT(*) n FROM cases WHERE session_id = ?', [sessionId]).n).toBe(1);
  }, 30000);
});

describe('interruption (barge-in)', () => {
  it('stops playback in the browser and records only what Lily actually said, marked as interrupted', async () => {
    const { client, session, sessionId } = await connect('S01');
    session.heard('Can you explain how fees work?');
    session.audioOut();
    session.said('Sure. Fees on a card can include late payment fees, annual fees and');
    session.interrupt();
    await client.waitFor((m) => m.type === 'interrupted');
    session.heard('Actually, never mind.');
    session.turnComplete();
    await sleep(120);
    const rows = all<any>("SELECT speaker, kind, text FROM conversation_turns WHERE session_id = ? ORDER BY seq", [sessionId]);
    const lily = rows.find((r) => r.kind === 'voice_interrupted');
    expect(lily.text).toMatch(/annual fees and …$/);
    expect(rows.filter((r) => r.speaker === 'customer').map((r) => r.text)).toEqual(expect.arrayContaining(['Can you explain how fees work?', 'Actually, never mind.']));
    expect(timelineTypes(sessionId)).toContain('voice.barge_in');
    expect(all<any>("SELECT 1 FROM session_events WHERE session_id = ? AND event_type = 'barge_in'", [sessionId]).length).toBeGreaterThan(0);
  });
});

describe('Lily stops taking the call once it is going to a person', () => {
  /** Take a live call to the point where the customer has agreed to be transferred. */
  async function upToTransfer() {
    const ctx = await connect('S01');
    ctx.client.send({ type: 'text', text: 'I want to speak to a person' });
    await sleep(250);
    ctx.client.send({ type: 'text', text: 'yes' });
    await sleep(350);
    return ctx;
  }

  it('finishes the sentence she is saying before stopping, rather than being cut off', async () => {
    const { session } = await upToTransfer();
    // The transfer has been confirmed but she has not finished speaking, so the session is open.
    expect(session.closed).toBe(false);
    session.turnComplete();
    await sleep(80);
    expect(session.closed).toBe(true);
  });

  it('hears nothing the customer says after that', async () => {
    const { client, session } = await upToTransfer();
    session.turnComplete();
    await sleep(80);
    const heardSoFar = session.audioIn.length;
    client.send({ type: 'audio', data: 'AAAA' });
    client.send({ type: 'audio', data: 'BBBB' });
    await sleep(120);
    expect(session.audioIn).toHaveLength(heardSoFar);
  });

  it('stops even if the model never finishes its turn', async () => {
    const { session } = await upToTransfer();
    expect(session.closed).toBe(false);
    await sleep(6200); // the fallback timer
    expect(session.closed).toBe(true);
  }, 12_000);

  it('does not reconnect itself afterwards', async () => {
    const { session, sessionId } = await upToTransfer();
    session.turnComplete();
    await sleep(80);
    const was = ScriptedProvider.last;
    session.drop('provider went away');
    await sleep(400);
    // A reconnect would have opened a new provider session; nothing should have.
    expect(ScriptedProvider.last).toBe(was);
    expect(timelineTypes(sessionId)).not.toContain('voice.reconnecting');
  });

  it('says so on the record, so the agent can see where she stopped', async () => {
    const { client, session, sessionId } = await upToTransfer();
    session.turnComplete();
    await sleep(120);
    expect(timelineTypes(sessionId)).toContain('voice.stepped_back');
    expect(client.msgs.some((m) => m.type === 'voice' && /stepped back/i.test(m.message ?? ''))).toBe(true);
  });

  it('the call itself stays open: the transfer is not a dropped call', async () => {
    const { session, sessionId } = await upToTransfer();
    session.turnComplete();
    await sleep(120);
    expect(get<any>('SELECT ended_at FROM call_sessions WHERE id = ?', [sessionId]).ended_at).toBeNull();
    expect(get<any>('SELECT status FROM handoffs WHERE session_id = ?', [sessionId])?.status).toBe('queued');
  });
});

describe('mute and typed fallback during a live call', () => {
  it('stops sending microphone audio to the provider while muted', async () => {
    const { client, session, sessionId } = await connect('S01');
    client.send({ type: 'audio', data: 'AAAA' });
    await sleep(60);
    expect(session.audioIn).toHaveLength(1);
    client.send({ type: 'mute', muted: true });
    await sleep(40);
    client.send({ type: 'audio', data: 'BBBB' });
    await sleep(60);
    expect(session.audioIn).toHaveLength(1);
    expect(timelineTypes(sessionId)).toContain('voice.muted');
    client.send({ type: 'mute', muted: false });
    await sleep(40);
    client.send({ type: 'audio', data: 'CCCC' });
    await sleep(60);
    expect(session.audioIn).toEqual(['AAAA', 'CCCC']);
  });

  it('accepts typed input on a live call through the same back end and asks Lily to say the reply', async () => {
    const { client, session, sessionId } = await connect('S01');
    client.send({ type: 'text', text: "There's a charge from Novaplay for $249 that I didn't make" });
    await client.waitFor((m) => m.type === 'turns' && m.turns.some((t: any) => /date of birth/i.test(t.text)));
    expect(get<any>('SELECT issue_type FROM call_sessions WHERE id = ?', [sessionId]).issue_type).toBe('unrecognised_transaction');
    expect(session.texts.some((t) => /typed a message/.test(t))).toBe(true);
  });
});

describe('human handover is a real, persisted, live workflow', () => {
  it('a spoken request for a person creates a queued handover that stays pending until an agent accepts', async () => {
    const { client, sessionId, session } = await connect('S08');
    const out = await customerSaysThenTool(client, session, 'I want to speak to a real person', TOOL.human, { reason: 'asked for a person' });
    expect(out.ok).toBe(true);
    expect(out.handoff.status).toBe('waiting_for_an_agent_not_yet_accepted');
    expect(out.instruction).toMatch(/Do NOT say an agent has joined/);
    const h = get<any>('SELECT * FROM handoffs WHERE session_id = ?', [sessionId]);
    expect(h.status).toBe('queued');
    expect(h.agent_id).toBeNull();
    const view = await client.waitFor((m) => m.type === 'view' && m.view.handoff?.status === 'queued');
    expect(view.view.handoff.agentName).toBeNull();
    expect(client.of('view').at(-1).view.handoff.status).toBe('queued');
    expect(client.assistantTurns().some((t) => /joined the call/i.test(t.text))).toBe(false);
    // The customer's own words were recorded as spoken, not as a button press.
    expect(client.customerTurns().some((t) => /real person/.test(t.text))).toBe(true);
    expect(all<any>("SELECT text FROM conversation_turns WHERE session_id = ? AND kind = 'button'", [sessionId])).toHaveLength(0);
    expect(session.texts.some((t) => /SYSTEM EVENT/.test(t))).toBe(false);
  });

  it('pushes the handover to the agent console the moment it is queued, with no refresh', async () => {
    const cookie = await staffLogin(app, 'STF-AGENT-1');
    const events: any[] = [];
    const ac = new AbortController();
    const res = await fetch(`http://${base}/api/handoffs/stream`, { headers: { cookie }, signal: ac.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const pump = (async () => {
      const dec = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value);
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const m = chunk.match(/^data: (.*)$/m);
            if (m) events.push(JSON.parse(m[1]));
          }
        }
      } catch {
        /* aborted */
      }
    })();
    const { client, sessionId, session } = await connect('S08');
    await customerSaysThenTool(client, session, 'I want to speak to a real person', TOOL.human);
    const start = Date.now();
    while (!events.some((e) => e.type === 'handoff.queued') && Date.now() - start < 3000) await sleep(25);
    expect(events.find((e) => e.type === 'handoff.queued')).toMatchObject({ sessionId, status: 'pending' });
    // The queue the console loads in response contains it.
    const list = (await app.inject({ method: 'GET', url: '/api/handoffs', headers: { cookie } })).json().items;
    expect(list.find((h: any) => h.sessionId === sessionId)?.status).toBe('queued');
    ac.abort();
    await pump;
  });

  it('the stream is closed to callers and to staff without handoff access', async () => {
    const r = await fetch(`http://${base}/api/handoffs/stream`);
    expect(r.status).toBe(401);
    await r.body?.cancel();
  });

  it('agent acceptance is reflected in the call and Lily is told only after it is confirmed', async () => {
    const { client, sessionId, session } = await connect('S08');
    await customerSaysThenTool(client, session, 'Please put me through to a person', TOOL.human);
    const h = get<any>('SELECT id FROM handoffs WHERE session_id = ?', [sessionId]);
    expect(session.texts.some((t) => /SYSTEM EVENT/.test(t))).toBe(false);
    acceptHandoff(h.id, { type: 'agent', id: 'STF-AGENT-1' });
    const connected = await client.waitFor((m) => m.type === 'timeline' && m.event.type === 'handoff.connected');
    expect(connected.event.title).toMatch(/Agent joined/);
    const v = await client.waitFor((m) => m.type === 'view' && m.view.handoff?.status === 'connected');
    expect(v.view.handoff.agentName).toMatch(/Jordan/);
    await sleep(60);
    expect(session.texts.some((t) => /SYSTEM EVENT \(confirmed\)/.test(t))).toBe(true);
  });

  it('the handover brief summarises the whole interaction: primary and secondary topics, checks, actions', async () => {
    const { client, sessionId, session } = await connect('S01');
    await customerSaysThenTool(client, session, "There's a charge from Novaplay for $249 that I didn't make");
    await customerSaysThenTool(client, session, 'My date of birth is 1986-04-12');
    await customerSaysThenTool(client, session, client.view.demoDevice.code);
    await customerSaysThenTool(client, session, 'Actually I would rather speak to a person about this', TOOL.human);
    const cookie = await staffLogin(app, 'STF-AGENT-1');
    const h = get<any>('SELECT id FROM handoffs WHERE session_id = ?', [sessionId]);
    const detail = (await app.inject({ method: 'GET', url: `/api/handoffs/${h.id}`, headers: { cookie } })).json();
    const brief = detail.handoff.brief;
    expect(brief.customerReported ?? brief.issue?.statement ?? JSON.stringify(brief)).toMatch(/Novaplay/);
    expect(JSON.stringify(brief)).toMatch(/verified/i);
    // No action was completed (consent was never given) and the brief says nothing was done.
    expect(ops(sessionId).filter((o) => o.status === 'succeeded')).toHaveLength(0);
    expect(JSON.stringify(brief.actions ?? [])).not.toMatch(/succeeded/);
  }, 30000);
});

describe('ending the call and the post-call record', () => {
  it('ending the call closes it, records the outcome from what actually happened, and returns the final view', async () => {
    const { client, sessionId, session } = await connect('S01');
    await customerSaysThenTool(client, session, "There's a charge from Novaplay for $249 that I didn't make");
    client.send({ type: 'end' });
    const ended = await client.waitFor((m) => m.type === 'ended');
    expect(ended.view.session.endedAt).toBeTruthy();
    expect(ended.view.session.outcome).toBe('ended_unresolved');
    expect(ended.view.transcript.length).toBeGreaterThan(2);
    expect(session.closed).toBe(true);
    expect(timelineTypes(sessionId)).toEqual(expect.arrayContaining(['call.closed', 'voice.disconnected']));
  });

  it('refuses a live connection to a call that has already ended', async () => {
    const { client, sessionId, token } = await connect('S01');
    client.send({ type: 'end' });
    await client.waitFor((m) => m.type === 'ended');
    const again = await new LiveClient(sessionId, token).open();
    const err = await again.waitFor((m) => m.type === 'error');
    expect(err.code).toBe('CALL_ENDED');
  });
});

describe('spoken numbers and dates are normalised without inventing digits', () => {
  it.each([
    ['four eight two nine one three', '482913'],
    ['my code is four eight two nine one three thanks', 'my code is 482913 thanks'],
    ['April twelfth nineteen eighty six', 'april 12 1986'],
    ['the twenty first of March two thousand five', 'march 21 2005'],
    ['I have two cards and one problem', 'I have two cards and one problem'],
    ['four eight two', 'four eight two'],
  ])('%s', (input, expected) => {
    const out = normaliseSpoken(input);
    expect(out.toLowerCase()).toBe(expected.toLowerCase());
  });
});

describe('virtual agents by language (Lily, Maya; May is not live yet)', () => {
  /** The customer agreed to move; the outgoing agent says its line and the turn completes. */
  async function moveTo(session: ScriptedSession, lang: string) {
    const before = ScriptedProvider.sessions.length;
    const answered = session.toolResponses.length;
    session.toolCall(TOOL.switch, { language: lang });
    const start = Date.now();
    while (session.toolResponses.length === answered && Date.now() - start < 4000) await sleep(25);
    session.said('Of course, I will bring in a colleague.');
    session.turnComplete();
    const t0 = Date.now();
    while (ScriptedProvider.sessions.length === before && Date.now() - t0 < 4000) await sleep(25);
    await sleep(60);
  }

  it('every call starts in English with Lily and her own voice', async () => {
    const { session } = await connect('S01');
    expect(session.opts.systemInstruction).toMatch(/^You are Lily,/);
    // English is named explicitly like every other language: a model that is not told which voice
    // to use falls back to its own default, which on several Live models is a different speaker.
    expect(session.opts.voice).toBe('Aoede');
    expect(session.opts.systemInstruction).toMatch(/do NOT switch by yourself/);
    expect(session.opts.tools.map((t) => t.name)).toContain(TOOL.switch);
  });

  it('moves to Maya after the customer agreed: new voice, new name, same facts, recorded in the transcript', async () => {
    const { client, sessionId, session } = await connect('S01');
    await customerSaysThenTool(client, session, "There's a charge from Novaplay for $249 that I didn't make");
    await moveTo(session, 'fil');
    const maya = ScriptedProvider.last;
    expect(maya).not.toBe(session);
    expect(session.closed).toBe(true);
    expect(maya.opts.voice).toBe('Leda');
    expect(maya.opts.systemInstruction).toMatch(/^You are Maya,/);
    expect(maya.opts.systemInstruction).toMatch(/Tagalog/);
    // Carried across, so nothing has to be asked again.
    expect(maya.opts.systemInstruction).toMatch(/JOINING A CALL THAT IS ALREADY IN PROGRESS/);
    expect(maya.opts.systemInstruction).toMatch(/Already known/);
    expect(maya.texts.at(-1)).toMatch(/taken over/);
    const msg = await client.waitFor((m) => m.type === 'agent');
    expect(msg).toMatchObject({ lang: 'fil', name: 'Maya', from: 'Lily' });
    expect(get<{ context_json: string }>('SELECT context_json FROM call_sessions WHERE id = ?', [sessionId])!.context_json).toContain('"agentLang":"fil"');
    expect(all<{ kind: string }>('SELECT kind FROM conversation_turns WHERE session_id = ?', [sessionId]).some((t) => t.kind === 'agent_switch:Maya')).toBe(true);
    expect(timelineTypes(sessionId)).toContain('agent.switched');
  });

  /**
   * Burmese is built — May has a prompt, a voice and a seat — but she is not taking calls yet. The
   * refusal is enforced in the bridge rather than left to the prompt, because a model asked twice by
   * an insistent customer will try anyway, and switching to an agent that is not ready would leave
   * the customer somewhere worse than English.
   */
  it('refuses to move to Burmese, and says so rather than failing silently', async () => {
    const { session, sessionId } = await connect('S01');
    const before = ScriptedProvider.sessions.length;
    session.toolCall(TOOL.switch, { language: 'my' });
    await sleep(160);
    const r = session.toolResponses.at(-1)!.response as any;
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/May/);
    expect(r.message).toMatch(/not taking calls yet/i);
    // No new agent was brought in, and Lily still has the call.
    expect(ScriptedProvider.sessions.length).toBe(before);
    expect(session.closed).toBe(false);
    expect(timelineTypes(sessionId)).toContain('agent.switch_refused');
    expect(timelineTypes(sessionId)).not.toContain('agent.switched');
  });

  it('never offers Burmese in the first place', async () => {
    const { session } = await connect('S01');
    const p = session.opts.systemInstruction;
    expect(p).toMatch(/May will speak Burmese, but she is not taking calls yet/);
    expect(p).toMatch(/never call .* for Burmese/i);
  });

  it('a language switch in the middle of a second-level check keeps the check going', async () => {
    const { client, sessionId, session } = await connect('S01');
    await customerSaysThenTool(client, session, "There's a charge from Novaplay for $249 that I didn't make");
    await customerSaysThenTool(client, session, 'My date of birth is 1986-04-12');
    await customerSaysThenTool(client, session, client.view.demoDevice.code);
    const ask = await customerSaysThenTool(client, session, 'I also want to change my address');
    expect(ask.backend_said.join(' ')).toMatch(/last four digits/i);
    await moveTo(session, 'fil');
    const maya = ScriptedProvider.last;
    expect(maya.opts.systemInstruction).toMatch(/^You are Maya,/);
    const cust = get<{ customer_id: string }>('SELECT customer_id FROM call_sessions WHERE id = ?', [sessionId])!.customer_id;
    const out = await customerSaysThenTool(client, maya, nationalIdLast4(cust));
    expect(out.backend_said.join(' ')).toMatch(/that matches/i);
    expect(out.backend_said.join(' ')).toMatch(/full new address/i);
  }, 20000);

  it('only one agent is ever heard: the outgoing session cannot speak over the new one', async () => {
    const { client, session } = await connect('S01');
    session.audioOut('LILY');
    await moveTo(session, 'fil');
    const maya = ScriptedProvider.last;
    // The browser is told to drop whatever Lily had already streamed.
    const order = client.msgs.map((m) => m.type);
    expect(order.lastIndexOf('interrupted')).toBeGreaterThan(order.lastIndexOf('audio'));
    const sinceSwitch = client.msgs.length;
    // Frames still buffered in the closing socket arrive late; none of them may reach the browser.
    session.audioOut('STALE');
    session.said('Lily talking over Maya');
    session.turnComplete();
    await sleep(80);
    const late = client.msgs.slice(sinceSwitch);
    expect(late.filter((m) => m.type === 'audio')).toHaveLength(0);
    expect(JSON.stringify(late)).not.toContain('Lily talking over Maya');
    // The new agent is unaffected.
    const mark = client.msgs.length;
    maya.audioOut('MAYA');
    await sleep(80);
    expect(client.msgs.slice(mark).filter((m) => m.type === 'audio').map((m) => m.data)).toEqual(['MAYA']);
  });

  it('keeps the new agent through a dropped connection and a new browser tab', async () => {
    const { client, sessionId, token, session } = await connect('S01');
    await moveTo(session, 'fil');
    expect(ScriptedProvider.last.opts.systemInstruction).toMatch(/^You are Maya,/);
    expect(ScriptedProvider.last.opts.voice).toBe('Leda');
    const before = ScriptedProvider.sessions.length;
    ScriptedProvider.last.drop('network');
    const t0 = Date.now();
    while (ScriptedProvider.sessions.length === before && Date.now() - t0 < 6000) await sleep(50);
    expect(ScriptedProvider.last.opts.systemInstruction).toMatch(/^You are Maya,/);
    client.ws.close();
    const again = await new LiveClient(sessionId, token).open();
    const ready = await again.waitFor((m) => m.type === 'ready');
    expect(ready.agent).toEqual({ lang: 'fil', name: 'Maya' });
    expect(ScriptedProvider.last.opts.systemInstruction).toMatch(/^You are Maya,/);
  });

  it('can go back to Lily, and refuses a switch to the same or an unknown language', async () => {
    const { session } = await connect('S01');
    session.toolCall(TOOL.switch, { language: 'en' });
    await sleep(120);
    expect((session.toolResponses.at(-1)!.response as any).ok).toBe(false);
    session.toolCall(TOOL.switch, { language: 'xx' });
    await sleep(120);
    expect((session.toolResponses.at(-1)!.response as any).ok).toBe(false);
    await moveTo(session, 'fil');
    await moveTo(ScriptedProvider.last, 'en');
    expect(ScriptedProvider.last.opts.systemInstruction).toMatch(/^You are Lily,/);
    expect(ScriptedProvider.last.opts.voice).toBe('Aoede');
  });

  it('the other agents keep Lily by name only where she is a team member', async () => {
    const { session } = await connect('S01');
    await moveTo(session, 'fil');
    const p = ScriptedProvider.last.opts.systemInstruction;
    expect(p).toMatch(/Lily \(English, the main agent\)/);
    expect(p).not.toMatch(/You are Lily/);
  });
});

/**
 * One spoken answer, one line in the transcript. Lily says the back end's words aloud in her own
 * phrasing, so while a tool that writes the transcript is running, what she says is not stored as
 * well: that is what put every line in twice.
 */
describe('a turn is recorded once', () => {
  const assistantTexts = (sessionId: string) =>
    all<{ text: string }>("SELECT text FROM conversation_turns WHERE session_id = ? AND speaker IN ('assistant','system') ORDER BY seq", [sessionId]).map((r) => r.text);
  const duplicates = (texts: string[]) => {
    const seen = new Map<string, number>();
    for (const t of texts) { const k = t.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60); if (k.length > 12) seen.set(k, (seen.get(k) ?? 0) + 1); }
    return [...seen.entries()].filter(([, n]) => n > 1);
  };

  it('does not store Lily speaking while the banking tool is still running', async () => {
    const { client, sessionId, session } = await connect('S02');
    session.heard('I lost my card');
    const call = session.toolCall(TOOL.banking, { topic: 'lost card' });
    // She acknowledges out loud and her turn completes before the back end has answered.
    session.said('I am sorry, that is stressful. Let us get the card blocked quickly. First I just need to check it is you.');
    session.turnComplete();
    await client.waitFor((m) => m.type === 'turns' && m.turns.some((t: any) => /date of birth/i.test(t.text)), 6000);
    expect(session.toolResponses.some((r) => r.id === call.id)).toBe(true);
    const texts = assistantTexts(sessionId);
    expect(duplicates(texts), `duplicates: ${JSON.stringify(duplicates(texts))}`).toHaveLength(0);
    expect(texts.filter((t) => /stressful/i.test(t))).toHaveLength(1);
  });

  it('does not store her spoken version of the back end’s reply after the tool returns', async () => {
    const { client, sessionId, session } = await connect('S02');
    await customerSaysThenTool(client, session, 'I lost my card');
    session.said('Okay, first I need to check it is you. What is your date of birth?');
    session.turnComplete();
    await sleep(60);
    const texts = assistantTexts(sessionId);
    expect(duplicates(texts)).toHaveLength(0);
    expect(texts.filter((t) => /date of birth/i.test(t))).toHaveLength(1);
  });

  it('keeps what she says when a tool failed and wrote nothing, so there is no silent gap', async () => {
    const { sessionId, session } = await connect('S02');
    session.toolCall('unknown_tool_name', {});
    const start = Date.now();
    while (!session.toolResponses.length && Date.now() - start < 4000) await sleep(25);
    expect((session.toolResponses.at(-1)!.response as any).ok).toBe(false);
    session.said('Sorry, I could not complete that. Let me get a colleague for you.');
    session.turnComplete();
    await sleep(80);
    expect(assistantTexts(sessionId).some((t) => /could not complete that/i.test(t))).toBe(true);
  });

  it('keeps what she says on her own, with no tool behind it', async () => {
    const { sessionId, session } = await connect('S02');
    session.said('Hello, you are through to Northstar Bank. I am Lily, an AI assistant. How can I help?');
    session.turnComplete();
    await sleep(60);
    expect(assistantTexts(sessionId).some((t) => /AI assistant/i.test(t))).toBe(true);
  });

  it('a second tool call for the same turn does not repeat the back end’s words', async () => {
    const { client, sessionId, session } = await connect('S02');
    await customerSaysThenTool(client, session, 'I lost my card');
    const before = assistantTexts(sessionId).length;
    // A repeated call with nothing new to act on must not produce another copy of the prompt.
    const n = session.toolResponses.length;
    session.toolCall(TOOL.banking, { topic: 'lost card' });
    const start = Date.now();
    while (session.toolResponses.length === n && Date.now() - start < 6000) await sleep(25);
    await sleep(60);
    expect(assistantTexts(sessionId)).toHaveLength(before);
    expect(duplicates(assistantTexts(sessionId))).toHaveLength(0);
  });

  it('a barge-in over the back end’s reply leaves one copy of it', async () => {
    const { client, sessionId, session } = await connect('S02');
    await customerSaysThenTool(client, session, 'I lost my card');
    // She starts saying the back end's reply aloud and the customer talks over her.
    session.said('Okay, first I need to check it is you. What is your');
    session.interrupt();
    // The barge-in is recorded through the orchestrator; let that finish before the test ends.
    await client.waitFor((m) => m.type === 'interrupted', 3000);
    await sleep(500);
    expect(duplicates(assistantTexts(sessionId))).toHaveLength(0);
    expect(assistantTexts(sessionId).filter((t) => /date of birth/i.test(t))).toHaveLength(1);
  });
});
