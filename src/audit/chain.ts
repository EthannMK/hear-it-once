/**
 * A TAMPER-EVIDENT AUDIT LOG.
 *
 * An audit log is only worth having if a reader can tell whether it has been edited. Every row here
 * carries a keyed hash of its own contents and of the row before it, so the log is a chain: change a
 * field, delete a row from the middle, or renumber two rows, and every hash after that point stops
 * agreeing. The last hash is also kept outside the table, which is what catches the other obvious
 * attack — deleting rows off the end and leaving a chain that still agrees with itself.
 *
 * The key decides how much this is worth:
 *
 *   AUDIT_CHAIN_KEY set      The key lives in the environment, not in the database. Someone who can
 *                            write to the database cannot recompute the chain, so any edit is
 *                            detectable. This is how it should be run.
 *   AUDIT_CHAIN_KEY unset    A key is generated once and kept in the database next to the log. Edits
 *                            made outside the application — by hand, by a script, by a restore from
 *                            a doctored backup — still show up, because they do not update the
 *                            hashes. Someone who reads the key and recomputes the whole chain would
 *                            not be caught. Verification reports which of the two is in force rather
 *                            than claiming the stronger one.
 *
 * Neither case defends against the application itself being wrong before it writes. That is what the
 * action and policy tests are for. Nor does it defend against losing the database: a real deployment
 * would also copy the head hash somewhere it cannot be rewritten (append-only storage, a log sink,
 * another account), and the head is published by `verifyAuditChain` for exactly that purpose.
 */
import { all, get, run } from '../db/db.ts';
import { env } from '../config/env.ts';
import { hmac, randomDigits, stableStringify } from '../lib/ids.ts';

/** The columns that are hashed, in a fixed order. Anything added to the table must be added here. */
export interface AuditRowForHash {
  id: number;
  ts: string;
  correlation_id: string | null;
  session_id: string | null;
  actor_type: string;
  actor_id: string;
  event: string;
  resource_type: string | null;
  resource_id: string | null;
  status: string;
  metadata_json: string;
  data_origin: string;
}

const HASH_COLUMNS =
  'id, ts, correlation_id, session_id, actor_type, actor_id, event, resource_type, resource_id, status, metadata_json, data_origin, prev_hash, row_hash';

const HEAD_KEY = 'audit_chain_head';
const DB_KEY = 'audit_chain_key';
const SEALED_FROM_KEY = 'audit_chain_sealed_from';

/** The first link. A fixed, public value: the chain's strength is in the key, not in this. */
export const GENESIS = 'northstar-audit-genesis';

let cachedKey: { key: string; external: boolean } | null = null;

/**
 * The key the chain is computed with. Taken from the environment when it is there; otherwise
 * generated once and stored, which is weaker and reported as such.
 */
