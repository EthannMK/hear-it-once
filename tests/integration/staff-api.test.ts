/** Staff-side API: RBAC on every route, QA review, audit, admin controls, retention. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { setup, Caller, staffLogin } from '../e2e/harness.ts';
import { get, run } from '../../src/db/db.ts';
import { purgeExpiredTranscripts } from '../../src/reporting/retention.ts';
import { advanceClock, resetClock } from '../../src/lib/clock.ts';

let app: FastifyInstance;
beforeEach(async () => {
  app = await setup({ history: true });
});
afterEach(async () => {
  resetClock();
  await app.close();
});

const call = (method: 'GET' | 'POST' | 'PUT', url: string, cookie?: string, payload?: unknown) => app.inject({ method, url, headers: cookie ? { cookie } : {}, payload: payload as Record<string, unknown> | undefined });

describe('RBAC matrix (server-side, not UI hiding)', () => {
  const matrix: [string, 'GET' | 'POST' | 'PUT', string, unknown, Record<string, number>][] = [
    ['kpis', 'GET', '/api/kpis', undefined, { anon: 401, agent: 403, qa: 200, admin: 200 }],
    ['audit', 'GET', '/api/audit', undefined, { anon: 401, agent: 403, qa: 200, admin: 200 }],
    ['handoff queue', 'GET', '/api/handoffs', undefined, { anon: 401, agent: 200, qa: 403, admin: 403 }],
    ['cases', 'GET', '/api/cases', undefined, { anon: 401, agent: 200, qa: 200, admin: 200 }],
    ['reset', 'POST', '/api/admin/reset', { confirm: 'RESET SYNTHETIC DATA' }, { anon: 401, agent: 403, qa: 403, admin: 200 }],
    ['faults', 'GET', '/api/admin/faults', undefined, { anon: 401, agent: 403, qa: 403, admin: 200 }],
    ['policy', 'GET', '/api/policy', undefined, { anon: 401, agent: 403, qa: 200, admin: 200 }],
  ];
  it.each(matrix)('%s', async (_n, method, url, payload, expected) => {
    const cookies: Record<string, string | undefined> = { anon: undefined, agent: await staffLogin(app, 'STF-AGENT-1'), qa: await staffLogin(app, 'STF-QA-1'), admin: await staffLogin(app, 'STF-ADMIN-1') };
    for (const [role, status] of Object.entries(expected)) {
      const r = await call(method, url, cookies[role], payload ?? (method === 'GET' ? undefined : {}));
      expect(r.statusCode, `${role} ${url}`).toBe(status);
    }
  });
  it('a tampered staff cookie is treated as anonymous', async () => {
    const c = await staffLogin(app, 'STF-QA-1');
    expect((await call('GET', '/api/kpis', c.slice(0, -4) + 'abcd')).statusCode).toBe(401);
  });
  it('rejects non-JSON writes (CSRF hardening) and sets security headers', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/demo-login', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'userId=STF-ADMIN-1' });
    expect([400, 415]).toContain(r.statusCode);
    expect(r.cookies.find((c) => c.name === 'hio_staff')).toBeUndefined();
    const t = await app.inject({ method: 'POST', url: '/api/auth/demo-login', headers: { 'content-type': 'text/plain' }, payload: '{"userId":"STF-ADMIN-1"}' });
    expect([400, 415]).toContain(t.statusCode);
    const g = await app.inject({ method: 'GET', url: '/api/health' });
    expect(g.headers['content-security-policy']).toContain("default-src 'self'");
    expect(g.headers['x-frame-options']).toBe('DENY');
    expect(g.headers['cache-control']).toBe('no-store');
  });
  it('errors never leak internals', async () => {
    const r = await call('GET', '/api/calls/SES-DOESNOTEXIST', await staffLogin(app, 'STF-QA-1'));
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Call not found.', details: null } });
  });
});

describe('QA review & audit', () => {
  it('records a QA review that feeds action-correctness and is audited', async () => {
    const c = new Caller(app);
    await c.start('S05');
    await c.say('Why was I charged a late fee?');
    await c.verify('S05');
    await c.consent();
    const qa = await staffLogin(app, 'STF-QA-1');
    const before = (await call('GET', '/api/kpis?origin=demo_session', qa)).json().metrics.find((m: any) => m.id === 'action_correctness');
    expect(before.n).toBe(0);
    const r = await call('POST', '/api/qa/reviews', qa, { sessionId: c.sessionId, actionCorrect: true, score: 95, notes: 'ok' });
    expect(r.statusCode).toBe(200);
    const after = (await call('GET', '/api/kpis?origin=demo_session', qa)).json().metrics.find((m: any) => m.id === 'action_correctness');
    expect(after).toMatchObject({ n: 1, value: 100 });
    expect(get<any>("SELECT COUNT(*) n FROM audit_events WHERE event = 'qa.review_recorded'").n).toBe(1);
    const agent = await staffLogin(app, 'STF-AGENT-1');
    expect((await call('POST', '/api/qa/reviews', agent, { sessionId: c.sessionId })).statusCode).toBe(403);
  });
  it('viewing a case is an audited sensitive read', async () => {
    const qa = await staffLogin(app, 'STF-QA-1');
    const id = get<any>('SELECT id FROM cases LIMIT 1').id;
    expect((await call('GET', `/api/cases/${id}`, qa)).statusCode).toBe(200);
    expect(get<any>("SELECT COUNT(*) n FROM audit_events WHERE event = 'case.viewed' AND resource_id = ?", [id]).n).toBe(1);
  });
  it('pagination returns cursors', async () => {
    const qa = await staffLogin(app, 'STF-QA-1');
    const p1 = (await call('GET', '/api/calls?limit=10', qa)).json();
    expect(p1.items).toHaveLength(10);
    const p2 = (await call('GET', `/api/calls?limit=10&cursor=${encodeURIComponent(p1.nextCursor)}`, qa)).json();
    expect(p2.items[0].id).not.toBe(p1.items[0].id);
  });
});

describe('admin controls', () => {
  it('reset requires the exact confirmation phrase and restores fixtures', async () => {
    const admin = await staffLogin(app, 'STF-ADMIN-1');
    run("UPDATE bank_cards SET status = 'blocked' WHERE id = 'CRD-1002A'");
    expect((await call('POST', '/api/admin/reset', admin, { confirm: 'yes' })).statusCode).toBe(400);
    expect((await call('POST', '/api/admin/reset', admin, { confirm: 'RESET SYNTHETIC DATA' })).statusCode).toBe(200);
    expect(get<any>("SELECT status FROM bank_cards WHERE id = 'CRD-1002A'").status).toBe('active');
  });
  it('simulated downstream dispute review only applies to submitted disputes and is labelled simulated', async () => {
    const c = new Caller(app);
    await c.start('S01');
    await c.say("There's a charge from Novaplay for $249 that I didn't make");
    await c.verify('S01');
    await c.consent();
    const d = get<any>('SELECT id FROM disputes WHERE session_id = ?', [c.sessionId]).id;
    const admin = await staffLogin(app, 'STF-ADMIN-1');
    const r = await call('POST', `/api/admin/disputes/${d}/simulate-review`, admin, { outcome: 'accepted_without_rework' });
    expect(r.json()).toEqual({ ok: true, simulated: true });
    expect(get<any>('SELECT downstream_status, rework_required FROM disputes WHERE id = ?', [d])).toEqual({ downstream_status: 'simulated_accepted_without_rework', rework_required: 0 });
  });
});

describe('retention', () => {
  it('purges transcript text older than the retention window but keeps structured records', async () => {
    const c = new Caller(app);
    await c.start('S04');
    await c.say("I made a payment of $500 but it's not showing");
    advanceClock(31 * 86_400_000);
    expect(purgeExpiredTranscripts(30)).toBeGreaterThan(0);
    expect(get<any>("SELECT COUNT(*) n FROM conversation_turns WHERE session_id = ? AND text != '[purged under retention policy]'", [c.sessionId]).n).toBe(0);
    expect(get('SELECT 1 FROM call_sessions WHERE id = ?', [c.sessionId])).toBeTruthy();
  });
});
