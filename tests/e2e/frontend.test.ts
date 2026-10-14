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
    for (const u of ['/lily/app.js', '/lily/audio.js', '/lily/capture-worklet.js', '/lily/lily.css', '/lily/theme-stitch.css', '/classic.html', '/agent.html', '/dashboard.html']) expect((await app.inject({ method: 'GET', url: u })).statusCode, u).toBe(200);
  });
  it('has no inline scripts, handlers or style attributes in any page', async () => {
    for (const u of ['/', '/agent.html', '/dashboard.html', '/lab.html', '/classic.html']) {
      const b = (await app.inject({ method: 'GET', url: u })).body;
      expect(b, u).not.toMatch(/<script(?![^>]*\bsrc=)/i);
      expect(b, u).not.toMatch(/\son[a-z]+\s*=/i);
      expect(b, u).not.toMatch(/\sstyle\s*=/i);
    }
  });
  it('the journey data endpoint lists exactly the four scenarios', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/journey/scenarios' });
    expect(r.json().items.map((i: { id: string }) => i.id)).toEqual(['unexpected_charge', 'card_declined', 'fee_question', 'speak_to_human']);
  });
});
