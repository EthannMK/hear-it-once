/**
 * CRM CASE WORKSPACE: customer search, profile, case summary, tags, suggestions, tickets and
 * timeline, all read from the same rows the call writes. Edits persist, are validated and
 * permission-checked, and never run a banking action.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { setup, Caller, staffLogin } from './harness.ts';
import { all, get } from '../../src/db/db.ts';
import { allProfileCards } from '../../src/live/profiles.ts';

let app: FastifyInstance;
let agent = '';
beforeEach(async () => {
  app = await setup();
  agent = await staffLogin(app, 'STF-AGENT-1');
});
afterEach(async () => { await app.close(); });

const pan = (id = 'alex-morgan') => allProfileCards().find((p) => p.id === id)!.cardNumber!.replace(/\D/g, '');
const api = async (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, cookie = agent) => {
  const r = await app.inject({ method, url, payload: payload as object, headers: cookie ? { cookie } : {} });
  return { status: r.statusCode, body: r.json() as any };
};

/** Alex Morgan reports the Novaplay charge, is verified, and is offered the fix (consent pending). */
async function alexCall() {
  const c = new Caller(app);
  await c.start(undefined, { profileId: 'alex-morgan' });
  await c.say("I need help with a charge on my card. It wasn't me. It was Novaplay, $249.");
  await c.say(pan());
  await c.say('yes');
  const caseId = (await api('GET', `/api/crm/calls/${c.sessionId}`)).body.caseId as string;
  return { c, caseId };
}

describe('customer search and profile', () => {
  it('finds customers by name and account reference, and refuses card numbers', async () => {
    const byName = await api('GET', '/api/crm/customers?q=alex');
    expect(byName.status).toBe(200);
    expect(byName.body.items[0].name).toBe('Alex Morgan');
    const ref = byName.body.items[0].accountRef as string;
    expect((await api('GET', `/api/crm/customers?q=${ref}`)).body.items[0].name).toBe('Alex Morgan');
    expect((await api('GET', `/api/crm/customers?q=${pan()}`)).status).toBe(400);
    const recent = await api('GET', '/api/crm/customers');
    expect(recent.body.items.map((i: any) => i.name)).toContain('Jamie Tan');
  });

  it('shows the profile with masked cards, transactions and earlier cases — never a full card number', async () => {
    const id = (await api('GET', '/api/crm/customers?q=alex')).body.items[0].id;
    const p = await api('GET', `/api/crm/customers/${id}`);
    expect(p.status).toBe(200);
    expect(p.body.customer.cards[0].masked).toMatch(/^•••• \d{4}$/);
    expect(p.body.transactions.some((t: any) => t.merchant.toLowerCase().includes('novaplay'))).toBe(true);
    expect(p.body.cases.length).toBeGreaterThan(0); // seeded earlier interaction
    expect(JSON.stringify(p.body)).not.toContain(pan());
    expect((await api('GET', '/api/crm/customers/CUS-NOPE')).status).toBe(404);
  });

  it('requires a signed-in agent', async () => {
    expect((await api('GET', '/api/crm/customers', undefined, '')).status).toBe(401);
  });
});

describe('case workspace built from the call', () => {
  it('summarises the case from recorded facts, separating confirmed facts from what the customer said', async () => {
    const { caseId } = await alexCall();
    const w = (await api('GET', `/api/crm/cases/${caseId}`)).body;
    expect(w.customer.name).toBe('Alex Morgan');
    expect(w.summary.reported).toMatch(/Novaplay/);
    expect(w.summary.verification).toBe('Verified');
    expect(w.summary.transaction).toMatch(/\$249\.00 at .*Novaplay/i);
    const key = Object.fromEntries(w.keyInfo.map((k: any) => [k.key, k.state]));
    expect(key).toMatchObject({ identity: 'ok', card: 'ok', charge: 'ok', dispute: 'ok' });
    const facts = Object.fromEntries(w.facts.map((f: any) => [f.key, f.status]));
    expect(facts.identity).toBe('verified');
    expect(facts.transaction).toBe('confirmed');
    // Tags come from rules over recorded state.
    expect(w.tags.effective).toMatchObject({ category: 'Transaction dispute', issueType: 'Unrecognized transaction', priority: 'high', status: 'awaiting_customer' });
    // Proposed actions are waiting for the customer, not shown as done.
    expect(w.actions.length).toBeGreaterThan(0);
    expect(w.actions.every((a: any) => a.state === 'awaiting_customer')).toBe(true);
    expect(JSON.stringify(w)).not.toContain(pan());
  });

  it('shows completed actions only after the bank system confirmed them, and the same status the caller sees', async () => {
    const { c, caseId } = await alexCall();
    await c.consent('accept');
    const w = (await api('GET', `/api/crm/cases/${caseId}`)).body;
    expect(w.actions.filter((a: any) => a.state === 'completed').length).toBeGreaterThan(0);
    for (const a of w.actions.filter((x: any) => x.state === 'completed')) expect(a.reference).toBeTruthy();
    expect(w.recommendations.map((r: any) => r.kind)).toContain('follow_dispute');
    expect(w.timeline.some((e: any) => /blocked|dispute/i.test(e.title))).toBe(true);
    expect(w.timeline.some((e: any) => e.kind === 'tool' || e.kind === 'voice')).toBe(false);
  });

  it('404s for a case that does not exist', async () => {
    expect((await api('GET', '/api/crm/cases/CASE-NOPE')).status).toBe(404);
  });
});

