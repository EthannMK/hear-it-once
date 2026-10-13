import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDb } from '../helpers.ts';
import { all, get, openDb, setDb, migrate, run } from '../../src/db/db.ts';
import { seedAll, resetDemoData } from '../../src/db/seed.ts';
import { permissionsFor, issueStaffToken, verifyStaffToken, requirePermission } from '../../src/auth/rbac.ts';
import { audit, queryAudit } from '../../src/audit/audit.ts';
import { mockRegistry } from '../../src/adapters/registry.ts';
import { setFault } from '../../src/adapters/mock/faults.ts';
import { containsProhibitedCardData } from '../../src/lib/redact.ts';
import { SCENARIOS } from '../../src/db/scenarios.ts';

const ctx = { correlationId: 'test', customerId: 'CUS-1001' };

describe('persistence', () => {
  it('data survives closing and reopening the database file (restart)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hio-'));
    const path = join(dir, 'persist.db');
    try {
      let d = openDb(path);
      setDb(d);
      migrate(d);
      seedAll({ history: false });
      run("INSERT INTO app_settings (key, value) VALUES ('probe', 'kept')");
      d.close();
      d = openDb(path);
      setDb(d);
      expect(migrate(d)).toEqual([]); // already applied
      expect(get<{ value: string }>("SELECT value FROM app_settings WHERE key='probe'")?.value).toBe('kept');
      expect(get<{ n: number }>('SELECT COUNT(*) n FROM bank_customers')?.n).toBe(SCENARIOS.length);
    } finally {
      setDb(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('seed data', () => {
  beforeEach(() => freshDb());
  it('creates one synthetic customer per scenario and marks them synthetic', () => {
    const rows = all<{ is_synthetic: number }>('SELECT is_synthetic FROM bank_customers');
    expect(rows).toHaveLength(18);
    expect(rows.every((r) => r.is_synthetic === 1)).toBe(true);
  });
  it('contains no full card numbers, CVVs or plaintext DOBs anywhere', () => {
    const tables = all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'");
    for (const { name } of tables) {
      for (const row of all<Record<string, unknown>>(`SELECT * FROM ${name}`)) {
        const text = JSON.stringify(row);
        expect(containsProhibitedCardData(text), `${name}`).toBe(false);
        for (const s of SCENARIOS) expect(text.includes(s.customer.dob), `${name} has plaintext DOB`).toBe(false);
      }
    }
  });
  it('reset wipes demo activity and restores fixtures', () => {
    run("UPDATE bank_cards SET status='blocked' WHERE id='CRD-1001A'");
    resetDemoData({ history: false });
    expect(get<{ status: string }>("SELECT status FROM bank_cards WHERE id='CRD-1001A'")?.status).toBe('active');
  });
});

describe('RBAC (FR-18)', () => {
  beforeEach(() => freshDb());
  it('loads permissions from the database, admin cannot execute banking actions', () => {
    expect(permissionsFor('agent').has('action.request')).toBe(true);
    expect(permissionsFor('admin').has('action.request')).toBe(false);
    expect(permissionsFor('admin').has('action.approve')).toBe(false);
    expect(permissionsFor('qa').has('demo.reset')).toBe(false);
  });
  it('signed staff tokens verify; tampered tokens do not', () => {
    const t = issueStaffToken('STF-QA-1');
    expect(verifyStaffToken(t)?.role).toBe('qa');
    const [p] = t.split('.');
    expect(verifyStaffToken(`${p}.deadbeef`)).toBeNull();
    const forged = Buffer.from(JSON.stringify({ uid: 'STF-ADMIN-1', exp: Date.now() + 1e6 })).toString('base64url');
    expect(verifyStaffToken(`${forged}.${t.split('.')[1]}`)).toBeNull();
    expect(() => requirePermission(verifyStaffToken(t), 'demo.reset')).toThrow(/permission/);
  });
});

describe('audit', () => {
  beforeEach(() => freshDb());
  it('persists redacted metadata', () => {
    audit({ actor: { type: 'system', id: 's' }, event: 'test.event', status: 'ok', metadata: { otp: '999111', note: 'card 4111111111111111' } });
    const { items } = queryAudit({ limit: 10, event: 'test.' });
    expect(JSON.stringify(items)).not.toContain('999111');
    expect(JSON.stringify(items)).not.toContain('4111111111111111');
  });
});

describe('mock adapters', () => {
  beforeEach(() => freshDb());
  it('read adapters return typed data with freshness timestamps', async () => {
    const cards = await mockRegistry.readers.card_status.listCards(ctx, 'CUS-1001');
    expect(cards.data[0]).toMatchObject({ cardRef: 'CRD-1001A', status: 'active' });
    expect(Date.parse(cards.asOf)).not.toBeNaN();
    const tx = await mockRegistry.readers.transactions.listTransactions(ctx, 'CUS-1001', 90);
    expect(tx.data.some((t) => t.merchant === 'NOVAPLAY DIGITAL' && t.amountMinor === 24900)).toBe(true);
  });
  it('fault injection: unavailable source throws, stale source reports old asOf', async () => {
    await expect(mockRegistry.readers.transactions.listTransactions({ ...ctx, customerId: 'CUS-1011' }, 'CUS-1011', 90)).rejects.toThrow(/unavailable/);
    setFault({ scope: 'customer', scopeRef: 'CUS-1001', target: 'card_status', fault: 'stale', enabled: true });
    const r = await mockRegistry.readers.card_status.listCards(ctx, 'CUS-1001');
    expect(Date.now() - Date.parse(r.asOf)).toBeGreaterThan(3600_000);
  });
  it('write adapters are idempotent by key and support lookup', async () => {
    const w = mockRegistry.writers.card_control;
    const a = await w.blockCard(ctx, { cardRef: 'CRD-1001A', reason: 'lost' }, 'k1');
    const b = await w.blockCard(ctx, { cardRef: 'CRD-1001A', reason: 'lost' }, 'k1');
    expect(a.outcome).toBe('succeeded');
    expect(b.externalRef).toBe(a.externalRef);
    expect(get<{ n: number }>("SELECT COUNT(*) n FROM bank_operations WHERE idempotency_key='k1'")?.n).toBe(1);
    expect(await w.lookup(ctx, 'k1')).toMatchObject({ found: true, outcome: 'succeeded' });
    expect(await w.lookup(ctx, 'nope')).toEqual({ found: false });
    const mismatch = await w.blockCard(ctx, { cardRef: 'CRD-1001A', reason: 'stolen' }, 'k1');
    expect(mismatch).toMatchObject({ outcome: 'failed', failureCode: 'IDEMPOTENCY_PAYLOAD_MISMATCH' });
  });
  it('mock write refuses to act on a card the customer does not own', async () => {
    const r = await mockRegistry.writers.card_control.blockCard({ ...ctx, customerId: 'CUS-1002' }, { cardRef: 'CRD-1001A', reason: 'lost' }, 'k2');
    expect(r).toMatchObject({ outcome: 'failed', failureCode: 'CARD_NOT_OWNED' });
  });
});
