/**
 * THE OFF SWITCH.
 *
 * What is being proved here is not that a flag can be set. It is that with the switch thrown the
 * assistant cannot change an account by any route, including the one that normally works, and that
 * the caller is passed to a person rather than left talking to something that has been stopped.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { setup, Caller, staffLogin } from './harness.ts';
import { safetyState, setSafetyMode, assistantMayAct, assistantMayHandleCalls } from '../../src/safety/control.ts';
import { authorizeAction } from '../../src/policy/engine.ts';
import { SYSTEM } from '../../src/audit/audit.ts';
import { verifyAuditChain } from '../../src/audit/chain.ts';
import { all, get, run } from '../../src/db/db.ts';

const ADMIN = { type: 'admin' as const, id: 'STF-ADMIN-1' };

let app: FastifyInstance;
beforeEach(async () => { app = await setup(); });
afterEach(async () => { await app.close(); });

/** A fee call taken to the point where the assistant is about to offer to reverse the fee. */
async function upToTheOffer(c: Caller) {
  await c.start('S05');
  await c.say('Why was I charged a late fee?');
  await c.verify('S05');
  await c.refresh();
}

describe('the switch itself', () => {
  it('starts in the normal position', () => {
    expect(safetyState().mode).toBe('normal');
    expect(assistantMayAct()).toBe(true);
    expect(assistantMayHandleCalls()).toBe(true);
  });

  it('records who threw it, when and why', () => {
    setSafetyMode('assistant_off', 'Lily quoted a balance that was wrong on two calls', ADMIN);
    const s = safetyState();
    expect(s.mode).toBe('assistant_off');
    expect(s.reason).toMatch(/balance that was wrong/);
    expect(s.changedBy).toBe('STF-ADMIN-1');
    expect(s.changedAt).toBeTruthy();
  });

  it('writes an audit row that the chain covers', () => {
    setSafetyMode('actions_paused', 'checking a dispute rule with fraud ops', ADMIN);
    const row = get<{ event: string; metadata_json: string }>("SELECT event, metadata_json FROM audit_events WHERE event LIKE 'safety.%' ORDER BY id DESC LIMIT 1");
    expect(row?.event).toBe('safety.switch_thrown');
    expect(row?.metadata_json).toMatch(/actions_paused/);
    expect(verifyAuditChain().ok).toBe(true);
  });

  it('can be put back, and that is recorded too', () => {
    setSafetyMode('assistant_off', 'incident 4412', ADMIN);
    setSafetyMode('normal', 'incident 4412 closed, fix deployed', ADMIN);
    expect(safetyState().mode).toBe('normal');
    expect(get("SELECT 1 FROM audit_events WHERE event = 'safety.switch_cleared'")).toBeTruthy();
  });

  it('fails to off, not to on, when its own setting is unreadable', () => {
    run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('safety_mode', 'not json')");
    const s = safetyState();
    expect(s.mode).toBe('assistant_off');
    expect(s.degraded).toBe(true);
  });

  it('refuses a position it does not recognise, rather than guessing', () => {
    run(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('safety_mode', '{"mode":"mostly_on"}')`);
    expect(safetyState().mode).toBe('assistant_off');
  });
});

describe('with actions paused', () => {
  beforeEach(() => setSafetyMode('actions_paused', 'fee rules under review', ADMIN));

  it('the assistant passes the call to a person instead of offering the action', async () => {
    const c = new Caller(app);
    await upToTheOffer(c);
    expect(c.view.proposal ?? null).toBeNull();
    expect(c.session().outcome).toBe('handed_off');
    expect(c.lastAssistant()).toMatch(/not able to make changes|put you through/i);
  });

  it('nothing is executed, and nothing is left half-done', async () => {
    const c = new Caller(app);
    await upToTheOffer(c);
    expect(c.ops()).toHaveLength(0);
    expect(all("SELECT id FROM proposals WHERE session_id = ?", [c.sessionId])).toHaveLength(0);
  });

  it('the case says what the assistant would have done, so the agent does not start cold', async () => {
    const c = new Caller(app);
    await upToTheOffer(c);
    const ev = all<{ event_type: string; detail_json: string }>('SELECT event_type, detail_json FROM case_events WHERE case_id = ?', [c.caseRow().id as string]);
    const paused = ev.find((e) => e.event_type === 'actions_paused');
    expect(paused).toBeTruthy();
    expect(paused!.detail_json).toMatch(/reverse_fee/);
  });

  it('the policy engine refuses the action even when asked directly', () => {
    const d = authorizeAction({
      type: 'block_card', sessionId: 'SES-WHATEVER', caseId: null, customerId: 'CUS-1001', targetRef: 'CARD-1',
      params: {}, consentId: null, snapshotId: null, actor: { type: 'customer_session', id: 'SES-WHATEVER' },
    });
    expect(d.allowed).toBe(false);
    const check = d.checks.find((x) => x.check === 'assistant_enabled');
    expect(check?.passed).toBe(false);
    expect(check?.detail).toMatch(/fee rules under review/);
  });

  it('the refusal comes before any eligibility rule is read', () => {
    const d = authorizeAction({
      type: 'reverse_fee', sessionId: 'SES-WHATEVER', caseId: null, customerId: 'CUS-1001', targetRef: 'FEE-1',
      params: {}, consentId: null, snapshotId: null, actor: { type: 'customer_session', id: 'SES-WHATEVER' },
    });
    expect(d.checks[0].check).toBe('assistant_enabled');
    expect(d.eligibility).toBeNull();
  });

  it('a member of staff is not stopped: the switch is for the assistant, not the bank', () => {
    const d = authorizeAction({
      type: 'block_card', sessionId: 'SES-WHATEVER', caseId: null, customerId: 'CUS-1001', targetRef: 'CARD-1',
      params: {}, consentId: null, snapshotId: null, actor: { type: 'agent', id: 'STF-AGENT-1' },
    });
    expect(d.checks.some((x) => x.check === 'assistant_enabled')).toBe(false);
  });

  it('the assistant still answers questions, which is the point of pausing rather than stopping', async () => {
    const c = new Caller(app);
    await c.start('S05');
    await c.say('What are your opening hours?');
    expect(c.lastAssistant().length).toBeGreaterThan(20);
    expect(c.session().outcome).not.toBe('handed_off');
  });
});

describe('with the assistant switched off', () => {
  beforeEach(() => setSafetyMode('assistant_off', 'incident 4412: wrong balances quoted', ADMIN));

  it('a new caller goes straight to a person, and is not asked anything first', async () => {
    const c = new Caller(app);
    await c.start('S05');
    expect(c.session().outcome).toBe('handed_off');
    expect(c.transcriptText()).toMatch(/isn’t taking calls|putting you straight/i);
    expect(c.transcriptText()).not.toMatch(/what can I help|how can I help/i);
  });

  it('says nothing about why to the customer: the reason is for staff', async () => {
    const c = new Caller(app);
    await c.start('S05');
    expect(c.transcriptText()).not.toMatch(/incident 4412|wrong balances/i);
    const tl = all<{ detail: string | null }>('SELECT detail FROM timeline_events WHERE session_id = ?', [c.sessionId]);
    expect(tl.some((e) => /incident 4412/.test(e.detail ?? ''))).toBe(true);
  });

  it('a caller who says something still gets a person, not an answer', async () => {
    const c = new Caller(app);
    await c.start('S05');
    await c.say('I think there is a fraudulent charge on my card');
    expect(c.ops()).toHaveLength(0);
    expect(c.session().outcome).toBe('handed_off');
  });

  it('a call that was already running is passed over on the next thing the caller says', async () => {
    setSafetyMode('normal', 'back to normal for this test', ADMIN);
    const c = new Caller(app);
    await c.start('S05');
    await c.say('Why was I charged a late fee?');
    expect(c.session().outcome).not.toBe('handed_off');
    setSafetyMode('assistant_off', 'thrown mid-call', ADMIN);
    await c.say('my date of birth is 1990-01-01');
    expect(c.session().outcome).toBe('handed_off');
    expect(c.lastAssistant()).toMatch(/isn’t taking calls|one of our team/i);
  });

  it('hanging up still hangs up', async () => {
    const c = new Caller(app);
    await c.start('S05');
    await c.input({ kind: 'hangup' });
    expect(c.session().ended_at).toBeTruthy();
  });

  it('a voice call is handed over on the way in too, before any microphone is opened', async () => {
    const c = new Caller(app);
    await c.start('S05', { channel: 'voice_browser' });
    expect(c.session().outcome).toBe('handed_off');
    expect(assistantMayHandleCalls()).toBe(false);
  });

  it('the log of the whole episode still verifies', async () => {
    const c = new Caller(app);
    await c.start('S05');
    await c.say('hello?');
    expect(verifyAuditChain().ok).toBe(true);
  });
});

describe('who may throw it', () => {
  it('an agent may not', async () => {
    const cookie = await staffLogin(app, 'STF-AGENT-1');
    const r = await app.inject({ method: 'PUT', url: '/api/safety', headers: { cookie }, payload: { mode: 'assistant_off', reason: 'trying it on' } });
    expect(r.statusCode).toBe(403);
    expect(safetyState().mode).toBe('normal');
  });

  it('nobody signed in may', async () => {
    const r = await app.inject({ method: 'PUT', url: '/api/safety', payload: { mode: 'assistant_off', reason: 'anonymous' } });
    expect([401, 403]).toContain(r.statusCode);
  });

  it('an administrator may, and the reason is required', async () => {
    const cookie = await staffLogin(app, 'STF-ADMIN-1');
    const bad = await app.inject({ method: 'PUT', url: '/api/safety', headers: { cookie }, payload: { mode: 'assistant_off' } });
    expect(bad.statusCode).toBe(400);

    const ok = await app.inject({ method: 'PUT', url: '/api/safety', headers: { cookie }, payload: { mode: 'assistant_off', reason: 'incident 4412' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().mode).toBe('assistant_off');
    expect(ok.json().description).toMatch(/not taking calls/);
    expect(safetyState().mode).toBe('assistant_off');
  });

  it('operations can read the position and is told it may change it', async () => {
    const cookie = await staffLogin(app, 'STF-QA-1');
    const r = await app.inject({ method: 'GET', url: '/api/safety', headers: { cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.json().mode).toBe('normal');
    expect(r.json().mayChange).toBe(true);
  });

  it('a position the API does not recognise is refused', async () => {
    const cookie = await staffLogin(app, 'STF-ADMIN-1');
    const r = await app.inject({ method: 'PUT', url: '/api/safety', headers: { cookie }, payload: { mode: 'sort_of_off', reason: 'nonsense' } });
    expect(r.statusCode).toBe(400);
  });
});
