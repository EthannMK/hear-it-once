/** Northstar Bank: free conversation with a demo profile, card-number verification with retries, topic changes, handover and the agent workspace. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { setup, staffLogin, Caller } from './harness.ts';
import { all, get } from '../../src/db/db.ts';

let app: FastifyInstance;
beforeEach(async () => { app = await setup(); });
afterEach(async () => { await app.close(); });

async function customers() {
  return (await app.inject({ method: 'GET', url: '/api/demo/customers' })).json();
}
async function startProfile(id = 'alex-morgan') {
  const list = await customers();
  const profile = list.items.find((p: any) => p.id === id);
  const c = new Caller(app);
  await c.start(undefined, { channel: 'voice_browser', profileId: id });
  return { c, profile };
}
const wrongNumber = (n: string) => n.slice(0, -1) + String((Number(n.slice(-1)) + 1) % 10);
const digits = (s: string) => s.replace(/\D/g, '');
/** Reads the card number, then confirms the read-back, as a caller would. */
async function sayCard(c: Caller, n: string) { await c.say(n); await c.say('yes, that is correct'); }

async function handoffFor(c: Caller) {
  const h = get<{ id: string }>('SELECT id FROM handoffs WHERE session_id = ?', [c.sessionId]);
  return h!.id;
}

describe('demo data and free conversation', () => {
  it('lists Northstar Bank profiles with unmasked demo cards and a synthetic-data disclaimer', async () => {
    const j = await customers();
    expect(j.bank).toBe('Northstar Bank');
    expect(j.disclaimer).toMatch(/synthetic|dummy|fictional/i);
    for (const p of j.items) { expect(digits(p.cardNumber)).toHaveLength(16); expect(p.phone).toBeTruthy(); expect(p.accountRef).toBeTruthy(); }
  });

  it('answers a banking question with no scenario chosen, using the selected profile as server-side context', async () => {
    const { c, profile } = await startProfile();
    expect(c.session().profile_id).toBe('alex-morgan');
    expect(c.session().verification_mode).toBe('card_number');
    await c.say('I do not recognise a charge on my card');
    expect(c.view.transcript.some((t: any) => t.speaker !== 'customer')).toBe(true);
    await sayCard(c, profile.cardNumber);
    expect(c.session().verification_status).toBe('verified');
  });

  it('never reveals the expected card number in what the caller sees', async () => {
    const { c, profile } = await startProfile();
    await c.say('I do not recognise a charge on my card');
    await sayCard(c, wrongNumber(profile.cardNumber));
    expect(c.transcriptText()).not.toContain(digits(profile.cardNumber));
    expect(JSON.stringify(c.view)).not.toContain(digits(profile.cardNumber));
  });
});

describe('card-number verification', () => {
  it('wrong number fails with attempts remaining, then a correct retry verifies and context is kept', async () => {
    const { c, profile } = await startProfile();
    await c.say('I do not recognise a charge on my card');
    await sayCard(c, wrongNumber(profile.cardNumber));
    expect(c.session().verification_status).not.toBe('verified');
    expect(c.lastAssistant()).toMatch(/2/);
    await sayCard(c, profile.cardNumber);
    expect(c.session().verification_status).toBe('verified');
    const attempts = all<any>('SELECT outcome AS result FROM verification_attempts WHERE session_id = ? AND step = ? ORDER BY id', [c.sessionId, 'card']);
    expect(attempts.map((a) => a.result)).toEqual(['failed', 'passed']);
    expect(c.session().issue_type).toBeTruthy();
  });

  it('stops after three wrong numbers and prepares a human handover', async () => {
    const { c, profile } = await startProfile();
    await c.say('I do not recognise a charge on my card');
    const bad = wrongNumber(profile.cardNumber);
    await sayCard(c, bad); await sayCard(c, bad); await sayCard(c, bad);
    expect(c.session().verification_status).not.toBe('verified');
    const h = get<any>('SELECT * FROM handoffs WHERE session_id = ?', [c.sessionId]);
    expect(h).toBeTruthy();
    expect(['requested', 'queued']).toContain(h.status);
    const attempts = all<any>('SELECT outcome AS result FROM verification_attempts WHERE session_id = ? AND step = ?', [c.sessionId, 'card']);
    expect(attempts.length).toBe(3);
  });

  it('records each attempt in the activity timeline without any card number', async () => {
    const { c, profile } = await startProfile();
    await c.say('I do not recognise a charge on my card');
    await sayCard(c, wrongNumber(profile.cardNumber));
    await sayCard(c, profile.cardNumber);
    const tl = (await app.inject({ method: 'GET', url: `/api/calls/${c.sessionId}/timeline`, headers: { 'x-call-token': c.token } })).json();
    const types = JSON.stringify(tl);
    expect(types).toMatch(/verification\.retry/);
    expect(types).toMatch(/verification\.passed/);
    expect(types).not.toContain(digits(profile.cardNumber));
    const audit = JSON.stringify(all('SELECT * FROM audit_events WHERE session_id = ?', [c.sessionId]));
    expect(audit).not.toContain(digits(profile.cardNumber));
  });
});