describe('agent edits', () => {
  it('saves corrected tags and notes, keeps them after reload, and rejects stale or invalid edits', async () => {
    const { caseId } = await alexCall();
    const w0 = (await api('GET', `/api/crm/cases/${caseId}`)).body;
    const ok = await api('PATCH', `/api/crm/cases/${caseId}`, { version: w0.case.version, overrides: { priority: 'urgent', category: 'Card security' }, notes: 'Customer travelling, call back after 5pm.' });
    expect(ok.status).toBe(200);
    const w1 = (await api('GET', `/api/crm/cases/${caseId}`)).body;
    expect(w1.tags.effective.priority).toBe('urgent');
    expect(w1.tags.ai.priority).toBe('high');
    expect(w1.notes).toMatch(/call back/);
    expect(w1.tags.editedBy).toMatch(/Jordan/);
    // Stale version
    expect((await api('PATCH', `/api/crm/cases/${caseId}`, { version: w0.case.version, overrides: { priority: 'normal' } })).status).toBe(409);
    // Value outside the taxonomy
    expect((await api('PATCH', `/api/crm/cases/${caseId}`, { version: w1.case.version, overrides: { priority: 'critical' } })).status).toBe(400);
    // Clearing an override goes back to the rule-based value
    const back = await api('PATCH', `/api/crm/cases/${caseId}`, { version: w1.case.version, overrides: { priority: null } });
    expect(back.body.tags.effective.priority).toBe('high');
    // QA can read but not edit
    const qa = await staffLogin(app, 'STF-QA-1');
    expect((await api('PATCH', `/api/crm/cases/${caseId}`, { version: back.body.case.version, notes: 'x' }, qa)).status).toBe(403);
    expect(all("SELECT * FROM audit_events WHERE event = 'crm.case_edited' AND resource_id = ?", [caseId]).length).toBe(2);
  });

  it('marking the case resolved updates the shared case record', async () => {
    const { caseId } = await alexCall();
    const w = (await api('GET', `/api/crm/cases/${caseId}`)).body;
    await api('PATCH', `/api/crm/cases/${caseId}`, { version: w.case.version, overrides: { status: 'resolved' } });
    expect(get<{ status: string }>('SELECT status FROM cases WHERE id = ?', [caseId])!.status).toBe('resolved');
  });

  it('records accept / reject / edit on a suggestion without running any action', async () => {
    const { caseId, c } = await alexCall();
    const w = (await api('GET', `/api/crm/cases/${caseId}`)).body;
    const kind = w.recommendations[0].kind;
    const opsBefore = c.ops().map((o: any) => o.status).join();
    const r = await api('POST', `/api/crm/cases/${caseId}/recommendations/${kind}`, { decision: 'accept' });
    expect(r.status).toBe(200);
    expect(r.body.recommendations.find((x: any) => x.kind === kind).status).toBe('accepted');
    expect(c.ops().map((o: any) => o.status).join()).toBe(opsBefore);
    const e = await api('POST', `/api/crm/cases/${caseId}/recommendations/${kind}`, { decision: 'edit', text: 'Call the customer back tomorrow first.' });
    expect(e.body.recommendations.find((x: any) => x.kind === kind)).toMatchObject({ status: 'edited', editedText: 'Call the customer back tomorrow first.' });
    expect((await api('POST', `/api/crm/cases/${caseId}/recommendations/${kind}`, { decision: 'edit' })).status).toBe(400);
    expect((await api('POST', `/api/crm/cases/${caseId}/recommendations/not_a_thing`, { decision: 'accept' })).status).toBe(409);
  });
});

