/**
 * THE SAFETY SCREEN'S DATA.
 *
 * The page is only worth having if what it shows is read from the running system, so these tests
 * are about the four things it reads: who may read them, that they describe the system as it is
 * now rather than as it was at boot, and that an empty state says so instead of showing a zero that
 * could be read as a result.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { setup, staffLogin, Caller } from './harness.ts';
import { FRAUD_PATTERNS } from '../../src/security/fraud-patterns.ts';
import { run } from '../../src/db/db.ts';

let app: FastifyInstance;
beforeEach(async () => { app = await setup(); });
afterEach(async () => { await app.close(); });

const get = async (url: string, user?: string) => {
  const headers = user ? { cookie: await staffLogin(app, user) } : undefined;
  return app.inject({ method: 'GET', url, ...(headers ? { headers } : {}) });
};

describe('who may see it', () => {
  it('an agent may not read any of it: this is an operations screen', async () => {
    for (const url of ['/api/safety', '/api/audit/verify', '/api/scorecard', '/api/fraud-patterns']) {
      const r = await get(url, 'STF-AGENT-1');
      expect(r.statusCode, url).toBe(403);
    }
  });

  it('nobody signed in may read any of it', async () => {
    for (const url of ['/api/safety', '/api/audit/verify', '/api/scorecard', '/api/fraud-patterns']) {
      const r = await get(url);
      expect([401, 403], url).toContain(r.statusCode);
    }
  });

  it('operations may read all of it', async () => {
    for (const url of ['/api/safety', '/api/audit/verify', '/api/scorecard', '/api/fraud-patterns']) {
      const r = await get(url, 'STF-QA-1');
      expect(r.statusCode, url).toBe(200);
    }
  });
});

describe('the fraud patterns it shows', () => {
  it('are the ones the code cites, not a copy written into the page', async () => {
    const r = await get('/api/fraud-patterns', 'STF-ADMIN-1');
    const items = r.json().items as typeof FRAUD_PATTERNS;
    expect(items).toHaveLength(FRAUD_PATTERNS.length);
    expect(items.map((x) => x.id)).toEqual(FRAUD_PATTERNS.map((x) => x.id));
  });

  it('each one says where it is enforced, so a reviewer can follow the trail', async () => {
    const items = (await get('/api/fraud-patterns', 'STF-ADMIN-1')).json().items as typeof FRAUD_PATTERNS;
    for (const p of items) {
      expect(p.control.length, p.id).toBeGreaterThan(40);
      expect(['enforced', 'partial', 'out_of_scope'], p.id).toContain(p.state);
      if (p.state !== 'out_of_scope') expect(p.enforcedIn.length, p.id).toBeGreaterThan(0);
    }
  });

  it('every file a pattern names actually exists', () => {
    for (const p of FRAUD_PATTERNS) {
      for (const where of p.enforcedIn) {
        const file = where.split(' ')[0];
        if (file.includes('*')) continue; // a directory, not one file
        expect(() => readFileSync(new URL(`../../${file}`, import.meta.url)), `${p.id} → ${file}`).not.toThrow();
      }
    }
  });
});

describe('what it says about the system right now', () => {
  it('the switch reads back what was just set, not what was true at boot', async () => {
    const cookie = await staffLogin(app, 'STF-ADMIN-1');
    await app.inject({ method: 'PUT', url: '/api/safety', headers: { cookie }, payload: { mode: 'actions_paused', reason: 'a dispute rule is under review' } });
    const r = await app.inject({ method: 'GET', url: '/api/safety', headers: { cookie } });
    expect(r.json().mode).toBe('actions_paused');
    expect(r.json().reason).toMatch(/under review/);
    expect(r.json().description).toMatch(/changing nothing/i);
  });

  it('the audit check covers rows written after the page was first opened', async () => {
    const cookie = await staffLogin(app, 'STF-ADMIN-1');
    const before = (await app.inject({ method: 'GET', url: '/api/audit/verify', headers: { cookie } })).json();
    const c = new Caller(app);
    await c.start('S05');
    await c.say('Why was I charged a late fee?');
    const after = (await app.inject({ method: 'GET', url: '/api/audit/verify', headers: { cookie } })).json();
    expect(after.checked).toBeGreaterThan(before.checked);
    expect(after.ok).toBe(true);
    expect(after.head.hash).not.toBe(before.head.hash);
  });

  it('a doctored log is reported as doctored, which is the whole point of showing it', async () => {
    const cookie = await staffLogin(app, 'STF-ADMIN-1');
    run("UPDATE audit_events SET event = 'nothing.happened' WHERE id = (SELECT MIN(id) FROM audit_events)");
    const r = (await app.inject({ method: 'GET', url: '/api/audit/verify', headers: { cookie } })).json();
    expect(r.ok).toBe(false);
    expect(r.problems[0].problem).toBeTruthy();
  });

  it('it never claims the key is held outside the database when it is not', async () => {
    const r = (await get('/api/audit/verify', 'STF-ADMIN-1')).json();
    expect(r.keyAnchor).toBe('database'); // no AUDIT_CHAIN_KEY in tests
  });
});