describe('intent, lookups, KB and tags', () => {
  it('looks up the real transaction for the active customer and changes topic mid-call', async () => {
    const { c, profile } = await startProfile('alex-morgan');
    await c.say('I do not recognise a charge on my card');
    await sayCard(c, profile.cardNumber);
    expect(c.session().verification_status).toBe('verified');
    const first = c.session().issue_type;
    expect(first).toBeTruthy();
    const tx = profile.recentTransactions?.[0];
    expect(tx).toBeTruthy();
    // The choices offered come from the real ledger of the active customer, not a script.
    expect(JSON.stringify(c.view.choices)).toMatch(new RegExp(String(tx.merchant).slice(0, 5), 'i'));
    expect(c.view.tags.secondaryIntents).toHaveLength(0);
    await c.say('Actually I also want to ask about a late fee on my account');
    await c.refresh();
    expect(c.view.tags.intent).toBe(first);
    expect(c.view.tags.secondaryIntents.map((x: any) => x.intent)).toContain('fee_query');
  });

  it('retrieves a relevant knowledge-base article for the issue', async () => {
    const { c, profile } = await startProfile('jamie-tan');
    await c.say('my card payment was declined');
    await sayCard(c, profile.cardNumber);
    expect(c.view.knowledge.length).toBeGreaterThan(0);
  });
});

