/**
 * AGENT-TRIGGERED IDENTITY CHECK: the human agent sends a passcode, the customer types it in. The
 * agent never sees the code, and the call's own verification state is untouched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { setup, Caller, staffLogin } from './harness.ts';
import { all, get } from '../../src/db/db.ts';
import { acceptHandoff } from '../../src/handoff/handoff-service.ts';
import { readCheck } from '../../src/verification/agent-check.ts';

let app: FastifyInstance;
beforeEach(async () => { app = await setup(); });
afterEach(async () => { await app.close(); });

/** A verified call that has been handed over and accepted by STF-AGENT-1. */
async function handedOver() {
  const c = new Caller(app);
  await c.start('S01');
  await c.say("There's a charge from Novaplay for $249 I didn't make");
  await c.verify('S01');
  await c.say('I want to speak to a person');
  await c.say('yes');
  const hd = all<{ id: string }>('SELECT id FROM handoffs WHERE session_id = ?', [c.sessionId]);
  expect(hd).toHaveLength(1);
  acceptHandoff(hd[0].id, { type: 'agent', id: 'STF-AGENT-1' });
  return { c, handoffId: hd[0].id };
}

const send = (handoffId: string, cookie: string) =>
  app.inject({ method: 'POST', url: `/api/handoffs/${handoffId}/identity-check`, headers: { cookie }, payload: {} });

describe('the agent can re-check who is on the call', () => {
  it('sends a passcode, tells the agent where it went, and never returns the code', async () => {
    const { c, handoffId } = await handedOver();
    const cookie = await staffLogin(app, 'STF-AGENT-1');
    const r = await send(handoffId, cookie);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.status).toBe('awaiting');
    expect(body.deliveredTo).toMatch(/\d{4}$/);
    // The real code is in the challenge, and nowhere in what staff were told.
    const code = get<{ demo_display: string }>('SELECT demo_display FROM otp_challenges WHERE session_id = ? ORDER BY created_at DESC LIMIT 1', [c.sessionId])!.demo_display;
    expect(JSON.stringify(body)).not.toContain(code);
    const ws = await app.inject({ method: 'GET', url: `/api/crm/cases/${c.caseRow().id}`, headers: { cookie } });
    expect(JSON.stringify(ws.json())).not.toContain(code);
    expect(ws.json().agentCheck).toMatchObject({ status: 'awaiting' });
  });

  it('the customer types the code and the check passes', async () => {
    const { c, handoffId } = await handedOver();
    const cookie = await staffLogin(app, 'STF-AGENT-1');
    await send(handoffId, cookie);
    await c.refresh();
    expect(c.view.secureEntry).toMatchObject({ kind: 'agent_otp' });
    const code = c.view.demoDevice.code ?? String(c.view.demoDevice.message).match(/\b\d{6}\b/)![0];
    await c.say(code);
    expect(readCheck(c.sessionId)!.status).toBe('passed');
    expect(c.lastAssistant()).toMatch(/passcode matched/i);
  });

  it('a wrong code can be retried, and the call itself stays verified either way', async () => {
    const { c, handoffId } = await handedOver();
    const before = c.session().verification_status;
    const cookie = await staffLogin(app, 'STF-AGENT-1');
    await send(handoffId, cookie);
    await c.say('000000');
    expect(readCheck(c.sessionId)!.status).toBe('awaiting');
    expect(c.lastAssistant()).toMatch(/didn’t match|didn't match/i);
    expect(c.session().verification_status).toBe(before);
  });

  it('another agent cannot run a check on a call they did not take', async () => {
    const { handoffId } = await handedOver();
    const other = await staffLogin(app, 'STF-AGENT-2');
    const r = await send(handoffId, other);
    expect([403, 409]).toContain(r.statusCode);
  });

  it('a caller token cannot send itself a passcode', async () => {
    const { c, handoffId } = await handedOver();
    const r = await app.inject({ method: 'POST', url: `/api/handoffs/${handoffId}/identity-check`, headers: { 'x-call-token': c.token }, payload: {} });
    expect([401, 403]).toContain(r.statusCode);
  });

  it('the check is recorded against the agent who asked for it', async () => {
    const { c, handoffId } = await handedOver();
    const cookie = await staffLogin(app, 'STF-AGENT-1');
    await send(handoffId, cookie);
    const events = all<{ event: string; actor_id: string }>('SELECT event, actor_id FROM audit_events WHERE session_id = ?', [c.sessionId]);
    expect(events.some((e) => e.event === 'verification.agent_check_sent' && e.actor_id === 'STF-AGENT-1')).toBe(true);
    expect(all<{ type: string }>('SELECT type FROM timeline_events WHERE session_id = ?', [c.sessionId]).some((t) => t.type === 'verification.agent_requested')).toBe(true);
  });
});
