/**
 * THE AUDIT LOG IS TAMPER-EVIDENT.
 *
 * Each test edits the log the way someone covering their tracks would — change a field, remove a
 * row, add one by hand, clear the table — and then asks the verifier whether the log is intact. A
 * passing suite means the answer is no in every case, and yes when the log has been left alone.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { freshDb } from '../helpers.ts';
import { setup, Caller, staffLogin } from '../e2e/harness.ts';
import { audit, SYSTEM, ASSISTANT } from '../../src/audit/audit.ts';
import { verifyAuditChain, chainHead, GENESIS, sealExistingRows } from '../../src/audit/chain.ts';
import { all, get, run } from '../../src/db/db.ts';

/** A handful of rows, written the only way the application writes them. */
function writeSome(n = 5) {
  for (let i = 0; i < n; i++) {
    audit({ actor: i % 2 ? SYSTEM : ASSISTANT, event: `test.event_${i}`, status: 'ok', sessionId: `CALL-${i}`, metadata: { i } });
  }
}

describe('a log nobody has touched', () => {
  beforeEach(() => freshDb());

  it('verifies, and says how many rows it checked', () => {
    writeSome();
    const v = verifyAuditChain();
    expect(v.ok).toBe(true);
    expect(v.problems).toEqual([]);
    expect(v.checked).toBeGreaterThanOrEqual(5);
    expect(v.head?.count).toBe(v.checked);
  });

  it('starts from a known first link, so the first row is covered too', () => {
    writeSome(1);
    const first = all<{ prev_hash: string }>('SELECT prev_hash FROM audit_events ORDER BY id ASC LIMIT 1')[0];
    expect(first.prev_hash).toBe(GENESIS);
  });

  it('every row carries a hash, and no two rows share one', () => {
    writeSome(8);
    const hashes = all<{ row_hash: string | null }>('SELECT row_hash FROM audit_events').map((r) => r.row_hash);
    expect(hashes.some((h) => h === null)).toBe(false);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('an empty log verifies rather than failing, and says nothing was checked', () => {
    const v = verifyAuditChain();
    expect(v.ok).toBe(true);
    expect(v.checked).toBe(0);
  });
});

describe('a log somebody has edited', () => {
  beforeEach(() => freshDb());

  it('notices a changed field', () => {
    writeSome();
    const target = get<{ id: number }>('SELECT id FROM audit_events ORDER BY id ASC LIMIT 1 OFFSET 2')!;
    run("UPDATE audit_events SET status = 'ok', event = 'nothing.happened' WHERE id = ?", [target.id]);
    const v = verifyAuditChain();
    expect(v.ok).toBe(false);
    expect(v.problems[0]).toMatchObject({ id: target.id });
    expect(v.problems[0].problem).toMatch(/edited/);
  });

  it('notices a denied action quietly re-recorded as allowed', () => {
    audit({ actor: ASSISTANT, event: 'action.rejected', status: 'denied', sessionId: 'CALL-9', metadata: { reason: 'VERIFICATION_REQUIRED' } });
    const id = get<{ id: number }>('SELECT id FROM audit_events ORDER BY id DESC LIMIT 1')!.id;
    run("UPDATE audit_events SET status = 'ok' WHERE id = ?", [id]);
    expect(verifyAuditChain().ok).toBe(false);
  });

  it('notices a row removed from the middle', () => {
    writeSome();
    const target = get<{ id: number }>('SELECT id FROM audit_events ORDER BY id ASC LIMIT 1 OFFSET 2')!;
    run('DELETE FROM audit_events WHERE id = ?', [target.id]);
    const v = verifyAuditChain();
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => /inserted, removed or reordered/.test(p.problem))).toBe(true);
  });

  it('notices rows removed from the end, which the chain alone would not catch', () => {
    writeSome(6);
    const before = chainHead()!;
    run('DELETE FROM audit_events WHERE id >= (SELECT MAX(id) - 1 FROM audit_events)');
    const v = verifyAuditChain();
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => /removed from the end/.test(p.problem))).toBe(true);
    // The remaining rows still agree with each other; it is the head that gives it away.
    expect(before.count).toBeGreaterThan(all('SELECT id FROM audit_events').length);
  });

  it('notices the whole table being cleared', () => {
    writeSome();
    run('DELETE FROM audit_events');
    const v = verifyAuditChain();
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => /cleared/.test(p.problem))).toBe(true);
  });

  it('notices a row added without going through the audit service', () => {
    writeSome(2);
    run(
      `INSERT INTO audit_events (ts, actor_type, actor_id, event, status, metadata_json, data_origin)
       VALUES (?,?,?,?,?,?,?)`,
      ['2026-01-01T00:00:00.000Z', 'admin', 'STF-9', 'action.approved', 'ok', '{}', 'demo_session'],
    );
    const v = verifyAuditChain();
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => /no hash/.test(p.problem))).toBe(true);
  });

  it('notices a row forged with a plausible hash copied from another row', () => {
    writeSome(3);
    const rows = all<{ id: number; row_hash: string; prev_hash: string }>('SELECT id, row_hash, prev_hash FROM audit_events ORDER BY id ASC');
    run('UPDATE audit_events SET event = ?, row_hash = ?, prev_hash = ? WHERE id = ?', ['action.approved', rows[2].row_hash, rows[2].prev_hash, rows[1].id]);
    expect(verifyAuditChain().ok).toBe(false);
  });

  it('notices two rows swapped into each other’s place', () => {
    writeSome(4);
    const rows = all<{ id: number; event: string }>('SELECT id, event FROM audit_events ORDER BY id ASC');
    run('UPDATE audit_events SET event = ? WHERE id = ?', [rows[2].event, rows[1].id]);
    run('UPDATE audit_events SET event = ? WHERE id = ?', [rows[1].event, rows[2].id]);
    expect(verifyAuditChain().ok).toBe(false);
  });

  it('reports one problem per broken row, not one per row after the break', () => {
    writeSome(20);
    const target = get<{ id: number }>('SELECT id FROM audit_events ORDER BY id ASC LIMIT 1 OFFSET 3')!;
    run("UPDATE audit_events SET event = 'nothing.happened' WHERE id = ?", [target.id]);
    expect(verifyAuditChain().problems).toHaveLength(1);
  });
});