describe('handover and agent workspace', () => {
  async function waitingCase() {
    const { c, profile } = await startProfile('alex-morgan');
    await c.say('I do not recognise a charge on my card');
    await sayCard(c, wrongNumber(profile.cardNumber));
    await c.say('I want to speak to a human agent');
    const hid = await handoffFor(c);
    const cookie = await staffLogin(app, 'STF-AGENT-1');
    return { c, profile, hid, cookie };
  }

  it('builds the handover summary from the real transcript and events, labelled as an AI recommendation', async () => {
    const { hid, cookie, profile } = await waitingCase();
    const w = (await app.inject({ method: 'GET', url: `/api/handoffs/${hid}/workspace`, headers: { cookie } })).json();
    expect(w.handoff.phase).toBe('waiting');
    expect(w.customer.cardNumber).toBe(profile.cardNumber);
    expect(w.verification.attempts.length).toBeGreaterThanOrEqual(1);
    expect(w.transcript.length).toBeGreaterThan(2);
    expect(w.suggestion.status).toBe('ai_recommendation');
    expect(w.suggestion.notice).toMatch(/not a confirmed action|recommendation/i);
    expect(w.knowledge.length).toBeGreaterThan(0);
    expect(JSON.stringify(w.knowledge)).toMatch(/demo policy/i);
    expect(JSON.stringify(w.transcript)).not.toContain(digits(profile.cardNumber));
  });

  it('prefills the CRM search without the card number, lets the agent edit it, and returns matching records', async () => {
    const { c, hid, cookie, profile } = await waitingCase();
    const w = (await app.inject({ method: 'GET', url: `/api/handoffs/${hid}/workspace`, headers: { cookie } })).json();
    expect(w.crm.query).toContain(profile.name);
    expect(digits(w.crm.query)).not.toContain(digits(profile.cardNumber));
    const r = (await app.inject({ method: 'GET', url: `/api/crm/search?q=${encodeURIComponent(profile.name)}&sessionId=${c.sessionId}`, headers: { cookie } })).json();
    expect(JSON.stringify(r)).toContain(profile.name);
    const bad = await app.inject({ method: 'GET', url: `/api/crm/search?q=${encodeURIComponent(profile.cardNumber)}`, headers: { cookie } });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
    const audit = JSON.stringify(all('SELECT * FROM audit_events WHERE event LIKE ?', ['agent.crm%']));
    expect(audit).not.toContain(digits(profile.cardNumber));
  });

  it('requires acceptance before edits, then saves validated edits with audit events', async () => {
    const { hid, cookie } = await waitingCase();
    const patch = (payload: unknown) => app.inject({ method: 'PATCH', url: `/api/handoffs/${hid}/workspace`, headers: { cookie }, payload: payload as any });
    expect((await patch({ notes: 'too early' })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `/api/handoffs/${hid}/accept`, headers: { cookie }, payload: {} })).statusCode).toBe(200);
    expect((await patch({ tags: ['x'.repeat(80)] })).statusCode).toBe(400);
    expect((await patch({ bogus: 1 })).statusCode).toBe(400);
    const ok = await patch({ tags: ['Disputed charge', 'Priority'], reasonSummary: 'Customer disputes a charge.', suggestion: 'Raise a dispute review.', notes: 'Called back.', resolution: 'Dispute raised (demo).', nextSteps: 'Follow up in 3 days.' });
    expect(ok.statusCode).toBe(200);
    const w = (await app.inject({ method: 'GET', url: `/api/handoffs/${hid}/workspace`, headers: { cookie } })).json();
    expect(w.handoff.phase).toBe('accepted');
    expect(w.tags.agent).toEqual(['Disputed charge', 'Priority']);
    expect(w.reason.effective).toContain('disputes a charge');
    expect(w.suggestion.override).toBe('Raise a dispute review.');
    expect(w.notes).toBe('Called back.');
    const events = all<{ event: string }>("SELECT event FROM audit_events WHERE event LIKE 'agent.workspace.%'").map((e) => e.event);
    for (const e of ['tags_edited', 'reason_summary_edited', 'suggestion_edited', 'notes_edited', 'resolution_recorded', 'next_steps_recorded']) expect(events).toContain(`agent.workspace.${e}`);
  });

  it('shows the customer when the agent accepts and marks the case completed', async () => {
    const { c, hid, cookie } = await waitingCase();
    expect((await c.refresh()).handoff?.status ?? 'waiting').not.toBe('connected');
    await app.inject({ method: 'POST', url: `/api/handoffs/${hid}/accept`, headers: { cookie }, payload: {} });
    expect((await c.refresh()).handoff.status).toBe('connected');
    const done = await app.inject({ method: 'POST', url: `/api/handoffs/${hid}/complete`, headers: { cookie }, payload: { outcome: 'resolved', notes: 'Done', customerRepeatedIssue: false } });
    expect(done.statusCode).toBe(200);
    const w = (await app.inject({ method: 'GET', url: `/api/handoffs/${hid}/workspace`, headers: { cookie } })).json();
    expect(w.handoff.phase).toBe('completed');
  });
});

