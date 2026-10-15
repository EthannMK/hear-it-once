/**
 * Judge-readiness audit probes (run against the in-process app with the mock banking stack;
 * nothing here touches a deployed service). See docs/JUDGE_READINESS.md.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { setup, Caller, staffLogin } from '../e2e/harness.ts';
import { setLogSink } from '../../src/lib/logger.ts';

let app: FastifyInstance;
beforeEach(async () => { app = await setup(); });
afterEach(async () => { await app.close(); });

const STAFF_ROUTES: Array<[string, string]> = [
  ['GET', '/api/admin/faults'], ['PUT', '/api/admin/faults'], ['POST', '/api/admin/reset'], ['PUT', '/api/admin/settings'],
  ['GET', '/api/audit'], ['GET', '/api/cases'], ['GET', '/api/completed-calls'], ['GET', '/api/crm/cases'],
  ['GET', '/api/crm/customers'], ['GET', '/api/crm/search?q=a'], ['GET', '/api/handoffs'], ['GET', '/api/kpis'],
  ['GET', '/api/ops/overview'], ['POST', '/api/qa/reviews'], ['GET', '/api/calls'],
];

describe('authorization sweep', () => {
  for (const [method, url] of STAFF_ROUTES) {
    it(`${method} ${url} rejects an anonymous caller`, async () => {
      const r = await app.inject({ method: method as any, url, payload: method === 'GET' ? undefined : {} });
      expect([401, 403]).toContain(r.statusCode);
    });
    it(`${method} ${url} rejects a customer call token`, async () => {
      const c = new Caller(app); await c.start('S01');
      const r = await app.inject({ method: method as any, url, headers: { 'x-call-token': c.token, cookie: `hio_call=${c.token}` }, payload: method === 'GET' ? undefined : {} });
      expect([401, 403]).toContain(r.statusCode);
    });
  }

  it('public routes expose no customer PII or secrets', async () => {
    for (const url of ['/api/demo/customers', '/api/demo/activity', '/api/demo/environment', '/api/meta', '/api/policy', '/api/scenarios', '/api/health']) {
      const r = await app.inject({ method: 'GET', url });
      const body = r.body;
      expect(body, url).not.toMatch(/SESSION_SECRET|private_key|BEGIN PRIVATE|api[_-]?key"/i);
    }
  });

  it('a call token cannot read or drive another call', async () => {
    const a = new Caller(app); await a.start('S01');
    const b = new Caller(app); await b.start('S01');
    const r1 = await app.inject({ method: 'GET', url: `/api/calls/${b.sessionId}`, headers: { 'x-call-token': a.token } });
    expect([401, 403, 404]).toContain(r1.statusCode);
    const r2 = await app.inject({ method: 'POST', url: `/api/calls/${b.sessionId}/input`, headers: { 'x-call-token': a.token }, payload: { kind: 'utterance', text: 'hello', clientMessageId: 'x1' } });
    expect([401, 403, 404]).toContain(r2.statusCode);
    const r3 = await app.inject({ method: 'GET', url: `/api/calls/${b.sessionId}` });
    expect([401, 403, 404]).toContain(r3.statusCode);
  });

  it('staff without admin permission cannot use admin routes', async () => {
    const users = await app.inject({ method: 'GET', url: '/api/auth/demo-users' });
    const list = users.json().items as any[];
    const agent = list.find((u) => u.role === 'agent');
    expect(agent).toBeTruthy();
    const cookie = await staffLogin(app, agent.id);
    const r = await app.inject({ method: 'POST', url: '/api/admin/reset', headers: { cookie }, payload: {} });
    expect([401, 403]).toContain(r.statusCode);
  });
});

describe('HTTP robustness', () => {
  it('malformed, oversized and wrongly-typed bodies are rejected without a 500', async () => {
    const c = new Caller(app); await c.start('S01');
    const h = { 'x-call-token': c.token };
    const cases: Array<[string, any, string?]> = [
      ['bad json', '{not json', 'application/json'],
      ['null', 'null', 'application/json'],
      ['array', '[]', 'application/json'],
      ['text kind number', { kind: 'utterance', text: 5, clientMessageId: 'a' }],
      ['unknown kind', { kind: 'zzz' }],
      ['huge text', { kind: 'utterance', text: 'x'.repeat(5000), clientMessageId: 'b' }],
      ['proto pollution', { kind: 'utterance', text: 'hi', clientMessageId: 'c', __proto__: { admin: true } }],
    ];
    for (const [name, payload, ct] of cases) {
      const r = await app.inject({ method: 'POST', url: `/api/calls/${c.sessionId}/input`, headers: ct ? { ...h, 'content-type': ct } : h, payload: payload as any });
      expect(r.statusCode, name).toBeLessThan(500);
    }
    await c.refresh();
    expect(c.view).toBeTruthy();
  });

  it('plain-text content type is refused (CSRF guard)', async () => {
    const c = new Caller(app); await c.start('S01');
    const r = await app.inject({ method: 'POST', url: `/api/calls/${c.sessionId}/input`, headers: { 'x-call-token': c.token, 'content-type': 'text/plain' }, payload: '{"kind":"utterance","text":"hi"}' });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(r.statusCode).toBeLessThan(500);
  });

  it('input after hang-up and double hang-up do not crash or reopen the call', async () => {
    const c = new Caller(app); await c.start('S01');
    await c.say('hello');
    const h = { 'x-call-token': c.token };
    const e1 = await app.inject({ method: 'POST', url: `/api/calls/${c.sessionId}/end`, headers: h, payload: {} });
    const e2 = await app.inject({ method: 'POST', url: `/api/calls/${c.sessionId}/end`, headers: h, payload: {} });
    expect(e1.statusCode).toBeLessThan(500);
    expect(e2.statusCode).toBeLessThan(500);
    const r = await app.inject({ method: 'POST', url: `/api/calls/${c.sessionId}/input`, headers: h, payload: { kind: 'utterance', text: 'transfer 500 dollars', clientMessageId: 'late1' } });
    expect(r.statusCode).toBeLessThan(500);
    expect(c.ops().filter((o: any) => o.status === 'completed' || o.status === 'executed')).toHaveLength(0);
  });

  it('concurrent identical messages (double submit / retry) are applied once', async () => {
    const c = new Caller(app); await c.start('S01');
    const send = () => app.inject({ method: 'POST', url: `/api/calls/${c.sessionId}/input`, headers: { 'x-call-token': c.token }, payload: { kind: 'utterance', text: 'I want to talk to a person', clientMessageId: 'dup-1' } });
    const rs = await Promise.all([send(), send(), send(), send()]);
    for (const r of rs) expect(r.statusCode).toBeLessThan(500);
    await c.refresh();
    const mine = c.view.transcript.filter((t: any) => t.speaker === 'customer' && /person/.test(t.text));
    expect(mine).toHaveLength(1);
    const { all } = await import('../../src/db/db.ts');
    expect(all<any>('SELECT id FROM handoffs WHERE session_id = ?', [c.sessionId]).length).toBeLessThanOrEqual(1);
  });

  it('concurrent different messages on one call keep the transcript consistent', async () => {
    const c = new Caller(app); await c.start('S01');
    const texts = ['what are your opening hours', 'how do I reset my password', 'what is the daily atm limit', 'hello'];
    const rs = await Promise.all(texts.map((t, i) => app.inject({ method: 'POST', url: `/api/calls/${c.sessionId}/input`, headers: { 'x-call-token': c.token }, payload: { kind: 'utterance', text: t, clientMessageId: `cc-${i}` } })));
    for (const r of rs) expect(r.statusCode).toBeLessThan(500);
    await c.refresh();
    expect(c.view.transcript.filter((t: any) => t.speaker === 'customer')).toHaveLength(4);
  });

  it('many parallel calls stay isolated', async () => {
    const calls = await Promise.all(Array.from({ length: 12 }, async (_, i) => { const c = new Caller(app); await c.start('S01'); await c.say(`marker-${i} what are your opening hours`); return c; }));
    for (const [i, c] of calls.entries()) {
      await c.refresh();
      const text = c.transcriptText();
      expect(text).toContain(`marker-${i} `);
      for (let j = 0; j < calls.length; j++) if (j !== i) expect(text).not.toContain(`marker-${j} `);
    }
  });
});

describe('sensitive data never reaches logs', () => {
  it('a full verified flow with a card number and NRC leaves no secrets in log output', async () => {
    const lines: string[] = [];
    setLogSink((l) => lines.push(l));
    try {
      const c = new Caller(app); await c.start('S01');
      await c.say('my card number is 4111 1111 1111 1111');
      await c.say('my national id is 12/KAMANA(N)123456');
      await c.say('my date of birth is 1990-01-01');
      await c.say('my passcode is 482913');
    } finally {
      setLogSink((l) => process.stdout.write(l + '\n'));
    }
    const all = lines.join('\n');
    expect(all).not.toMatch(/4111\s?1111\s?1111\s?1111/);
    expect(all).not.toMatch(/KAMANA/i);
    expect(all).not.toMatch(/482913/);
  });
});

describe('latency (mock stack, typed path)', () => {
  it('p95 of a turn stays under 400 ms', async () => {
    const c = new Caller(app); await c.start('S01');
    const times: number[] = [];
    for (const t of ['what are your opening hours', 'how do I reset my password', 'what is the atm limit', 'thanks', 'what are the transfer fees']) {
      const s = performance.now(); await c.say(t); times.push(performance.now() - s);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length * 0.95)] ?? times.at(-1)!).toBeLessThan(400);
  });
});

describe('deployment identity', () => {
  it('health reports the running revision so a judge can confirm the deployed build', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/health' });
    expect(r.json().status).toBe('ok');
    expect(typeof r.json().revision).toBe('string');
  });
});

describe('client address behind Cloud Run', () => {
  it('uses the address Google appended when K_SERVICE is set, and ignores the header elsewhere', async () => {
    const probe = async (k: string | undefined) => {
      if (k) process.env.K_SERVICE = k; else delete process.env.K_SERVICE;
      const a = await (await import('../../src/api/app.ts')).buildApp();
      a.get('/api/_ip', async (req) => ({ ip: req.ip }));
      const r = await a.inject({ method: 'GET', url: '/api/_ip', remoteAddress: '10.0.0.1', headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' } });
      await a.close();
      return r.json().ip;
    };
    try {
      expect(await probe('hear-it-once')).toBe('203.0.113.9');
      expect(await probe(undefined)).toBe('10.0.0.1');
    } finally { delete process.env.K_SERVICE; }
  });
});