describe('what the verifier admits about itself', () => {
  beforeEach(() => freshDb());

  it('says where the key is held, and in tests that is the database', () => {
    writeSome(1);
    // No AUDIT_CHAIN_KEY is set in the test environment, so the verifier must not claim the
    // stronger of the two positions.
    expect(verifyAuditChain().keyAnchor).toBe('database');
  });

  it('publishes the head so it can be copied somewhere that cannot be rewritten', () => {
    writeSome(3);
    const v = verifyAuditChain();
    expect(v.head?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(v.head?.id).toBeGreaterThan(0);
  });

  it('seals rows that were written before the chain existed, and says it did', () => {
    writeSome(3);
    // A database from an older build: rows are there, hashes are not.
    run('UPDATE audit_events SET row_hash = NULL, prev_hash = NULL');
    run("DELETE FROM app_settings WHERE key = 'audit_chain_head'");
    expect(verifyAuditChain().ok).toBe(false);

    expect(sealExistingRows()).toBe(3);
    const v = verifyAuditChain();
    expect(v.ok).toBe(true);
    expect(v.sealedRetroactivelyThrough).toBeGreaterThan(0);
  });

  it('keeps verifying as the log grows after a seal', () => {
    writeSome(2);
    run('UPDATE audit_events SET row_hash = NULL, prev_hash = NULL');
    run("DELETE FROM app_settings WHERE key = 'audit_chain_head'");
    sealExistingRows();
    writeSome(2);
    expect(verifyAuditChain().ok).toBe(true);
  });
});

describe('through the API', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await setup(); });
  afterEach(async () => { await app.close(); });

  it('a real call produces a log that verifies', async () => {
    const c = new Caller(app);
    await c.start('S05');
    await c.say('Why was I charged a late fee?');
    await c.verify('S05');
    expect(verifyAuditChain().ok).toBe(true);
    expect(verifyAuditChain().checked).toBeGreaterThan(3);
  });

  it('/api/audit/verify needs the audit permission', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/audit/verify' });
    expect([401, 403]).toContain(r.statusCode);
    const agent = await staffLogin(app, 'STF-AGENT-1'); // an agent has no audit.read
    const r2 = await app.inject({ method: 'GET', url: '/api/audit/verify', headers: { cookie: agent } });
    expect(r2.statusCode).toBe(403);
  });

  it('reports a clean log to whoever is allowed to ask', async () => {
    const cookie = await staffLogin(app, 'STF-ADMIN-1');
    const r = await app.inject({ method: 'GET', url: '/api/audit/verify', headers: { cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.json().ok).toBe(true);
    expect(r.json().head.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reports a doctored log through the same route', async () => {
    const cookie = await staffLogin(app, 'STF-ADMIN-1');
    run("UPDATE audit_events SET event = 'nothing.happened' WHERE id = (SELECT MIN(id) FROM audit_events)");
    const r = await app.inject({ method: 'GET', url: '/api/audit/verify', headers: { cookie } });
    expect(r.json().ok).toBe(false);
    expect(r.json().problems.length).toBeGreaterThan(0);
  });

  it('verifying does not itself write to the log', async () => {
    const cookie = await staffLogin(app, 'STF-ADMIN-1');
    const before = all('SELECT id FROM audit_events').length;
    await app.inject({ method: 'GET', url: '/api/audit/verify', headers: { cookie } });
    expect(all('SELECT id FROM audit_events').length).toBe(before);
  });
});