describe('real-time delivery to the agent console', () => {
  it('pushes the new case over the staff event stream without a refresh', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const cookie = await staffLogin(app, 'STF-AGENT-1');
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/handoffs/stream`, { headers: { cookie }, signal: ac.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    let seen = '';
    const pump = (async () => { const dec = new TextDecoder(); try { for (;;) { const { value, done } = await reader.read(); if (done) break; seen += dec.decode(value); } } catch { /* aborted */ } })();
    const { c } = await startProfile();
    await c.say('I want to speak to a human agent');
    await new Promise((r) => setTimeout(r, 400));
    ac.abort(); await pump;
    expect(seen).toMatch(/event: handoff/);
    expect(seen).toMatch(/handoff\.(requested|queued|created)/);
  });
});

describe('seeded history', () => {
  it('opens the workspace for a seeded historical handover without crashing', async () => {
    await app.close();
    app = await setup({ history: true });
    const cookie = await staffLogin(app, 'STF-AGENT-1');
    const list = (await app.inject({ method: 'GET', url: '/api/handoffs', headers: { cookie } })).json().items;
    expect(list.length).toBeGreaterThan(0);
    for (const i of list.slice(0, 40)) {
      const r = await app.inject({ method: 'GET', url: `/api/handoffs/${i.id}/workspace`, headers: { cookie } });
      expect(r.statusCode, i.id).toBe(200);
    }
  });
});

describe('understanding natural phrasing', () => {
  it('maps "a recent online charge that may look unfamiliar" to an unrecognised transaction without asking to repeat', async () => {
    const { c } = await startProfile();
    await c.say('So, I had a recent online charge that may look unfamiliar.');
    expect(c.session().issue_type).toBe('unrecognised_transaction');
    expect(c.lastAssistant()).toMatch(/card number/i);
  });

  it('asks Gemini only when the rules are unsure, and falls back to the rules if it fails', async () => {
    const { HybridIntentModel } = await import('../../src/ai/intent-gemini.ts');
    const { RulesIntentModel } = await import('../../src/ai/intent.ts');
    const llm = { name: 'fake', classify: async () => ({ issueType: 'fee_query' as const, confidence: 0.9, alternatives: [], unsupportedTopic: null, slots: {} as any, model: 'fake' }) };
    const hybrid = new HybridIntentModel(new RulesIntentModel(), llm);
    expect((await hybrid.classify('what is this thing on my statement')).issueType).toBe('fee_query');
    expect((await hybrid.classify('I lost my card')).model).toBe('rules-v1');
    const broken = new HybridIntentModel(new RulesIntentModel(), { name: 'x', classify: async () => { throw new Error('down'); } });
    expect((await broken.classify('what is this thing on my statement')).issueType).toBeNull();
  });
});

describe('agent view for judges (screen 2)', () => {
  it('the caller who made the call can open the agent view read-only; another caller cannot; staff can', async () => {
    const { setup: s2, Caller: C2, staffLogin: sl } = await import('./harness.ts');
    const app2 = await s2();
    const a = new C2(app2);
    await a.start(undefined, { profileId: 'alex-morgan', channel: 'voice_browser' });
    await a.say('I want to speak to a person');
    await a.input({ kind: 'hangup' });
    const own = await app2.inject({ method: 'GET', url: `/api/calls/${a.sessionId}/agent-view`, headers: { 'x-call-token': a.token } });
    expect(own.statusCode).toBe(200);
    const w = own.json();
    expect(w.readOnly).toBe(true);
    expect(w.customer.name).toBe('Alex Morgan');
    expect(w.suggestion.status).toBe('ai_recommendation');
    expect(w.handoff.reason).toBe('customer_requested');
    expect(w.transcript.length).toBeGreaterThan(2);
    const b = new C2(app2);
    await b.start(undefined, { profileId: 'alex-morgan' });
    expect((await app2.inject({ method: 'GET', url: `/api/calls/${a.sessionId}/agent-view`, headers: { 'x-call-token': b.token } })).statusCode).toBe(401);
    const cookie = await sl(app2, 'STF-AGENT-1');
    const staff = await app2.inject({ method: 'GET', url: `/api/calls/${a.sessionId}/agent-view`, headers: { cookie } });
    expect(staff.json().readOnly).toBe(false);
    // A call Lily handled without any handover still has an agent view.
    const c = new C2(app2);
    await c.start(undefined, { profileId: 'alex-morgan' });
    await c.input({ kind: 'hangup' });
    const v = (await app2.inject({ method: 'GET', url: `/api/calls/${c.sessionId}/agent-view`, headers: { 'x-call-token': c.token } })).json();
    expect(v.handoff).toBeNull();
    expect(v.aiSummary).toMatch(/without a handover/);
    await app2.close();
  });
});
