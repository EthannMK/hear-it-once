/** Card collection: read-back, confirmation, corrections, timeouts and duplicate protection. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { setup, Caller } from './harness.ts';
import { all } from '../../src/db/db.ts';
import { setAdapters, mockRegistry } from '../../src/adapters/registry.ts';
import { cardCheckMetrics } from '../../src/verification/verification.ts';
import { policy, setPolicyForTests } from '../../src/config/policy.ts';

let app: FastifyInstance;
beforeEach(async () => { app = await setup(); });
afterEach(async () => { setAdapters(null); setPolicyForTests(null); await app.close(); });

const wrong = (n: string) => n.slice(0, -1) + String((Number(n.slice(-1)) + 1) % 10);
async function start() {
  const list = (await app.inject({ method: 'GET', url: '/api/demo/customers' })).json().items;
  const profile = list[0];
  const c = new Caller(app);
  await c.start(undefined, { channel: 'voice_browser', profileId: profile.id });
  await c.say('I do not recognise a charge on my card');
  return { c, pan: profile.cardNumber as string };
}
const last = (c: Caller) => c.view.transcript.filter((t: any) => t.speaker === 'assistant').slice(-1)[0].text as string;

describe('card read-back', () => {
  it('reads back only the last four digits and does not verify until the caller confirms', async () => {
    const { c, pan } = await start();
    await c.say(pan);
    expect(last(c)).toMatch(new RegExp(`ending in ${pan.replace(/\D/g, '').slice(-4).split('').join(' ')}`));
    expect(last(c)).not.toContain(pan.replace(/\D/g, ''));
    expect(c.session().verification_status).not.toBe('verified');
    await c.say('yes');
    expect(c.session().verification_status).toBe('verified');
    expect(c.transcriptText()).toContain('Let me check that for you');
  });

  it('uses the corrected number, not the first one', async () => {
    const { c, pan } = await start();
    await c.say(wrong(pan));
    await c.say('sorry, it is ' + pan);
    expect(last(c)).toMatch(/updated it/);
    await c.say('yes');
    expect(c.session().verification_status).toBe('verified');
    const attempts = all<any>("SELECT outcome FROM verification_attempts WHERE session_id = ? AND step = 'card'", [c.sessionId]);
    expect(attempts.map((a) => a.outcome)).toEqual(['passed']);
  });

  it('asks again when the caller says no, and does not use up an attempt', async () => {
    const { c, pan } = await start();
    await c.say(wrong(pan));
    await c.say('no');
    expect(last(c)).toMatch(/again/i);
    expect(all("SELECT 1 FROM verification_attempts WHERE session_id = ? AND step = 'card'", [c.sessionId])).toHaveLength(0);
    await c.say(pan); await c.say('yes');
    expect(c.session().verification_status).toBe('verified');
  });

  it('asks for the full number when only part is heard, without using an attempt', async () => {
    const { c } = await start();
    await c.say('four zero zero one 4001 0000');
    expect(last(c)).toMatch(/need all 16/);
    expect(all("SELECT 1 FROM verification_attempts WHERE session_id = ? AND step = 'card'", [c.sessionId])).toHaveLength(0);
  });

  it('never stores the full number in the transcript, context or audit', async () => {
    const { c, pan } = await start();
    await c.say(pan); await c.say('yes');
    const d = pan.replace(/\D/g, '');
    const dump = JSON.stringify([all('SELECT text FROM conversation_turns'), all('SELECT context_json FROM call_sessions'), all('SELECT * FROM audit_events'), all('SELECT * FROM timeline_events')]);
    expect(dump).not.toContain(d);
  });
});

describe('verification service', () => {
  it('reports a timeout as temporarily unavailable, keeps state, and lets the caller try again without a used attempt', async () => {
    const { c, pan } = await start();
    setPolicyForTests({ ...policy(), verification: { ...policy().verification, cardCheckTimeoutMs: 30 } });
    const real = mockRegistry.identity.checkCardNumber;
    let slow = true;
    setAdapters({ ...mockRegistry, identity: { ...mockRegistry.identity, checkCardNumber: (...a) => (slow ? new Promise<boolean>(() => {}) : real(...a)) } });
    await c.say(pan); await c.say('yes');
    expect(last(c)).toMatch(/taking longer than expected/);
    expect(c.session().verification_status).not.toBe('verified');
    expect(all("SELECT 1 FROM verification_attempts WHERE session_id = ? AND step = 'card'", [c.sessionId])).toHaveLength(0);
    slow = false;
    await c.say('try again');
    expect(c.session().verification_status).toBe('verified');
    expect(cardCheckMetrics().outcomes.temporarily_unavailable).toBeGreaterThan(0);
  });

  it('drops a duplicate check while one is running', async () => {
    const { c, pan } = await start();
    let calls = 0;
    const real = mockRegistry.identity.checkCardNumber;
    setAdapters({ ...mockRegistry, identity: { ...mockRegistry.identity, checkCardNumber: async (...a) => { calls++; await new Promise((r) => setTimeout(r, 150)); return real(...a); } } });
    await c.say(pan);
    const [a, b] = await Promise.all([c.say('yes'), c.say('yes, that is right')]).catch((e) => [e, e]);
    void a; void b;
    expect(calls).toBe(1);
  });
});
