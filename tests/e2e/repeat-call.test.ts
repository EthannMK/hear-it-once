/**
 * A repeat call as the same demo customer. The bank records are put back between calls, so the
 * earlier case must not read as the current state of the account.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { setup, Caller, staffLogin } from './harness.ts';
import { all, get } from '../../src/db/db.ts';
import { allProfileCards } from '../../src/live/profiles.ts';

let app: FastifyInstance;
beforeEach(async () => { app = await setup(); });
afterEach(async () => { await app.close(); });

const pan = (id: string) => allProfileCards().find((p) => p.id === id)!.cardNumber!.replace(/\D/g, '').replace(/(\d{4})(?=\d)/g, '$1 ');

/** Identify by card, report the card lost, and block it. */
async function blockTheCard() {
  const c = new Caller(app);
  await c.start(undefined, { channel: 'voice_browser' });
  await c.say('My card was stolen');
  await c.say(pan('priya-shah'));
  await c.say('yes');
  await c.refresh();
  if (c.view.proposal) await c.consent();
  await c.refresh();
  return c;
}

describe('a second call as the same customer', () => {
  it('the earlier case says the demo data was put back, so it cannot be read as the card still being blocked', async () => {
    const first = await blockTheCard();
    const customerId = first.session().customer_id as string;
    expect(customerId).toBeTruthy();
    const blocked = all<any>("SELECT id FROM action_operations WHERE session_id = ? AND action_type = 'block_card' AND status = 'succeeded'", [first.sessionId]);
    expect(blocked.length).toBeGreaterThan(0);
    expect(get<any>("SELECT status FROM bank_cards WHERE customer_id = ? ORDER BY status", [customerId]).status).toBe('blocked');
    const caseId = first.caseRow().id as string;
    await first.input({ kind: 'hangup' });

    // The same caller rings again: the records are put back for the new call.
    const second = new Caller(app);
    await second.start(undefined, { channel: 'voice_browser' });
    await second.say("There's a charge I don't recognise on my card");
    await second.say(pan('priya-shah'));
    await second.say('yes');
    expect(get<any>("SELECT status FROM bank_cards WHERE customer_id = ? ORDER BY status", [customerId]).status).toBe('active');

    // The earlier case now carries the reset, in its events and in the summary an agent reads.
    const events = all<{ event_type: string }>('SELECT event_type FROM case_events WHERE case_id = ?', [caseId]);
    expect(events.some((e) => e.event_type === 'demo_data_reset')).toBe(true);
    const summary = get<{ summary: string }>('SELECT summary FROM cases WHERE id = ?', [caseId])!.summary;
    expect(summary).toMatch(/Demo data was put back after this call/i);
    expect(summary).toMatch(/card is active again/i);
    // What happened on that call is still recorded.
    expect(summary).toMatch(/Block card/i);

    // And the agent workspace shows the same thing the account panel does.
    const cookie = await staffLogin(app, 'STF-AGENT-1');
    const ws = await app.inject({ method: 'GET', url: `/api/crm/cases/${caseId}`, headers: { cookie } });
    expect(ws.statusCode).toBe(200);
    expect(JSON.stringify(ws.json())).toMatch(/Demo data was put back/i);
  });
});
