/** Front-end delivery checks: the journey pages and assets are served and obey the strict CSP (no inline script/style). */
import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { setup } from './harness.ts';

let app: FastifyInstance;
beforeAll(async () => { app = await setup(); });

describe('journey front end', () => {
  it('serves the Lily landing page and assets with a CSP that allows microphone + same-origin websocket', async () => {
    const r = await app.inject({ method: 'GET', url: '/' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('/lily/app.js');
    expect(r.headers['permissions-policy']).toContain('microphone=(self)');
    expect(String(r.headers['content-security-policy'])).toMatch(/connect-src 'self' wss?:/);
    for (const u of ['/lily/app.js', '/lily/audio.js', '/lily/capture-worklet.js', '/lily/lily.css', '/lily/theme-stitch.css', '/agent.html']) expect((await app.inject({ method: 'GET', url: u })).statusCode, u).toBe(200);
  });
  it('has exactly two screens: old pages redirect to the judge page', async () => {
    for (const u of ['/classic.html', '/dashboard.html', '/lab.html']) {
      const r = await app.inject({ method: 'GET', url: u });
      expect(r.statusCode, u).toBe(302);
      expect(r.headers.location).toBe('/');
    }
  });
  it('has no inline scripts, handlers or style attributes in any page', async () => {
    for (const u of ['/', '/agent.html']) {
      const b = (await app.inject({ method: 'GET', url: u })).body;
      expect(b, u).not.toMatch(/<script(?![^>]*\bsrc=)/i);
      expect(b, u).not.toMatch(/\son[a-z]+\s*=/i);
      expect(b, u).not.toMatch(/\sstyle\s*=/i);
    }
  });
  it('the demo customers endpoint lists Northstar Bank profiles with full demo card numbers', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/demo/customers' });
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.bank).toBe('Northstar Bank');
    expect(j.items.length).toBeGreaterThanOrEqual(5);
    for (const c of j.items) expect(String(c.cardNumber).replace(/\D/g, '')).toHaveLength(16);
  });
});
