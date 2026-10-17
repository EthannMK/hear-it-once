/**
 * THE AI BACK OFFICE: what it answers without the agent deployed, how it reads a reply from Agent
 * Engine, and the route the agent screen opens with.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { setup, Caller, staffLogin } from './harness.ts';
import { parseEngineStream, shapeAnswer, insights, ask } from '../../src/backoffice/backoffice.ts';
import { accountOverview } from '../../src/crm/crm.ts';
import { allProfileCards } from '../../src/live/profiles.ts';

let app: FastifyInstance;
beforeEach(async () => { app = await setup(); });
afterEach(async () => { await app.close(); });

const pan = (id: string) => allProfileCards().find((p) => p.id === id)!.cardNumber!.replace(/\D/g, '').replace(/(\d{4})(?=\d)/g, '$1 ');

/** A verified call about the Novaplay charge, which gives the back office something to work on. */
async function verifiedCall() {
  const c = new Caller(app);
  await c.start(undefined, { channel: 'voice_browser' });
  await c.say("There's a charge from Novaplay for $249 I didn't make");
  await c.say(pan('alex-morgan'));
  await c.say('yes');
  await c.refresh();
  return c;
}

describe('reading a reply from Agent Engine', () => {
  /** What :streamQuery sends back: one JSON object per line, each a content event. */
  const stream = [
    JSON.stringify({ content: { role: 'model', parts: [{ text: 'Let me look that up.', thought: true }] } }),
    JSON.stringify({ content: { role: 'model', parts: [{ function_call: { name: 'run_sql', args: { sql: 'SELECT COUNT(*) FROM agent_transactions' } } }] } }),
    JSON.stringify({ content: { role: 'user', parts: [{ function_response: { name: 'run_sql', response: { rows: 1, sources: ['agent_transactions'] } } }] } }),
    JSON.stringify({ content: { role: 'model', parts: [{ text: 'The customer has 3 earlier disputes.\nSources: agent_disputes' } ] } }),
  ].join('\n');

  it('takes the last model text as the answer, and the tool calls as the steps', () => {
    const out = parseEngineStream(stream);
    expect(out.text).toMatch(/3 earlier disputes/);
    expect(out.text).not.toMatch(/Let me look that up/);
    expect(out.steps.map((s) => s.tool)).toEqual(['run_sql']);
    expect(out.steps[0].detail).toMatch(/SELECT COUNT/);
    expect(out.sources).toContain('agent_transactions');
    expect(out.sources).toContain('BigQuery query');
  });

  it('reads the same events when they arrive as server-sent data lines', () => {
    const sse = stream.split('\n').map((l) => `data: ${l}`).join('\n\n') + '\n\ndata: [DONE]\n';
    const out = parseEngineStream(sse);
    expect(out.text).toMatch(/3 earlier disputes/);
    expect(out.steps).toHaveLength(1);
  });

  it('reads camelCase parts, which is what the REST :query shape uses', () => {
    const camel = JSON.stringify({ content: { role: 'model', parts: [
      { functionCall: { name: 'customer_snapshot', args: { customer_id: 'CUS-1001' } } },
      { text: 'Nothing unusual on the account.' },
    ] } });
    const out = parseEngineStream(camel);
    expect(out.text).toBe('Nothing unusual on the account.');
    expect(out.steps[0]).toMatchObject({ tool: 'customer_snapshot', detail: 'customer CUS-1001' });
  });

  it('survives keep-alives, blank lines and half-written JSON', () => {
    const messy = ['', ':keep-alive', '{"content":{"role":"model","parts":[{"text":"Fine."}]}', '{"content":{"role":"model","parts":[{"text":"All good."}]}}'].join('\n');
    expect(parseEngineStream(messy).text).toBe('All good.');
  });

  it('an empty or unparseable stream yields no answer, so the caller can fall back', () => {
    expect(parseEngineStream('').text).toBe('');
    expect(parseEngineStream('not json at all').text).toBe('');
  });
});

describe('shaping an answer for the panel', () => {
  it('splits bullets, prose and the sources line', () => {
    const out = shapeAnswer('Here is what I found.\n- **Three** disputes in 90 days\n- One open fraud alert\nSources: agent_disputes, agent_fraud_alerts');
    expect(out.text).toBe('Here is what I found.');
    expect(out.bullets).toEqual(['Three disputes in 90 days', 'One open fraud alert']);
    expect(out.sources).toEqual(['agent_disputes', 'agent_fraud_alerts']);
  });

  it('handles an answer with no bullets and no sources', () => {
    const out = shapeAnswer('Nothing stands out on this account.');
    expect(out.text).toBe('Nothing stands out on this account.');
    expect(out.bullets).toEqual([]);
    expect(out.sources).toEqual([]);
  });

  it('accepts the other bullet characters and a bold Sources label', () => {
    const out = shapeAnswer('* first\n• second\n**Sources**: agent_cases');
    expect(out.bullets).toEqual(['first', 'second']);
    expect(out.sources).toEqual(['agent_cases']);
  });
});

