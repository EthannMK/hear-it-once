/**
 * The judge screen and the assistant have to be reading the same records.
 *
 * A judge copies an account from this page, says the phrase it gives them, and compares what Lily
 * says against what the page told them is true. Any sentence on the page that was written by hand
 * rather than read from the database is a sentence that can contradict the call — and it reads as
 * the assistant being wrong, not the page being stale.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { setup } from './harness.ts';
import { all, get, run } from '../../src/db/db.ts';
import { allProfileCards } from '../../src/live/profiles.ts';

let app: FastifyInstance;
const cards = async () => (await app.inject({ method: 'GET', url: '/api/demo/customers' })).json().items;

beforeEach(async () => { app = await setup(); });

describe('the demo data screen', () => {
  it('states the card status the database holds', async () => {
    for (const c of await cards()) {
      const row = get<{ status: string }>(
        'SELECT c.status FROM bank_cards c JOIN bank_customers u ON u.id = c.customer_id WHERE u.customer_number = ? ORDER BY c.id LIMIT 1',
        [c.accountRef],
      );
      expect(c.cardStatus).toBe(row?.status);
      expect(c.situation.toLowerCase()).toContain(`card ${row?.status}`);
    }
  });

  it('names only merchants that are on the account', async () => {
    for (const c of await cards()) {
      const quoted = /charge from (.+?) I don't|declined at (.+?)\.$/.exec(c.tryPhrase);
      const merchant = quoted?.[1] ?? quoted?.[2];
      if (!merchant) continue;
      const names = all<{ merchant_name: string | null }>(
        'SELECT merchant_name FROM bank_transactions WHERE customer_id = (SELECT id FROM bank_customers WHERE customer_number = ?) UNION SELECT merchant_name FROM bank_declines WHERE customer_id = (SELECT id FROM bank_customers WHERE customer_number = ?)',
        [c.accountRef, c.accountRef],
      ).map((r) => (r.merchant_name ?? '').toLowerCase());
      expect(names).toContain(merchant.toLowerCase());
    }
  });

  it('stops promising a reversal once the fee has been reversed', async () => {
    const before = allProfileCards().find((c) => /qualifies for a courtesy reversal/.test(c.situation));
    expect(before, 'at least one demo account should start with a reversible fee').toBeTruthy();
    const cust = get<{ id: string }>('SELECT id FROM bank_customers WHERE customer_number = ?', [before!.accountRef])!.id;
    run("UPDATE bank_fees SET reversed_at = datetime('now') WHERE customer_id = ?", [cust]);

    const after = allProfileCards().find((c) => c.id === before!.id)!;
    expect(after.situation).not.toMatch(/qualifies for a courtesy reversal/);
    expect(after.situation).toMatch(/already been reversed/);
  });

  it('says what is open on an account, or says nothing is', async () => {
    for (const c of await cards()) {
      expect(c.situation.length).toBeGreaterThan(20);
      const open = (c.declines?.length ?? 0) + (c.fees?.length ?? 0) + (c.restrictions?.length ?? 0);
      if (!open) expect(c.situation).toMatch(/Nothing open on the account/);
    }
  });
});
