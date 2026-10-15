/**
 * Earlier (seeded) cases must read like real ones in the CRM: the customer's own words, a short
 * transcript, and a "what we know" table that is not empty. Nothing here is a live call.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { setup, staffLogin } from './harness.ts';
import { seedIllustrativeHistory } from '../../src/db/seed-history.ts';
import { all } from '../../src/db/db.ts';

let app: FastifyInstance;
let agent = '';
beforeEach(async () => {
  app = await setup();
  seedIllustrativeHistory({ days: 5, calls: 30, seed: 7 });
  agent = await staffLogin(app, 'STF-AGENT-1');
});
afterEach(async () => { await app.close(); });

const get = async (url: string) => {
  const r = await app.inject({ method: 'GET', url, headers: { cookie: agent } });
  return { status: r.statusCode, body: r.json() as any };
};

describe('seeded history in the CRM', () => {
  it('gives every seeded case with an issue the customer’s words and a transcript', () => {
    const rows = all<{ id: string; customer_reported: string | null; session_id: string; issue_type: string | null }>("SELECT id, customer_reported, session_id, issue_type FROM cases WHERE data_origin = 'seeded_illustrative' AND issue_type IS NOT NULL LIMIT 40");
    expect(rows.length).toBeGreaterThan(5);
    for (const r of rows) {
      expect(r.customer_reported, r.id).toBeTruthy();
      expect(r.customer_reported).not.toMatch(/seeded|synthetic|no transcript/i);
      const turns = all<{ n: number }>('SELECT COUNT(*) n FROM conversation_turns WHERE session_id = ?', [r.session_id])[0].n;
      expect(turns, r.id).toBeGreaterThanOrEqual(2);
    }
  });

  it('shows the words, a transcript and basic facts when the case is opened', async () => {
    const row = all<{ id: string }>("SELECT c.id FROM cases c JOIN call_sessions s ON s.id = c.session_id WHERE c.data_origin = 'seeded_illustrative' AND c.issue_type IS NOT NULL AND s.verification_status = 'verified' LIMIT 1")[0];
    const w = await get(`/api/crm/cases/${row.id}`);
    expect(w.status).toBe(200);
    expect(w.body.summary.reported).toBeTruthy();
    expect(w.body.summaryText).not.toMatch(/words were not captured/);
    expect(w.body.transcript.length).toBeGreaterThanOrEqual(2);
    const keys = w.body.facts.map((f: { key: string }) => f.key);
    expect(keys).toContain('issue');
    expect(keys).toContain('identity');
  });
});