describe('tickets', () => {
  it('creates a complaint ticket from the case and never duplicates it', async () => {
    const { caseId } = await alexCall();
    const first = await api('POST', `/api/crm/cases/${caseId}/tickets`, { type: 'complaint', reason: 'Customer unhappy about the charge', requestKey: 'req-complaint-1' });
    expect(first.status).toBe(201);
    const t = first.body.ticket;
    expect(t.id).toMatch(/^TCK-/);
    expect(t).toMatchObject({ type: 'complaint', status: 'open', priority: 'high', team: 'Complaints' });
    expect(t.originalConcern).toMatch(/Novaplay/);
    expect(t.confirmedDetails.join(' ')).toMatch(/\$249\.00/);
    expect(t.evidence.join(' ')).toMatch(/Call transcript/);
    // Same request key (a retry) → same ticket
    const retry = await api('POST', `/api/crm/cases/${caseId}/tickets`, { type: 'complaint', reason: 'Customer unhappy about the charge', requestKey: 'req-complaint-1' });
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ duplicate: true, ticket: { id: t.id } });
    // A second submit with a new key while one is open → still the same ticket
    const again = await api('POST', `/api/crm/cases/${caseId}/tickets`, { type: 'complaint', reason: 'Again', requestKey: 'req-complaint-2' });
    expect(again.body).toMatchObject({ duplicate: true, ticket: { id: t.id } });
    expect(all("SELECT * FROM case_tickets WHERE case_id = ? AND type = 'complaint'", [caseId])).toHaveLength(1);
    // Status moves forward only
    expect((await api('PATCH', `/api/crm/tickets/${t.id}`, { status: 'in_progress' })).status).toBe(200);
    expect((await api('PATCH', `/api/crm/tickets/${t.id}`, { status: 'open' })).status).toBe(409);
    const w = (await api('GET', `/api/crm/cases/${caseId}`)).body;
    expect(w.tickets[0].owner).toMatch(/Jordan/);
    expect(w.timeline.some((e: any) => /Complaint ticket TCK-/.test(e.title))).toBe(true);
  });

  it('a handover creates an escalation ticket automatically; a spoken complaint creates a complaint ticket', async () => {
    const a = new Caller(app);
    await a.start(undefined, { profileId: 'lena-fischer' });
    await a.say('I want to speak to a real person');
    const ta = all<any>('SELECT t.* FROM case_tickets t JOIN cases c ON c.id = t.case_id WHERE c.session_id = ?', [a.sessionId]);
    expect(ta).toHaveLength(1);
    expect(ta[0]).toMatchObject({ type: 'escalation', status: 'open', created_by: 'hear-it-once-assistant' });

    const b = new Caller(app);
    await b.start(undefined, { profileId: 'tom-becker' });
    await b.say('I want to make a formal complaint about how I was treated');
    const tb = all<any>('SELECT t.* FROM case_tickets t JOIN cases c ON c.id = t.case_id WHERE c.session_id = ?', [b.sessionId]);
    expect(tb).toHaveLength(1);
    expect(tb[0]).toMatchObject({ type: 'complaint', team: 'Complaints' });
    const caseId = (await api('GET', `/api/crm/calls/${b.sessionId}`)).body.caseId;
    const w = (await api('GET', `/api/crm/cases/${caseId}`)).body;
    expect(w.tags.effective.status).toBe('escalated');
    expect(w.tags.effective.escalationReason).toBe('Formal complaint');
  });

  it('validates ticket input', async () => {
    const { caseId } = await alexCall();
    expect((await api('POST', `/api/crm/cases/${caseId}/tickets`, { type: 'refund', reason: 'x', requestKey: 'bad' })).status).toBe(400);
    expect((await api('POST', '/api/crm/cases/CASE-NOPE/tickets', { type: 'complaint', reason: 'Valid reason', requestKey: 'req-nope-001' })).status).toBe(404);
  });
});

describe('case list', () => {
  it('puts live and waiting calls first and filters by view', async () => {
    const { caseId } = await alexCall();
    const list = (await api('GET', '/api/crm/cases?view=attention')).body;
    expect(list.items[0].id).toBe(caseId);
    expect(list.items[0].live).toBe(true);
    const resolved = (await api('GET', '/api/crm/cases?view=resolved')).body;
    expect(resolved.items.every((i: any) => i.status === 'resolved')).toBe(true);
    expect((await api('GET', '/api/crm/cases?view=nope')).status).toBe(400);
  });
});
