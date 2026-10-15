/**
 * Integration tests for the action service, policy engine, retrieval engine, verification
 * state machine and handoff service, driven below the HTTP layer.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { setup, Caller, staffLogin } from '../e2e/harness.ts';
import { all, get, run } from '../../src/db/db.ts';
import { setEnvForTests, env } from '../../src/config/env.ts';
import { buildPolicy, setPolicyForTests, policy } from '../../src/config/policy.ts';
import { retrieveFacts, breakers } from '../../src/retrieval/retrieval.ts';
import { setFault } from '../../src/adapters/mock/faults.ts';
import { mockRegistry, setAdapters } from '../../src/adapters/registry.ts';
import { reconcile, retryAction, getOp, prepareAction, confirmAndExecute } from '../../src/actions/action-service.ts';
import { authorizeAction } from '../../src/policy/engine.ts';
import { setLogSink, setLogLevel, log } from '../../src/lib/logger.ts';
import { freezeClock, resetClock, advanceClock } from '../../src/lib/clock.ts';

let app: FastifyInstance;
const orig = { t: env().ACTION_TIMEOUT_MS, a: env().ADAPTER_TIMEOUT_MS };
beforeEach(async () => {
  app = await setup();
  breakers.reset();
  setEnvForTests({ ACTION_TIMEOUT_MS: 300, ADAPTER_TIMEOUT_MS: 300 });
});
afterEach(async () => {
  setEnvForTests({ ACTION_TIMEOUT_MS: orig.t, ADAPTER_TIMEOUT_MS: orig.a });
  setPolicyForTests(null);
  setAdapters(null);
  resetClock();
  await app.close();
});

async function verifiedCaller(scenario: string, text: string) {
  const c = new Caller(app);
  await c.start(scenario);
  await c.say(text);
  await c.verify(scenario);
  return c;
}

describe('parallel retrieval', () => {
  it('reads sources concurrently (wall time well below the sum of source latencies)', async () => {
    const sid = (await new Caller(app).start('S01')).session.id;
    run("UPDATE call_sessions SET customer_id = 'CUS-1001', verification_status = 'verified' WHERE id = ?", [sid]);
    // Make every adapter take ~100 ms.
    const slow = <T>(fn: () => Promise<T>) => new Promise<T>((r) => setTimeout(() => r(fn()), 100));
    const r = mockRegistry.readers;
    setAdapters({
      ...mockRegistry,
      readers: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([m, f]) => [m, (...a: unknown[]) => slow(() => (f as (...x: unknown[]) => Promise<unknown>)(...a))]))])) as unknown as typeof r,
    });
    const snap = await retrieveFacts({ sessionId: sid, correlationId: 'c', scenarioId: null, customerId: 'CUS-1001', issueType: 'unrecognised_transaction' });
    expect(Object.keys(snap.sources)).toHaveLength(6);
    expect(snap.sumSourceMs).toBeGreaterThanOrEqual(550);
    expect(snap.wallMs).toBeLessThan(350);
    expect(all('SELECT * FROM integration_calls WHERE snapshot_id = ?', [snap.id])).toHaveLength(6);
  });
  it('handles partial failure: timeouts, stale data and an open circuit are recorded per source', async () => {
    const sid = (await new Caller(app).start()).session.id;
    setFault({ scope: 'customer', scopeRef: 'CUS-1001', target: 'fraud_alerts', fault: 'timeout', enabled: true });
    setFault({ scope: 'customer', scopeRef: 'CUS-1001', target: 'card_status', fault: 'stale', enabled: true });
    setFault({ scope: 'customer', scopeRef: 'CUS-1001', target: 'prior_cases', fault: 'error', enabled: true });
    const snap = await retrieveFacts({ sessionId: sid, correlationId: 'c', scenarioId: null, customerId: 'CUS-1001', issueType: 'unrecognised_transaction' });
    expect(snap.sources.fraud_alerts!.status).toBe('timeout');
    expect(snap.sources.card_status!.stale).toBe(true);
    expect(snap.sources.prior_cases!.status).toBe('error');
    expect(snap.sources.transactions!.status).toBe('ok');
    // Third failing call trips the breaker for this (mock-scoped) source.
    await retrieveFacts({ sessionId: sid, correlationId: 'c', scenarioId: null, customerId: 'CUS-1001', issueType: 'unrecognised_transaction' });
    const third = await retrieveFacts({ sessionId: sid, correlationId: 'c', scenarioId: null, customerId: 'CUS-1001', issueType: 'unrecognised_transaction' });
    expect(third.sources.prior_cases!.status).toBe('circuit_open');
    // Other customers are unaffected by a customer-scoped fault.
    const other = await retrieveFacts({ sessionId: sid, correlationId: 'c', scenarioId: null, customerId: 'CUS-1002', issueType: 'unrecognised_transaction' });
    expect(other.sources.prior_cases!.status).toBe('ok');
  });
  it('stale required data blocks a sensitive write', async () => {
    setFault({ scope: 'customer', scopeRef: 'CUS-1002', target: 'card_status', fault: 'stale', enabled: true });
    const c = await verifiedCaller('S02', 'I lost my credit card');
    expect(c.ops()).toHaveLength(0);
    expect(get<any>('SELECT reason FROM handoffs WHERE session_id = ?', [c.sessionId]).reason).toBe('system_unavailable');
    expect(get<any>("SELECT status FROM bank_cards WHERE id = 'CRD-1002A'").status).toBe('active');
  });
});

describe('action service safety', () => {
  it('consent from a different session cannot authorise an action', async () => {
    const a = await verifiedCaller('S05', 'Why was I charged a late fee?');
    const b = await verifiedCaller('S18', 'Please waive my late fee');
    await b.consent();
    const consentB = get<any>('SELECT id FROM consents WHERE session_id = ?', [b.sessionId]).id;
    const fee = get<any>("SELECT id FROM bank_fees WHERE customer_id = 'CUS-1005' AND reversed_at IS NULL").id;
    const r = await app.inject({ method: 'POST', url: `/api/calls/${a.sessionId}/actions`, headers: { 'x-call-token': a.token, 'idempotency-key': 'cross-sess-1' }, payload: { type: 'reverse_fee', targetRef: fee, params: { ruleCode: 'FP-LATE-01' }, consentId: consentB } });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('CONSENT_REQUIRED');
  });
  it('an action on another customer\'s card is refused even with a valid session', async () => {
    const c = await verifiedCaller('S02', 'I lost my credit card');
    const d = authorizeAction({ type: 'block_card', sessionId: c.sessionId, caseId: null, customerId: 'CUS-1002', targetRef: 'CRD-1001A', params: { reason: 'lost' }, consentId: null, snapshotId: get<any>('SELECT id FROM retrieval_snapshots WHERE session_id = ?', [c.sessionId]).id, actor: { type: 'customer_session', id: c.sessionId } });
    expect(d.allowed).toBe(false);
    expect(d.checks.find((x) => x.check === 'card_owned')?.passed).toBe(false);
  });
  it('expired consent is rejected at execution time', async () => {
    const c = await verifiedCaller('S05', 'Why was I charged a late fee?');
    const op = c.ops()[0];
    // Accept but expire the consent before execution by inserting it manually and advancing time.
    const pid = c.view.proposal.id;
    run("UPDATE proposals SET status = 'accepted' WHERE id = ?", [pid]);
    run("INSERT INTO consents (id, proposal_id, session_id, decision, captured_via, expires_at, created_at) VALUES ('CNS-EXPIRED01', ?, ?, 'accepted', 'test', ?, ?)", [pid, c.sessionId, new Date(Date.now() - 1000).toISOString(), new Date().toISOString()]);
    const r = await confirmAndExecute(op.id, 'CNS-EXPIRED01', { type: 'customer_session', id: c.sessionId }, 'c');
    expect(r.status).toBe('rejected');
    expect(r.error_code).toBe('CONSENT_REQUIRED');
    expect(get<any>("SELECT reversed_at FROM bank_fees WHERE id = ?", [op.target_ref]).reversed_at).toBeNull();
  });
  it('reconciliation of a never-received request permits exactly one safe retry', async () => {
    const c = await verifiedCaller('S02', 'I lost my credit card');
    // Simulate: we timed out, and the downstream never received it.
    const op = c.ops()[0];
    run("UPDATE action_operations SET status = 'unknown', attempts = 1, consent_id = NULL WHERE id = ?", [op.id]);
    run("UPDATE proposals SET status = 'accepted' WHERE id = ?", [c.view.proposal.id]);
    run("INSERT INTO consents (id, proposal_id, session_id, decision, captured_via, expires_at, created_at) VALUES ('CNS-OK0000001', ?, ?, 'accepted', 'test', ?, ?)", [c.view.proposal.id, c.sessionId, new Date(Date.now() + 600_000).toISOString(), new Date().toISOString()]);
    run("UPDATE action_operations SET consent_id = 'CNS-OK0000001' WHERE id = ?", [op.id]);
    const actor = { type: 'customer_session' as const, id: c.sessionId };
    await expect(retryAction(op.id, actor, 'c')).rejects.toThrow(/Reconcile/);
    const rec = await reconcile(op.id, actor, 'c');
    expect(rec).toMatchObject({ status: 'failed', error_code: 'NOT_RECEIVED' });
    const retried = await retryAction(op.id, actor, 'c');
    expect(retried.status).toBe('succeeded');
    expect(retried.attempts).toBe(2);
    expect(get<any>("SELECT status FROM bank_cards WHERE id = 'CRD-1002A'").status).toBe('blocked');
    await expect(retryAction(op.id, actor, 'c')).rejects.toThrow(/cannot be retried/);
  });
  it('downstream unavailable before submission → failed, never "succeeded", and retryable', async () => {
    setFault({ scope: 'customer', scopeRef: 'CUS-1002', target: 'card_control', fault: 'unavailable', enabled: true });
    const c = await verifiedCaller('S02', 'I lost my credit card');
    await c.consent();
    expect(c.ops()[0]).toMatchObject({ status: 'failed', error_code: 'DOWNSTREAM_UNAVAILABLE' });
    expect(c.lastAssistant()).toMatch(/NOT blocked/);
  });
  it('pilot-conservative profile holds consequential actions for human approval; agent approval executes', async () => {
    setPolicyForTests(buildPolicy('pilot-conservative'));
    const c = await verifiedCaller('S05', 'Why was I charged a late fee?');
    await c.consent();
    const op = c.ops()[0];
    expect(op.status).toBe('awaiting_approval');
    expect(get<any>('SELECT reversed_at FROM bank_fees WHERE id = ?', [op.target_ref]).reversed_at).toBeNull();
    expect(get<any>('SELECT reason FROM handoffs WHERE session_id = ?', [c.sessionId]).reason).toBe('approval_required');
    const qa = await staffLogin(app, 'STF-QA-1');
    expect((await app.inject({ method: 'POST', url: `/api/actions/${op.id}/approve`, headers: { cookie: qa }, payload: {} })).statusCode).toBe(403);
    const agent = await staffLogin(app, 'STF-AGENT-1');
    const r = await app.inject({ method: 'POST', url: `/api/actions/${op.id}/approve`, headers: { cookie: agent }, payload: {} });
    expect(r.statusCode).toBe(200);
    expect(getOp(op.id)).toMatchObject({ status: 'succeeded', approved_by: 'STF-AGENT-1' });
  });
  it('non-mock adapter mode forces the conservative profile', () => {
    setPolicyForTests(null);
    setEnvForTests({ ADAPTER_MODE: 'bank-sandbox' });
    try {
      expect(policy().profile).toBe('pilot-conservative');
      expect(policy().actions.block_card.requiresHumanApproval).toBe(true);
    } finally {
      setEnvForTests({ ADAPTER_MODE: 'mock' });
      setPolicyForTests(null);
    }
  });
  it('invalid parameters are rejected by schema before anything is created', async () => {
    const c = await verifiedCaller('S02', 'I lost my credit card');
    const r = await app.inject({ method: 'POST', url: `/api/calls/${c.sessionId}/actions`, headers: { 'x-call-token': c.token, 'idempotency-key': 'bad-params-1' }, payload: { type: 'block_card', targetRef: 'CRD-1002A', params: { reason: 'because', extra: 1 } } });
    expect(r.statusCode).toBe(400);
    expect(get<any>("SELECT COUNT(*) n FROM action_operations WHERE idempotency_key = 'api:bad-params-1'").n).toBe(0);
  });
});

describe('verification state machine', () => {
  it('OTP must be correct; 3 wrong codes lock; voice/name/phone alone never verify', async () => {
    const c = new Caller(app);
    await c.start('S05');
    await c.say("Hi it's Tom Becker calling from my registered phone, why was I charged a late fee?");
    expect(c.session().verification_status).not.toBe('verified');
    await c.say('1975-06-18');
    expect(c.view.demoDevice.code).toMatch(/^\d{6}$/);
    for (const code of ['000000', '111111', '222222']) await c.say(code);
    expect(c.session().verification_status).toBe('failed');
    expect(get<any>("SELECT COUNT(*) n FROM verification_attempts WHERE session_id = ? AND outcome = 'locked'", [c.sessionId]).n).toBe(1);
    // No raw answer stored anywhere.
    expect(JSON.stringify(all('SELECT * FROM verification_attempts WHERE session_id = ?', [c.sessionId]))).not.toMatch(/1975|000000/);
  });
  it('unknown caller ID asks for the card number first', async () => {
    const c = new Caller(app);
    await c.start(undefined, { callerAni: '+1 555 999 0000' });
    await c.say('I lost my card');
    expect(c.lastAssistant()).toMatch(/16-digit card number/);
  });
  it('another caller token cannot read or drive the call', async () => {
    const c = new Caller(app);
    await c.start('S01');
    const other = new Caller(app);
    await other.start('S02');
    const r = await app.inject({ method: 'POST', url: `/api/calls/${c.sessionId}/input`, headers: { 'x-call-token': other.token }, payload: { kind: 'utterance', text: 'hi' } });
    expect(r.statusCode).toBe(403);
    const g = await app.inject({ method: 'GET', url: `/api/calls/${c.sessionId}`, headers: { 'x-call-token': other.token } });
    expect(g.statusCode).toBe(401);
  });
});

describe('handoff', () => {
  it('no agent available → callback fallback; never claims a transfer', async () => {
    run("INSERT INTO app_settings (key, value) VALUES ('agents_available', 'false')");
    const c = new Caller(app);
    await c.start('S08');
    await c.say('agent please');
    const h = get<any>('SELECT status, fallback FROM handoffs WHERE session_id = ?', [c.sessionId]);
    expect(h).toMatchObject({ status: 'no_agent', fallback: 'callback_requested' });
    expect(c.lastAssistant()).toMatch(/no agents are available/);
    expect(c.lastAssistant()).not.toMatch(/transferring you/);
    expect(c.session().outcome).toBe('ended_unresolved');
    expect(c.caseRow().next_steps).toMatch(/callback/);
  });
  it('agent brief for a verified handoff carries facts, actions and context; agent completes the call', async () => {
    const c = await verifiedCaller('S13', 'My card was stolen');
    await c.consent();
    const h = get<any>('SELECT id, brief_json FROM handoffs WHERE session_id = ?', [c.sessionId]);
    const b = JSON.parse(h.brief_json);
    expect(b.customer.verification).toBe('verified');
    expect(b.issue.customerStatement).toBe('My card was stolen');
    expect(b.actions[0]).toMatchObject({ type: 'block_card', status: 'failed' });
    expect(b.recommendedNextStep).toMatch(/URGENT/);
    expect(b.systemsChecked).toHaveLength(6);
    const agent = await staffLogin(app, 'STF-AGENT-1');
    const other = await staffLogin(app, 'STF-AGENT-2');
    await app.inject({ method: 'POST', url: `/api/handoffs/${h.id}/accept`, headers: { cookie: agent }, payload: {} });
    expect((await app.inject({ method: 'POST', url: `/api/handoffs/${h.id}/accept`, headers: { cookie: other }, payload: {} })).statusCode).toBe(409);
    await app.inject({ method: 'POST', url: `/api/handoffs/${h.id}/message`, headers: { cookie: agent }, payload: { text: 'Hi Ben, I have your details here.' } });
    expect((await app.inject({ method: 'POST', url: `/api/handoffs/${h.id}/complete`, headers: { cookie: other }, payload: { outcome: 'resolved' } })).statusCode).toBe(403);
    const done = await app.inject({ method: 'POST', url: `/api/handoffs/${h.id}/complete`, headers: { cookie: agent }, payload: { outcome: 'follow_up_required', notes: 'Card blocked manually by agent.', customerRepeatedIssue: false } });
    expect(done.statusCode).toBe(200);
    await c.refresh();
    expect(c.view.transcript.some((t: any) => t.speaker === 'agent')).toBe(true);
    expect(c.session().ended_at).toBeTruthy();
  });
});

describe('privacy-safe logging', () => {
  it('logger output never contains secrets or card data', () => {
    const lines: string[] = [];
    setLogSink((l) => lines.push(l));
    setLogLevel('debug');
    log.info('test', { otp: '123456', note: 'pan 4111111111111111', authorization: 'Bearer abc.def.ghi.jkl', nested: { cvv: '999' } });
    setLogLevel('silent');
    expect(lines.join('\n')).not.toMatch(/123456|4111111111111111|abc\.def|999/);
  });
});

describe('clock-dependent rules', () => {
  it('a snapshot older than the policy limit cannot support a write', async () => {
    freezeClock(new Date());
    const c = await verifiedCaller('S05', 'Why was I charged a late fee?');
    advanceClock(20 * 60_000);
    // Consent is still within TTL? (10 min) — no: both expire; ensure the action is refused either way.
    await c.consent();
    expect(c.ops()[0].status).toBe('rejected');
    expect(get<any>("SELECT reversed_at FROM bank_fees WHERE id = ?", [c.ops()[0].target_ref]).reversed_at).toBeNull();
  });
  it('prepareAction pre-validation rejects without a verified session', async () => {
    const c = new Caller(app);
    await c.start('S05');
    const { op } = prepareAction({ type: 'reverse_fee', sessionId: c.sessionId, caseId: null, customerId: 'CUS-1005', targetRef: 'FEE-X', params: { ruleCode: 'FP-LATE-01' }, snapshotId: null, actor: { type: 'customer_session', id: c.sessionId }, idempotencyKey: 'pv-1', correlationId: 'c' });
    expect(op.status).toBe('rejected');
    expect(op.error_code).toBe('VERIFICATION_REQUIRED');
  });
});
