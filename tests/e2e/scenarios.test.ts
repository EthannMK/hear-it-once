/**
 * END-TO-END: all 18 required demo scenarios through the real HTTP API.
 * Assertions are made on PERSISTED backend state (operations, bank mock state, cases,
 * handoffs, audit) — never only on a message the UI would display (BRD §15 acceptance rule).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { setup, Caller, staffLogin } from './harness.ts';
import { all, get, run } from '../../src/db/db.ts';
import { setEnvForTests, env } from '../../src/config/env.ts';
import { containsProhibitedCardData } from '../../src/lib/redact.ts';

let app: FastifyInstance;
const origTimeout = env().ACTION_TIMEOUT_MS;
beforeEach(async () => {
  app = await setup();
  setEnvForTests({ ACTION_TIMEOUT_MS: 400 });
});
afterEach(async () => {
  setEnvForTests({ ACTION_TIMEOUT_MS: origTimeout });
  await app.close();
});

const cardStatus = (id: string) => get<{ status: string }>('SELECT status FROM bank_cards WHERE id = ?', [id])!.status;
const auditCount = (sessionId: string, event: string) => get<{ n: number }>('SELECT COUNT(*) n FROM audit_events WHERE session_id = ? AND event = ?', [sessionId, event])!.n;
const transcriptNot = (c: Caller, re: RegExp) => expect(c.view.transcript.filter((t: any) => t.speaker !== 'customer').map((t: any) => t.text).join('\n')).not.toMatch(re);

describe('S01 unrecognised charge → block, replace, dispute', () => {
  it('executes all three actions only after consent and persists a complete case', async () => {
    const c = new Caller(app);
    await c.start('S01');
    expect(c.view.transcript[1].text).toMatch(/AI assistant/); // FR-01 disclosure first
    expect(c.view.transcript[0].text).toMatch(/recorded/);
    await c.say("There's a charge from Novaplay for $249 that I didn't make");
    await c.verify('S01');
    expect(c.view.proposal.actions.map((a: any) => a.type)).toEqual(['block_card', 'order_replacement', 'submit_dispute']);
    // Nothing executed before consent.
    expect(cardStatus('CRD-1001A')).toBe('active');
    expect(c.ops().every((o) => o.status === 'awaiting_confirmation')).toBe(true);
    await c.consent('accept');
    const ops = c.ops();
    expect(ops.map((o) => [o.action_type, o.status])).toEqual([['block_card', 'succeeded'], ['order_replacement', 'succeeded'], ['submit_dispute', 'succeeded']]);
    expect(ops.every((o) => o.consent_id && o.external_ref)).toBe(true);
    expect(cardStatus('CRD-1001A')).toBe('blocked');
    const d = get<any>('SELECT * FROM disputes WHERE session_id = ?', [c.sessionId]);
    expect(d).toMatchObject({ status: 'submitted', merchant: 'NOVAPLAY DIGITAL', amount_minor: 24900, currency: 'USD', reason_code: 'fraud_unrecognised', rule_code: 'DR-FRAUD-01' });
    expect(JSON.parse(d.missing_fields_json)).toEqual([]);
    expect(d.external_ref).toBe(ops[2].external_ref);
    const cs = c.caseRow();
    expect(cs.customer_id).toBe('CUS-1001');
    expect(cs.status).toBe('resolved');
    expect(cs.summary).toMatch(/Customer reported:/);
    expect(cs.summary).toMatch(/Bank systems confirmed:/);
    expect(cs.summary).toMatch(/Actions completed \(confirmed by service\): Block card/);
    expect(JSON.parse(cs.sources_checked_json)).toHaveLength(6);
    expect(c.view.sources.items.every((s: any) => s.status === 'ok')).toBe(true);
    // Persisted bank-side record matches what we told the customer.
    const bankOps = all<any>('SELECT * FROM bank_operations');
    expect(bankOps).toHaveLength(3);
    expect(auditCount(c.sessionId, 'action.succeeded')).toBe(3);
    await c.say('no');
    await c.input({ kind: 'survey', score: 5 });
    expect(c.session().outcome).toBe('resolved');
    expect(c.session().case_created_at <= c.session().ended_at).toBe(true);
  });
});

describe('S02 lost card', () => {
  it('proposes the block immediately after verification and records time-to-block', async () => {
    const c = new Caller(app);
    await c.start('S02');
    await c.say('I lost my credit card');
    await c.verify('S02');
    expect(c.view.proposal.actions).toEqual([{ type: 'block_card', label: expect.stringMatching(/Block card ending/) }]);
    await c.consent();
    expect(cardStatus('CRD-1002A')).toBe('blocked');
    const s = c.session();
    const block = c.ops().find((o) => o.action_type === 'block_card');
    expect(block.status).toBe('succeeded');
    expect((Date.parse(block.completed_at) - Date.parse(s.verified_at)) / 1000).toBeLessThan(60);
    await c.consent(); // replacement
    expect(c.ops().find((o) => o.action_type === 'order_replacement').status).toBe('succeeded');
    await c.say('no');
    expect(c.caseRow().status).toBe('resolved');
  });
});

describe('S03 duplicate charge with insufficient evidence', () => {
  it('explains the evidence, offers an agent and makes no write', async () => {
    const c = new Caller(app);
    await c.start('S03');
    await c.say('I was charged twice at Harbor Grill');
    await c.verify('S03');
    expect(c.lastAssistant()).toMatch(/still pending/);
    expect(c.view.pending).toMatchObject({ kind: 'yes_no', purpose: 'offer_agent' });
    expect(c.ops()).toHaveLength(0);
    expect(get('SELECT 1 FROM disputes WHERE session_id = ?', [c.sessionId])).toBeUndefined();
    await c.say('yes please');
    expect(get<any>('SELECT reason, status FROM handoffs WHERE session_id = ?', [c.sessionId])).toMatchObject({ reason: 'out_of_policy', status: 'queued' });
  });
});

describe('S04 payment pending', () => {
  it('reports pending without inventing a posting date', async () => {
    const c = new Caller(app);
    await c.start('S04');
    await c.say("I made a payment of $500 but it's not showing");
    await c.verify('S04');
    const msg = c.lastAssistant();
    expect(msg).toMatch(/pending/);
    expect(msg).toMatch(/hasn't given a posting date/);
    expect(msg).not.toMatch(/will (post|appear) (on|by)/i);
    expect(c.session().resolution_status).toBe('informational');
    const facts = all<any>("SELECT detail_json FROM case_events WHERE case_id = ? AND event_type = 'fact_unavailable'", [c.caseRow().id]);
    expect(facts.some((f) => /No posting date/.test(f.detail_json))).toBe(true);
  });
});

describe('S05 eligible fee reversal', () => {
  it('reverses the fee only after explicit consent and confirms via the fee ledger', async () => {
    const c = new Caller(app);
    await c.start('S05');
    await c.say('Why was I charged a late fee?');
    await c.verify('S05');
    const fee = get<any>("SELECT * FROM bank_fees WHERE customer_id = 'CUS-1005' AND reversed_at IS NULL")!;
    expect(c.view.proposal.actions[0].type).toBe('reverse_fee');
    await c.consent();
    expect(get<any>('SELECT reversed_at FROM bank_fees WHERE id = ?', [fee.id]).reversed_at).toBeTruthy();
    const op = c.ops()[0];
    expect(op).toMatchObject({ status: 'succeeded', target_ref: fee.id });
    expect(JSON.parse(op.policy_decision_json).checks.find((x: any) => x.check === 'fee_eligible').passed).toBe(true);
  });
});

describe('S06 ineligible fee reversal', () => {
  it('explains the rule, offers handoff and never reverses', async () => {
    const c = new Caller(app);
    await c.start('S06');
    await c.say('Can you remove the late fee on my account?');
    await c.verify('S06');
    expect(c.lastAssistant()).toMatch(/already been given in the last 12 months/);
    expect(c.lastAssistant()).toMatch(/FP-LATE-01/);
    expect(c.ops()).toHaveLength(0);
    expect(get<any>("SELECT COUNT(*) n FROM bank_fees WHERE customer_id = 'CUS-1006' AND reversed_at IS NOT NULL").n).toBe(1); // only the historical one
  });
});

describe('S07 repeat caller', () => {
  it('retrieves the prior unresolved case after (not before) verification and flags recurrence', async () => {
    const c = new Caller(app);
    await c.start('S07');
    await c.say("I'm calling again about my payment");
    // Before verification: no prior case or account data visible.
    expect(c.view.transcript.map((t: any) => t.text).join(' ')).not.toMatch(/CASE-/);
    expect(c.view.sources).toBeNull();
    await c.verify('S07');
    const prior = get<any>("SELECT id FROM cases WHERE customer_id = 'CUS-1007' AND session_id != ?", [c.sessionId])!;
    expect(c.view.transcript.map((t: any) => t.text).join(' ')).toContain(prior.id);
    const cs = c.caseRow();
    expect(cs.recurring_issue).toBe(1);
    expect(JSON.parse(cs.previous_case_ids_json)).toContain(prior.id);
    expect(JSON.parse(cs.risk_flags_json)).toContain('recurring_unresolved');
    expect(c.session().repeat_contact).toBe(1);
  });
});

describe('S08 customer asks for a human immediately', () => {
  it('starts a handoff without resistance; brief preserves context; not "connected" until an agent accepts', async () => {
    const c = new Caller(app);
    await c.start('S08');
    await c.say('I want to speak to a real person');
    const h = get<any>('SELECT * FROM handoffs WHERE session_id = ?', [c.sessionId])!;
    expect(h.reason).toBe('customer_requested');
    expect(h.status).toBe('queued');
    expect(c.view.handoff.status).toBe('queued');
    const brief = JSON.parse(h.brief_json);
    expect(brief.issue.customerStatement).toMatch(/real person/);
    expect(brief.customer.verification).toBe('not_started');
    expect(brief.transactions).toEqual([]); // nothing protected for an unverified caller
    // Agent accepts → connected (confirmed by the simulated desk).
    const cookie = await staffLogin(app, 'STF-AGENT-1');
    const acc = await app.inject({ method: 'POST', url: `/api/handoffs/${h.id}/accept`, headers: { cookie }, payload: {} });
    expect(acc.statusCode).toBe(200);
    await c.refresh();
    expect(c.view.handoff.status).toBe('connected');
    expect(c.session().agent_joined_at).toBeTruthy();
  });
});

describe('S09 AI uncertainty', () => {
  it('hands off with reason ai_uncertain after two clarifications', async () => {
    const c = new Caller(app);
    await c.start('S09');
    await c.say('Something is off with my stuff');
    expect(c.view.choices.length).toBeGreaterThan(3);
    await c.say("It's the thing from before, you know");
    expect(c.view.choices.length).toBeGreaterThan(0);
    await c.say('Just the usual problem with it');
    expect(get<any>('SELECT reason FROM handoffs WHERE session_id = ?', [c.sessionId]).reason).toBe('ai_uncertain');
  });
});

describe('S10 identity verification fails', () => {
  it('locks after 3 attempts; no protected data, no actions, no OTP issued', async () => {
    const c = new Caller(app);
    await c.start('S10');
    await c.say("There's a charge I don't recognise");
    for (const d of ['1990-01-01', '1990-01-02', '1990-01-03']) await c.say(d);
    expect(c.session().verification_status).toBe('failed');
    expect(c.session().customer_id).toBeNull();
    expect(get('SELECT 1 FROM retrieval_snapshots WHERE session_id = ?', [c.sessionId])).toBeUndefined();
    expect(get('SELECT 1 FROM otp_challenges WHERE session_id = ?', [c.sessionId])).toBeUndefined();
    expect(c.view.sources).toBeNull();
    expect(c.view.findings).toBeNull();
    expect(get<any>('SELECT reason FROM handoffs WHERE session_id = ?', [c.sessionId]).reason).toBe('verification_failed');
    // The direct action API also refuses.
    const r = await app.inject({ method: 'POST', url: `/api/calls/${c.sessionId}/actions`, headers: { 'x-call-token': c.token, 'idempotency-key': 'attempt-0001' }, payload: { type: 'block_card', targetRef: 'CRD-1010A', params: { reason: 'lost' } } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('VERIFICATION_REQUIRED');
    expect(cardStatus('CRD-1010A')).toBe('active');
    // Verification answers never reach the transcript.
    expect(all<any>('SELECT text FROM conversation_turns WHERE session_id = ?', [c.sessionId]).some((t) => /1990-01-0/.test(t.text))).toBe(false);
  });
});

describe('S11 required system unavailable', () => {
  it('records the failed source, makes no decision or write, and hands off', async () => {
    const c = new Caller(app);
    await c.start('S11');
    await c.say("I don't recognise a QuickStream charge of $59.99");
    await c.verify('S11');
    const tx = c.view.sources.items.find((s: any) => s.source === 'transactions');
    expect(tx.status).toBe('unavailable');
    expect(tx.attempts).toBe(2); // bounded retry
    expect(get<any>("SELECT status FROM integration_calls WHERE session_id = ? AND source = 'transactions'", [c.sessionId]).status).toBe('unavailable');
    expect(c.ops()).toHaveLength(0);
    expect(get<any>('SELECT reason FROM handoffs WHERE session_id = ?', [c.sessionId]).reason).toBe('system_unavailable');
  });
});

describe('S12 conflicting system results', () => {
  it('detects the conflict and makes no sensitive write', async () => {
    const c = new Caller(app);
    await c.start('S12');
    await c.say('There is a $1249 Orbit Electronics charge I never made');
    await c.verify('S12');
    expect(c.view.sources.conflicts[0].type).toBe('card_status_mismatch');
    expect(c.ops()).toHaveLength(0);
    expect(cardStatus('CRD-1012A')).toBe('active');
    const h = get<any>('SELECT reason, brief_json FROM handoffs WHERE session_id = ?', [c.sessionId]);
    expect(h.reason).toBe('conflicting_data');
    expect(JSON.parse(h.brief_json).conflicts[0]).toMatch(/Card system reports "active", fraud system reports "blocked"/);
  });
});

describe('S13 card block fails', () => {
  it('never says the card is blocked and escalates urgently', async () => {
    const c = new Caller(app);
    await c.start('S13');
    await c.say('My card was stolen');
    await c.verify('S13');
    await c.consent();
    expect(c.ops()[0]).toMatchObject({ action_type: 'block_card', status: 'failed', error_code: 'DOWNSTREAM_REJECTED' });
    expect(cardStatus('CRD-1013A')).toBe('active');
    expect(c.lastAssistant()).toMatch(/NOT blocked/);
    transcriptNot(c, /is now blocked/);
    const h = get<any>('SELECT reason, brief_json FROM handoffs WHERE session_id = ?', [c.sessionId]);
    expect(h.reason).toBe('action_failed');
    expect(JSON.parse(h.brief_json).priority).toBe('urgent');
    expect(c.session().outcome).toBe('handed_off');
  });
});

describe('S14 block times out → Unknown → reconciled', () => {
  it('marks Unknown, does not resend, then reconciles to the downstream truth', async () => {
    const c = new Caller(app);
    await c.start('S14');
    await c.say('Someone stole my wallet with my card');
    await c.verify('S14');
    await c.consent();
    let op = c.ops()[0];
    expect(op).toMatchObject({ status: 'unknown', error_code: 'TIMEOUT_AFTER_SUBMIT', attempts: 1 });
    transcriptNot(c, /is now blocked/);
    expect(c.view.canReconcile).toBe(true);
    // Retry is refused while Unknown.
    const retry = await app.inject({ method: 'POST', url: `/api/calls/${c.sessionId}/actions/${op.id}/retry`, headers: { 'x-call-token': c.token }, payload: {} });
    expect(retry.statusCode).toBe(409);
    expect(retry.json().error.code).toBe('OPERATION_OUTCOME_UNKNOWN');
    await c.say('Can you check if it worked?');
    op = c.ops()[0];
    expect(op.status).toBe('succeeded');
    expect(op.attempts).toBe(1); // reconciled by lookup, never re-sent
    expect(get<any>("SELECT COUNT(*) n FROM bank_operations WHERE system = 'card_control'").n).toBe(1);
    const hist = all<any>('SELECT to_status FROM action_status_history WHERE operation_id = ? ORDER BY id', [op.id]).map((h) => h.to_status);
    expect(hist).toEqual(['requested', 'validated', 'awaiting_confirmation', 'submitted', 'unknown', 'succeeded']);
    expect(c.view.proposal.actions[0].type).toBe('order_replacement'); // flow resumed
  });
});

describe('S15 duplicate action request (idempotency)', () => {
  it('two concurrent confirmations execute the block exactly once', async () => {
    const c = new Caller(app);
    await c.start('S15');
    await c.say('I lost my card');
    await c.verify('S15');
    const pid = c.view.proposal.id;
    const send = (n: number) => app.inject({ method: 'POST', url: `/api/calls/${c.sessionId}/input`, headers: { 'x-call-token': c.token }, payload: { kind: 'consent', proposalId: pid, decision: 'accept', clientMessageId: `dup-${n}` } });
    const [a, b] = await Promise.all([send(1), send(2)]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    const blocks = c.ops().filter((o) => o.action_type === 'block_card');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].attempts).toBe(1);
    expect(get<any>("SELECT COUNT(*) n FROM bank_operations WHERE system = 'card_control'").n).toBe(1);
    expect(get<any>("SELECT COUNT(*) n FROM consents WHERE proposal_id = ?", [pid]).n).toBe(1);
    expect(get<any>("SELECT COUNT(*) n FROM session_events WHERE session_id = ? AND event_type = 'duplicate_consent_ignored'", [c.sessionId]).n).toBe(1);
  });
  it('a replayed direct-API request with the same Idempotency-Key returns the same operation', async () => {
    const c = new Caller(app);
    await c.start('S15');
    await c.say('I lost my card');
    await c.verify('S15');
    const req = () => app.inject({ method: 'POST', url: `/api/calls/${c.sessionId}/actions`, headers: { 'x-call-token': c.token, 'idempotency-key': 'same-key-123' }, payload: { type: 'block_card', targetRef: 'CRD-1015A', params: { reason: 'lost' } } });
    const [r1, r2] = await Promise.all([req(), req()]);
    // No consent → both rejected, but only ONE operation exists for the key.
    expect(r1.json().error.details.operation.id).toBe(r2.json().error.details.operation.id);
    expect(get<any>("SELECT COUNT(*) n FROM action_operations WHERE idempotency_key = 'api:same-key-123'").n).toBe(1);
    // Same key, different parameters → conflict.
    const r3 = await app.inject({ method: 'POST', url: `/api/calls/${c.sessionId}/actions`, headers: { 'x-call-token': c.token, 'idempotency-key': 'same-key-123' }, payload: { type: 'block_card', targetRef: 'CRD-1015A', params: { reason: 'stolen' } } });
    expect(r3.statusCode).toBe(409);
    expect(r3.json().error.code).toBe('IDEMPOTENCY_MISMATCH');
  });
});

describe('S16 dispute submission pending', () => {
  it('reports pending, never "filed" or "accepted"', async () => {
    const c = new Caller(app);
    await c.start('S16');
    await c.say("I didn't make the Lumen Travel charge for $412.50");
    await c.verify('S16');
    await c.consent();
    const ops = c.ops();
    expect(ops.map((o) => [o.action_type, o.status])).toEqual([['block_card', 'succeeded'], ['order_replacement', 'succeeded'], ['submit_dispute', 'submitted']]);
    expect(get<any>('SELECT status FROM disputes WHERE session_id = ?', [c.sessionId]).status).toBe('pending');
    expect(c.lastAssistant()).toMatch(/pending — not yet filed/);
    transcriptNot(c, /dispute has been submitted|accepted/i);
    expect(c.session().resolution_status).toBe('partially_resolved');
  });
  it('a failed dispute submission is reported as not filed', async () => {
    run("UPDATE mock_faults SET fault = 'fail' WHERE scope_ref = 'CUS-1016' AND target = 'dispute_intake'");
    const c = new Caller(app);
    await c.start('S16');
    await c.say("I didn't make the Lumen Travel charge for $412.50");
    await c.verify('S16');
    await c.consent();
    expect(get<any>('SELECT status FROM disputes WHERE session_id = ?', [c.sessionId]).status).toBe('rejected');
    expect(c.view.transcript.map((t: any) => t.text).join(' ')).toMatch(/has NOT been filed/);
  });
});

describe('S17 assistant unavailable', () => {
  it('shows the controlled fallback, keeps the issue statement and routes to the queue', async () => {
    const c = new Caller(app);
    await c.start('S17');
    await c.say('I have a question about a fee');
    expect(c.view.session.stage).toBe('handoff');
    expect(c.session().outcome).toBe('fallback');
    expect(c.lastAssistant()).toMatch(/temporarily unavailable/);
    const cs = c.caseRow();
    expect(cs.customer_reported).toMatch(/question about a fee/);
    expect(get<any>('SELECT reason FROM handoffs WHERE session_id = ?', [c.sessionId]).reason).toBe('assistant_unavailable');
    expect(get<any>("SELECT COUNT(*) n FROM session_events WHERE session_id = ? AND event_type = 'assistant_unavailable'", [c.sessionId]).n).toBe(1);
  });
});

describe('S18 sensitive action without consent or permission', () => {
  it('backend rejects missing consent (422), wrong role (403) and audits both', async () => {
    const c = new Caller(app);
    await c.start('S18');
    await c.say('Please waive my late fee');
    await c.verify('S18');
    const fee = get<any>("SELECT id FROM bank_fees WHERE customer_id = 'CUS-1018' AND reversed_at IS NULL")!;
    const noConsent = await app.inject({ method: 'POST', url: `/api/calls/${c.sessionId}/actions`, headers: { 'x-call-token': c.token, 'idempotency-key': 'noconsent-001' }, payload: { type: 'reverse_fee', targetRef: fee.id, params: { ruleCode: 'FP-LATE-01' } } });
    expect(noConsent.statusCode).toBe(422);
    expect(noConsent.json().error.code).toBe('CONSENT_REQUIRED');
    // A forged consent id from nowhere is also rejected.
    const forged = await app.inject({ method: 'POST', url: `/api/calls/${c.sessionId}/actions`, headers: { 'x-call-token': c.token, 'idempotency-key': 'forged-0001' }, payload: { type: 'reverse_fee', targetRef: fee.id, params: { ruleCode: 'FP-LATE-01' }, consentId: 'CNS-FAKE123456' } });
    expect(forged.json().error.code).toBe('CONSENT_REQUIRED');
    // QA and admin roles cannot request actions at all.
    for (const user of ['STF-QA-1', 'STF-ADMIN-1']) {
      const cookie = await staffLogin(app, user);
      const r = await app.inject({ method: 'POST', url: `/api/calls/${c.sessionId}/actions`, headers: { cookie, 'idempotency-key': `role-${user}` }, payload: { type: 'reverse_fee', targetRef: fee.id, params: { ruleCode: 'FP-LATE-01' } } });
      expect(r.statusCode).toBe(403);
    }
    // No caller token, no staff → 401.
    const anon = await app.inject({ method: 'POST', url: `/api/calls/${c.sessionId}/actions`, headers: { 'idempotency-key': 'anon-00001' }, payload: { type: 'reverse_fee', targetRef: fee.id, params: {} } });
    expect(anon.statusCode).toBe(401);
    expect(get<any>('SELECT reversed_at FROM bank_fees WHERE id = ?', [fee.id]).reversed_at).toBeNull();
    expect(get<any>("SELECT COUNT(*) n FROM audit_events WHERE session_id = ? AND event = 'action.rejected' AND status = 'denied'", [c.sessionId]).n).toBeGreaterThanOrEqual(2);
    // The legitimate conversational path still works afterwards.
    await c.consent();
    expect(get<any>('SELECT reversed_at FROM bank_fees WHERE id = ?', [fee.id]).reversed_at).toBeTruthy();
  });
});

describe('cross-scenario privacy', () => {
  it('no stored record or API view contains a full PAN, CVV or verification secret', async () => {
    const c = new Caller(app);
    await c.start('S01');
    await c.say('my card number is 4111 1111 1111 1111 and the cvv is 123, there is a Novaplay charge of $249 I did not make');
    await c.verify('S01');
    await c.consent();
    for (const { name } of all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")) {
      for (const row of all(`SELECT * FROM ${name}`)) expect(containsProhibitedCardData(JSON.stringify(row)), name).toBe(false);
    }
    await c.refresh();
    expect(containsProhibitedCardData(JSON.stringify(c.view))).toBe(false);
    expect(JSON.stringify(c.view)).not.toContain('1986-04-12');
  });
});
