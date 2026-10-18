/** Ending a call, transferring to a person, the full transcript and the post-call analysis. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { setup, Caller, staffLogin } from './harness.ts';
import { all, get, run } from '../../src/db/db.ts';
import { analyseCall, getAnalysis, setAnalysisFaultForTests } from '../../src/analysis/analysis.ts';
import { setMemoryStoreForTests } from '../../src/memory/memory-bank.ts';

let app: FastifyInstance;
beforeEach(async () => { app = await setup(); });
afterEach(async () => { await app.close(); });

async function start() {
  const profile = (await app.inject({ method: 'GET', url: '/api/demo/customers' })).json().items[0];
  const c = new Caller(app);
  await c.start(undefined, { channel: 'voice_browser', profileId: profile.id });
  return { c, pan: profile.cardNumber as string };
}
const get$ = async (c: Caller, path: string) => (await app.inject({ method: 'GET', url: `/api/calls/${c.sessionId}/${path}`, headers: { 'x-call-token': c.token } })).json();

describe('transcript', () => {
  it('returns every segment of a long call in order, with a count', async () => {
    const { c } = await start();
    for (let i = 0; i < 40; i++) await c.say(`what is APR number ${i}`);
    const t = await get$(c, 'transcript');
    expect(t.count).toBe(t.segments.length);
    expect(t.segments.length).toBeGreaterThanOrEqual(40);
    const seqs = t.segments.map((s: any) => s.sequence);
    expect(seqs).toEqual([...seqs].sort((a: number, b: number) => a - b));
    expect(t.segments.some((s: any) => s.text.includes('APR number 0'))).toBe(true);
    expect(t.segments.some((s: any) => s.text.includes('APR number 39'))).toBe(true);
    expect(t.segments.every((s: any) => s.isFinal && s.segmentId && s.timestamp)).toBe(true);
  });
});

describe('ending a call', () => {
  it('saves the transcript, stores a ready analysis, and is safe to repeat', async () => {
    const { c, pan } = await start();
    await c.say('I do not recognise a charge on my card');
    await c.say(pan); await c.say('yes');
    await c.input({ kind: 'hangup' });
    await c.input({ kind: 'hangup' });
    expect(all('SELECT 1 FROM call_analysis WHERE session_id = ?', [c.sessionId])).toHaveLength(1);
    expect(get<any>('SELECT attempts FROM call_analysis WHERE session_id = ?', [c.sessionId]).attempts).toBe(1);
    const a = await get$(c, 'analysis');
    expect(a.status).toBe('ready');
    expect(a.lifecycle).toBe('completed');
    expect(a.reason.label).toMatch(/transaction|charge/i);
    expect(a.summary).toMatch(/verified/i);
    expect(['resolved', 'partially_resolved', 'unresolved']).toContain(a.resolution);
    expect(a.transcriptTurns).toBeGreaterThan(3);
    expect(JSON.stringify(a)).not.toContain(pan.replace(/\D/g, ''));
    expect(get<any>('SELECT 1 x FROM handoffs WHERE session_id = ?', [c.sessionId])).toBeUndefined();
  });

  it('keeps the call when analysis fails, marks it failed, and a retry recovers', async () => {
    const { c } = await start();
    await c.say('what is APR');
    setAnalysisFaultForTests(true);
    await c.input({ kind: 'hangup' });
    setAnalysisFaultForTests(false);
    expect(get<any>('SELECT ended_at FROM call_sessions WHERE id = ?', [c.sessionId]).ended_at).toBeTruthy();
    expect((await get$(c, 'transcript')).count).toBeGreaterThan(1);
    const failed = await get$(c, 'analysis');
    expect(failed.status).toBe('failed');
    const r = await app.inject({ method: 'POST', url: `/api/calls/${c.sessionId}/analysis/retry`, headers: { 'x-call-token': c.token }, payload: {} });
    expect(r.json().status).toBe('ready');
    expect(r.json().attempts).toBe(2);
  });
});

describe('transferring to a person', () => {
  it('moves through transferring to connected, keeps the transcript and does not complete the call', async () => {
    const { c, pan } = await start();
    await c.say('I do not recognise a charge on my card');
    await c.say(pan); await c.say('yes');
    await c.input({ kind: 'request_human' });
    expect((await get$(c, 'analysis')).lifecycle).toBe('transferring');
    expect(get<any>('SELECT ended_at FROM call_sessions WHERE id = ?', [c.sessionId]).ended_at).toBeNull();
    expect(all('SELECT 1 FROM handoffs WHERE session_id = ?', [c.sessionId])).toHaveLength(1);
    await c.input({ kind: 'request_human' });
    expect(all('SELECT 1 FROM handoffs WHERE session_id = ?', [c.sessionId])).toHaveLength(1);
  });

  it('classifies a call waiting for a person as escalated, and a dropped request as unresolved', async () => {
    const { c } = await start();
    await c.say('I want to speak to a person');
    analyseCall(c.sessionId);
    expect((await get$(c, 'analysis')).resolution).toBe('escalated');
    await c.input({ kind: 'hangup' });
    const a = await get$(c, 'analysis');
    expect(a.resolution).toBe('unresolved');
    expect(a.unresolved.join(' ')).toMatch(/asked for a person/);
  });
});

describe('agent workspace', () => {
  it('lists an ended call with its analysis, and the agent can read its full transcript', async () => {
    const { c } = await start();
    await c.say('what is APR');
    await c.input({ kind: 'hangup' });
    const cookie = await staffLogin(app, 'STF-AGENT-1');
    const list = (await app.inject({ method: 'GET', url: '/api/completed-calls', headers: { cookie } })).json();
    const row = list.items.find((i: any) => i.sessionId === c.sessionId);
    expect(row.analysisStatus).toBe('ready');
    const t = (await app.inject({ method: 'GET', url: `/api/calls/${c.sessionId}/transcript`, headers: { cookie } })).json();
    expect(t.complete).toBe(true);
    expect(t.count).toBeGreaterThan(2);
    const anon = await app.inject({ method: 'GET', url: '/api/completed-calls' });
    expect(anon.statusCode).toBeGreaterThanOrEqual(401);
  });
});

/**
 * A memory is a nicety. It must never be able to fail the call record it comes from — an early
 * version of this reached into a table that did not exist and turned every finished call's
 * analysis into a failure.
 */
it('a memory that cannot be written still leaves the call analysis ready', async () => {
  setMemoryStoreForTests({
    async write() { throw new Error('memory bank unreachable'); },
    async list() { throw new Error('memory bank unreachable'); },
    async deleteAll() { throw new Error('memory bank unreachable'); },
  });
  try {
    const c = new Caller(app);
    await c.start();
    await c.say('There is a charge from Novaplay I do not recognise.');
    await c.input({ kind: 'hangup' });
    expect(getAnalysis(c.sessionId).status).toBe('ready');
  } finally {
    setMemoryStoreForTests(null);
  }
});
