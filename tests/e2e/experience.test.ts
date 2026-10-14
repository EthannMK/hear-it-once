/** Hackathon experience layer: live timeline + SSE, tags, knowledge base, brief, free-talk, replay. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { setup, Caller } from './harness.ts';
import { get, run } from '../../src/db/db.ts';
import { setEnvForTests, env } from '../../src/config/env.ts';

let app: FastifyInstance;
const orig = env().ACTION_TIMEOUT_MS;
beforeEach(async () => {
  app = await setup();
  setEnvForTests({ ACTION_TIMEOUT_MS: 400 });
});
afterEach(async () => {
  setEnvForTests({ ACTION_TIMEOUT_MS: orig });
  await app.close();
});

async function timeline(c: Caller) {
  const r = await app.inject({ method: 'GET', url: `/api/calls/${c.sessionId}/timeline`, headers: { 'x-call-token': c.token } });
  return r.json().items as { id: number; type: string; stage: string; status: string; title: string; detail: string | null }[];
}

describe('live operations timeline', () => {
  it('records every stage of an unrecognised-charge call in order (S01)', async () => {
    const c = new Caller(app);
    await c.start('S01');
    await c.say("There's a charge from Novaplay for $249 that I didn't make");
    await c.verify('S01');
    await c.consent();
    await c.say('no');
    const t = await timeline(c);
    const types = t.map((e) => e.type);
    const order = ['call.initiated', 'disclosure.given', 'intent.identified', 'verification.started', 'call.tagged', 'verification.factor_passed', 'verification.passed', 'case.created', 'systems.queried', 'source.completed', 'systems.completed', 'kb.retrieved', 'facts.confirmed', 'eligibility.evaluated', 'actions.proposed', 'consent.given', 'action.submitted', 'action.succeeded', 'summary.generated'];
    let last = -1;
    for (const ty of order) {
      const i = types.indexOf(ty, last + 1);
      expect(i, `${ty} after index ${last}`).toBeGreaterThan(last);
      last = i;
    }
    expect(types.filter((x) => x === 'source.completed')).toHaveLength(6);
    expect(types.filter((x) => x === 'action.succeeded')).toHaveLength(3);
    // Nothing protected appears before verification passed.
    const vIdx = types.indexOf('verification.passed');
    // (The caller's own words — e.g. "$249", "Novaplay" — may appear; system records may not.)
    expect(t.slice(0, vIdx).map((e) => `${e.title} ${e.detail ?? ''}`).join(' ')).not.toMatch(/NOVAPLAY DIGITAL|1007|posted/);
  });

  it('a failed action shows as failed with a recovery path — never as confirmed (S13)', async () => {
    const c = new Caller(app);
    await c.start('S13');
    await c.say('My card was stolen');
    await c.verify('S13');
    await c.consent();
    const t = await timeline(c);
    const failed = t.find((e) => e.type === 'action.failed')!;
    expect(failed.status).toBe('failed');
    expect(failed.detail).toMatch(/Recovery/);
    expect(t.some((e) => e.type === 'action.succeeded')).toBe(false);
    expect(t.some((e) => e.type === 'handoff.prepared')).toBe(true);
  });

  it('streams events live over server-sent events', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const start = await (await fetch(`${base}/api/calls`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scenarioId: 'S02' }) })).json();
    const ac = new AbortController();
    const res = await fetch(`${base}/api/calls/${start.sessionId}/stream`, { headers: { 'x-call-token': start.callToken }, signal: ac.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const chunks: string[] = [];
    const readSome = async () => {
      const { value } = await reader.read();
      chunks.push(new TextDecoder().decode(value));
    };
    await readSome(); // history replay
    await fetch(`${base}/api/calls/${start.sessionId}/input`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-call-token': start.callToken }, body: JSON.stringify({ kind: 'utterance', text: 'I lost my credit card' }) });
    for (let i = 0; i < 5 && !chunks.join('').includes('intent.identified'); i++) await readSome();
    ac.abort();
    const all = chunks.join('');
    expect(all).toContain('event: timeline');
    expect(all).toContain('call.initiated');
    expect(all).toContain('intent.identified');
  });

  it('another caller cannot open the stream', async () => {
    const a = new Caller(app);
    await a.start('S01');
    const b = new Caller(app);
    await b.start('S02');
    const r = await app.inject({ method: 'GET', url: `/api/calls/${a.sessionId}/timeline`, headers: { 'x-call-token': b.token } });
    expect(r.statusCode).toBe(401);
  });
});

describe('tags, knowledge base and workflow stage', () => {
  it('tags evolve with the call; sentiment is indicative; urgency follows explicit rules', async () => {
    const c = new Caller(app);
    await c.start('S02');
    expect(c.view.workflow.stage).toBe('understand');
    await c.say("I lost my card and I'm really frustrated");
    expect(c.view.tags).toMatchObject({ intent: 'lost_stolen_card', urgency: 'elevated', identity: 'in_progress', sentiment: 'frustrated' });
    expect(c.view.tags.urgencyReason).toMatch(/rule/);
    expect(c.view.workflow.stage).toBe('verify');
    await c.verify('S02');
    expect(c.view.tags.identity).toBe('verified');
    expect(c.view.workflow.stage).toBe('confirm');
    await c.consent();
    await c.say('thanks, that is great');
    expect(c.view.tags.sentiment).toBe('reassured');
    const t = await timeline(c);
    expect(t.some((e) => e.type === 'tags.updated' && /sentiment: frustrated → reassured/.test(e.detail ?? ''))).toBe(true);
  });

  it('retrieves relevant synthetic guidance and records it on the call', async () => {
    const c = new Caller(app);
    await c.start('S05');
    await c.say('Why was I charged a late fee?');
    await c.verify('S05');
    const kb = c.view.knowledge;
    expect(kb[0]).toMatchObject({ id: 'KB-105', supportsNextStep: true, synthetic: true });
    expect(kb[0].reason).toMatch(/issue type/);
  });

  it('handoff after failed verification retrieves verification/handoff guidance for the agent', async () => {
    const c = new Caller(app);
    await c.start('S10');
    await c.say("There's a charge I don't recognise");
    for (const d of ['1990-01-01', '1990-01-02', '1990-01-03']) await c.say(d);
    const ids = c.view.knowledge.map((k: { id: string }) => k.id);
    expect(ids).toContain('KB-107');
    expect(c.view.knowledge.find((k: { id: string }) => k.id === 'KB-107').agentReview).toBe(true);
  });
});

describe('free-talk demo and replay', () => {
  it('binds a synthetic persona from the intent and shows its DOB only until verified', async () => {
    const c = new Caller(app);
    await c.start(undefined, { mode: 'free' });
    expect(c.view.persona).toBeNull();
    await c.say("I've lost my card. Can you block it?");
    expect(c.view.persona).toMatchObject({ scenarioId: 'S02', name: 'Priya Shah', dob: '1990-09-23', synthetic: true });
    await c.verify('S02');
    expect(c.view.persona.dob).toBeNull();
    expect(c.view.proposal.actions[0].type).toBe('block_card');
  });

  it('the judge example "$84.50" matches a seeded transaction directly', async () => {
    const c = new Caller(app);
    await c.start(undefined, { mode: 'free' });
    await c.say("I don't recognise a transaction for $84.50");
    await c.verify('S01');
    expect(c.view.proposal.actions.map((a: { type: string }) => a.type)).toEqual(['block_card', 'order_replacement', 'submit_dispute']);
    expect(c.lastAssistant()).toMatch(/CITYLINK RIDES/);
  });

  it('scenario reset restores fixtures so a judge can replay (S02)', async () => {
    const a = new Caller(app);
    await a.start('S02');
    await a.say('I lost my credit card');
    await a.verify('S02');
    await a.consent();
    expect(get<any>("SELECT status FROM bank_cards WHERE id = 'CRD-1002A'").status).toBe('blocked');
    const r = await app.inject({ method: 'POST', url: '/api/demo/scenarios/S02/reset', payload: {} });
    expect(r.statusCode).toBe(200);
    expect(get<any>("SELECT status FROM bank_cards WHERE id = 'CRD-1002A'").status).toBe('active');
    expect(get<any>("SELECT COUNT(*) n FROM call_sessions WHERE customer_id = 'CUS-1002'").n).toBe(0);
    // Audit history survives a replay reset.
    expect(get<any>("SELECT COUNT(*) n FROM audit_events WHERE event = 'demo.scenario_reset'").n).toBe(1);
    // Starting with resetScenario also replays cleanly.
    run("UPDATE bank_cards SET status = 'blocked' WHERE id = 'CRD-1002A'");
    const b = new Caller(app);
    await b.start('S02', { resetScenario: true });
    expect(get<any>("SELECT status FROM bank_cards WHERE id = 'CRD-1002A'").status).toBe('active');
  });

  it('reset is refused outside demo mode', async () => {
    setEnvForTests({ DEMO_MODE: false });
    try {
      expect((await app.inject({ method: 'POST', url: '/api/demo/scenarios/S02/reset', payload: {} })).statusCode).toBe(403);
    } finally {
      setEnvForTests({ DEMO_MODE: true });
    }
  });

  it('environment endpoint labels every connector honestly', async () => {
    const r = (await app.inject({ method: 'GET', url: '/api/demo/environment' })).json();
    expect(r.mode).toBe('demo');
    expect(r.connectors.filter((x: { status: string }) => x.status === 'configured')).toHaveLength(0);
    expect(r.connectors.find((x: { id: string }) => x.id === 'card_control').status).toBe('simulated');
  });
});

describe('resolution / agent brief', () => {
  it('reflects what actually happened and separates statements, facts, interpretations and unresolved items', async () => {
    const c = new Caller(app);
    await c.start('S16');
    await c.say("I didn't make the Lumen Travel charge for $412.50");
    await c.verify('S16');
    await c.consent();
    const b = (await app.inject({ method: 'GET', url: `/api/calls/${c.sessionId}/brief`, headers: { 'x-call-token': c.token } })).json();
    expect(b.customerSaid[0].text).toMatch(/Lumen Travel/);
    expect(b.verifiedFacts.join(' ')).toMatch(/LUMEN TRAVEL/);
    expect(b.interpretations[0].basis).toMatch(/not a verified fact/);
    const byType = Object.fromEntries(b.actions.map((a: { type: string; bucket: string }) => [a.type, a.bucket]));
    expect(byType).toEqual({ block_card: 'completed', order_replacement: 'completed', submit_dispute: 'pending' });
    expect(b.unresolved.join(' ')).toMatch(/dispute.*Pending/);
    expect(b.copyText).toMatch(/SIMULATED DEMO/);
    expect(b.copyText).not.toMatch(/Submit dispute: Succeeded/);
    expect(b.evidence[0].type).toBe('customer_statement');
    expect(b.timeline.length).toBeGreaterThan(15);
  });

  it('an escalated call reports the escalation, never a resolution (S08)', async () => {
    const c = new Caller(app);
    await c.start('S08');
    await c.say('I want to speak to a real person');
    const b = (await app.inject({ method: 'GET', url: `/api/calls/${c.sessionId}/brief`, headers: { 'x-call-token': c.token } })).json();
    expect(b.headline).toMatch(/waiting for an agent/);
    expect(b.escalation.reason).toBe('customer_requested');
    expect(b.verifiedFacts).toEqual([]);
  });
});

describe('operations overview', () => {
  it('shows active calls by stage, action outcomes and drill-down — staff only', async () => {
    const { staffLogin } = await import('./harness.ts');
    const a = new Caller(app);
    await a.start('S01');
    await a.say("There's a charge from Novaplay for $249 that I didn't make");
    await a.verify('S01');
    await a.consent();
    const b = new Caller(app);
    await b.start('S02');
    await b.say("I've lost my card");
    expect((await app.inject({ method: 'GET', url: '/api/ops/overview' })).statusCode).toBe(401);
    const cookie = await staffLogin(app, 'STF-QA-1');
    const o = (await app.inject({ method: 'GET', url: '/api/ops/overview', headers: { cookie } })).json();
    expect(o.label).toMatch(/synthetic/);
    expect(o.totals.active).toBeGreaterThanOrEqual(2);
    expect(o.stageDistribution.find((s: { stage: string }) => s.stage === 'verify').active).toBeGreaterThanOrEqual(1);
    expect(o.actionOutcomes.find((x: { status: string }) => x.status === 'succeeded').count).toBeGreaterThanOrEqual(3);
    const row = o.recent.find((r: { id: string }) => r.id === a.sessionId);
    expect(row.events).toBeGreaterThan(10);
    const tl = await app.inject({ method: 'GET', url: `/api/calls/${a.sessionId}/timeline`, headers: { cookie } });
    expect(tl.statusCode).toBe(200);
  });
});