export function chainKey(): { key: string; external: boolean } {
  if (cachedKey) return cachedKey;
  const fromEnv = env().AUDIT_CHAIN_KEY;
  if (fromEnv) {
    cachedKey = { key: fromEnv, external: true };
    return cachedKey;
  }
  const stored = get<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', [DB_KEY])?.value;
  const key = stored ?? randomDigits(48);
  if (!stored) run('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [DB_KEY, key]);
  cachedKey = { key, external: false };
  return cachedKey;
}

/** Tests swap databases between suites, so the cached key has to go with them. */
export function resetChainKeyForTests(): void {
  cachedKey = null;
}

/** The hash of one row, bound to the row before it. Key-order independent, so it is reproducible. */
export function linkHash(prevHash: string, row: AuditRowForHash): string {
  const canonical = stableStringify({
    id: row.id,
    ts: row.ts,
    correlationId: row.correlation_id ?? null,
    sessionId: row.session_id ?? null,
    actorType: row.actor_type,
    actorId: row.actor_id,
    event: row.event,
    resourceType: row.resource_type ?? null,
    resourceId: row.resource_id ?? null,
    status: row.status,
    metadata: row.metadata_json,
    dataOrigin: row.data_origin,
  });
  return hmac(chainKey().key, `${prevHash}\n${canonical}`);
}

export interface ChainHead {
  id: number;
  hash: string;
  count: number;
}

export function chainHead(): ChainHead | null {
  const raw = get<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', [HEAD_KEY])?.value;
  if (!raw) return null;
  try {
    const h = JSON.parse(raw) as ChainHead;
    return typeof h?.hash === 'string' ? h : null;
  } catch {
    return null;
  }
}

function writeHead(h: ChainHead): void {
  run('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [HEAD_KEY, JSON.stringify(h)]);
}

/**
 * Hash the row that was just inserted and extend the chain. Called inside the same transaction as
 * the insert, so a row and its hash are never visible apart.
 */
export function linkRow(id: number): void {
  const row = get<AuditRowForHash>(`SELECT ${HASH_COLUMNS} FROM audit_events WHERE id = ?`, [id]);
  if (!row) return;
  const head = chainHead();
  const prev = head ? head.hash : GENESIS;
  const hash = linkHash(prev, row);
  run('UPDATE audit_events SET prev_hash = ?, row_hash = ? WHERE id = ?', [prev, hash, id]);
  writeHead({ id, hash, count: (head?.count ?? 0) + 1 });
}

/**
 * Bring a database written before the chain existed under it. The rows are hashed in their existing
 * order and the id they were sealed from is recorded, so verification can say which rows were only
 * sealed after the fact rather than as they were written.
 */
export function sealExistingRows(): number {
  const unchained = all<AuditRowForHash>(`SELECT ${HASH_COLUMNS} FROM audit_events WHERE row_hash IS NULL ORDER BY id ASC`);
  if (!unchained.length) return 0;
  const head = chainHead();
  let prev = head ? head.hash : GENESIS;
  let count = head?.count ?? 0;
  let last = head?.id ?? 0;
  for (const row of unchained) {
    const hash = linkHash(prev, row);
    run('UPDATE audit_events SET prev_hash = ?, row_hash = ? WHERE id = ?', [prev, hash, row.id]);
    prev = hash;
    count += 1;
    last = row.id;
  }
  writeHead({ id: last, hash: prev, count });
  if (!get('SELECT value FROM app_settings WHERE key = ?', [SEALED_FROM_KEY])) {
    run('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [SEALED_FROM_KEY, String(last)]);
  }
  return unchained.length;
}

export interface ChainVerification {
  ok: boolean;
  /** How many rows were checked. */
  checked: number;
  /** The chain's last hash, and the row it belongs to. Worth copying somewhere safe. */
  head: ChainHead | null;
  /** 'environment' when the key is held outside the database, 'database' when it is not. */
  keyAnchor: 'environment' | 'database';
  /** Rows up to and including this id were hashed after they were written, not as they were written. */
  sealedRetroactivelyThrough: number | null;
  /** What went wrong, in the order found. Empty when the log verifies. */
  problems: { id: number | null; problem: string }[];
}

/**
 * Walk the log and check every link. Returns what was checked rather than a bare yes, so a reader
 * can see the difference between "verified" and "there was nothing to verify".
 */
export function verifyAuditChain(): ChainVerification {
  const rows = all<AuditRowForHash & { prev_hash: string | null; row_hash: string | null }>(
    `SELECT ${HASH_COLUMNS} FROM audit_events ORDER BY id ASC`,
  );
  const problems: { id: number | null; problem: string }[] = [];
  const sealedRaw = get<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', [SEALED_FROM_KEY])?.value;
  let prev = GENESIS;
  let checked = 0;

  for (const row of rows) {
    if (row.row_hash === null) {
      problems.push({ id: row.id, problem: 'row carries no hash: it was written without passing through the audit service' });
      continue;
    }
    if (row.prev_hash !== prev) {
      problems.push({ id: row.id, problem: 'does not follow the row before it: a row has been inserted, removed or reordered' });
      // Carry on from what this row claims, so one break does not report every later row as broken.
      prev = row.row_hash;
      checked += 1;
      continue;
    }
    const expected = linkHash(prev, row);
    if (expected !== row.row_hash) problems.push({ id: row.id, problem: 'contents do not match its hash: this row has been edited' });
    prev = row.row_hash;
    checked += 1;
  }

  const head = chainHead();
  if (head && rows.length) {
    const lastHash = rows[rows.length - 1].row_hash;
    if (head.hash !== lastHash) {
      problems.push({ id: null, problem: `the log ends at a different row than the recorded head: ${head.count - rows.length} row(s) appear to have been removed from the end` });
    }
  } else if (head && !rows.length) {
    problems.push({ id: null, problem: `the log is empty but ${head.count} row(s) were recorded: the table has been cleared` });
  }

  return {
    ok: problems.length === 0,
    checked,
    head,
    keyAnchor: chainKey().external ? 'environment' : 'database',
    sealedRetroactivelyThrough: sealedRaw ? Number(sealedRaw) : null,
    problems,
  };
}