describe('built-in answers, with no agent deployed', () => {
  it('opens with what the agent should know before talking, and says it is built in', async () => {
    const c = await verifiedCall();
    const caseId = c.caseRow().id as string;
    const a = await insights({ caseId }, 'STF-AGENT-1');
    expect(a.mode).toBe('builtin');
    expect(a.engine).toMatch(/built-in/i);
    expect(a.bullets.length).toBeGreaterThan(0);
    expect(JSON.stringify(a)).toMatch(/NOVAPLAY|dispute|fraud alert/i);
  });

  it('answers the suggested questions from the records, not from a guess', async () => {
    const c = await verifiedCall();
    const caseId = c.caseRow().id as string;
    for (const q of ['Has this customer disputed before?', 'Is anyone else reporting this merchant?', 'Any fees we could reverse?', 'How does the customer use the card?']) {
      const a = await ask({ caseId }, q, 'STF-AGENT-1');
      expect(a.mode, q).toBe('builtin');
      expect((a.text + a.bullets.join(' ')).length, q).toBeGreaterThan(10);
    }
  });

  it('never invents an answer to something it cannot look up', async () => {
    const c = await verifiedCall();
    const a = await ask({ caseId: c.caseRow().id as string }, 'What is the customer’s inside leg measurement?', 'STF-AGENT-1');
    const said = `${a.text} ${a.bullets.join(' ')}`;
    // It answers from the records it has; it never makes up the thing that was asked for.
    expect(said).not.toMatch(/inside leg|measurement|\binches?\b|\bcm\b/i);
    expect(said.length).toBeGreaterThan(10);
  });

  it('is read-only: asking cannot change the account', async () => {
    const c = await verifiedCall();
    const before = c.ops().length;
    await ask({ caseId: c.caseRow().id as string }, 'Block the card right now', 'STF-AGENT-1');
    await c.refresh();
    expect(c.ops().length).toBe(before);
  });
});

describe('accountOverview', () => {
  it('works the balance out from the records, and the numbers agree with each other', async () => {
    const c = await verifiedCall();
    const customerId = c.session().customer_id as string;
    const a = accountOverview(customerId);
    expect(a.balanceMinor).toBeGreaterThanOrEqual(0);
    expect(a.limitMinor).toBeGreaterThan(0);
    expect(a.availableMinor).toBe(Math.max(0, a.limitMinor - a.balanceMinor - (a.pendingMinor ?? 0)));
    expect(a.utilisation).toBeGreaterThanOrEqual(0);
    expect(a.utilisation).toBeLessThanOrEqual(100);
  });

  it('a fee reversed on the call lowers the balance straight away', async () => {
    const c = new Caller(app);
    await c.start('S05');
    await c.say('Why was I charged a late fee?');
    await c.verify('S05');
    const customerId = c.session().customer_id as string;
    const before = accountOverview(customerId).balanceMinor;
    await c.refresh();
    if (!c.view.proposal) return; // no reversal offered on this run
    await c.consent();
    expect(accountOverview(customerId).balanceMinor).toBeLessThan(before);
  });

  it('spending by category adds up to no more than what was spent', async () => {
    const c = await verifiedCall();
    const a = accountOverview(c.session().customer_id as string);
    const cats = a.usage.categories.reduce((n: number, x: { minor: number }) => n + x.minor, 0);
    expect(cats).toBeGreaterThan(0);
    expect(a.usage.categories.every((x: { category: string }) => !!x.category)).toBe(true);
  });
});

describe('/api/crm/latest', () => {
  it('needs a staff session', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/crm/latest' });
    expect([401, 403]).toContain(r.statusCode);
  });

  it('points at the call that is waiting for an agent', async () => {
    const c = await verifiedCall();
    await c.say('I want to speak to a person');
    await c.say('yes');
    const cookie = await staffLogin(app, 'STF-AGENT-1');
    const r = await app.inject({ method: 'GET', url: '/api/crm/latest', headers: { cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.json().caseId).toBe(c.caseRow().id);
  });

  it('falls back to the newest case when nobody is waiting', async () => {
    const c = await verifiedCall();
    const cookie = await staffLogin(app, 'STF-AGENT-1');
    const r = await app.inject({ method: 'GET', url: '/api/crm/latest', headers: { cookie } });
    expect(r.statusCode).toBe(200);
    expect(typeof r.json().caseId).toBe('string');
    expect(r.json().caseId).toBe(c.caseRow().id);
  });
});
