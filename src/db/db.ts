/**
 * Persistence layer: SQLite via Node's built-in `node:sqlite` (no native build step).
 * WAL mode + foreign keys. Synchronous API: transactions never span an `await`.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../config/env.ts';

export type Row = Record<string, unknown>;
type Params = Record<string, unknown> | unknown[];

let instance: DatabaseSync | null = null;

export function openDb(path = env().HIO_DB_PATH): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const d = new DatabaseSync(path);
  d.exec('PRAGMA foreign_keys = ON;');
  if (path !== ':memory:') {
    d.exec('PRAGMA journal_mode = WAL;');
    d.exec('PRAGMA synchronous = NORMAL;');
    d.exec('PRAGMA busy_timeout = 5000;');
  }
  return d;
}

export function db(): DatabaseSync {
  if (!instance) {
    instance = openDb();
    migrate(instance);
  }
  return instance;
}

/** Replace the shared connection (tests use a fresh in-memory DB per suite). */
export function setDb(d: DatabaseSync | null): void {
  if (instance && instance !== d) {
    try {
      instance.close();
    } catch {
      /* already closed */
    }
  }
  instance = d;
}

function normalise(params?: Params): SQLInputValue[] | Record<string, SQLInputValue> {
  const conv = (v: unknown): SQLInputValue => {
    if (v === undefined || v === null) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'object' && !(v instanceof Uint8Array)) return JSON.stringify(v);
    return v as SQLInputValue;
  };
  if (!params) return [];
  if (Array.isArray(params)) return params.map(conv);
  return Object.fromEntries(Object.entries(params).map(([k, v]) => [k, conv(v)]));
}

function bind(sql: string, params?: Params) {
  const stmt = db().prepare(sql);
  const p = normalise(params);
  return { stmt, p };
}

export function run(sql: string, params?: Params): { changes: number; lastInsertRowid: number } {
  const { stmt, p } = bind(sql, params);
  const r = Array.isArray(p) ? stmt.run(...p) : stmt.run(p);
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}

export function get<T = Row>(sql: string, params?: Params): T | undefined {
  const { stmt, p } = bind(sql, params);
  return (Array.isArray(p) ? stmt.get(...p) : stmt.get(p)) as T | undefined;
}

export function all<T = Row>(sql: string, params?: Params): T[] {
  const { stmt, p } = bind(sql, params);
  return (Array.isArray(p) ? stmt.all(...p) : stmt.all(p)) as T[];
}

let txDepth = 0;
/** Run fn in a transaction (nested calls use savepoints). fn must be synchronous. */
export function tx<T>(fn: () => T): T {
  const d = db();
  const sp = `sp_${txDepth}`;
  if (txDepth === 0) d.exec('BEGIN IMMEDIATE');
  else d.exec(`SAVEPOINT ${sp}`);
  txDepth++;
  try {
    const out = fn();
    if (out instanceof Promise) throw new Error('tx() callback must be synchronous');
    txDepth--;
    if (txDepth === 0) d.exec('COMMIT');
    else d.exec(`RELEASE ${sp}`);
    return out;
  } catch (e) {
    txDepth--;
    if (txDepth === 0) d.exec('ROLLBACK');
    else d.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw e;
  }
}

export function parseJson<T>(s: unknown, fallback: T): T {
  if (typeof s !== 'string' || s === '') return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export function migrate(d: DatabaseSync = db()): string[] {
  d.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set((d.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map((r) => r.name));
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const done: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
    d.exec('BEGIN');
    try {
      d.exec(sql);
      d.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f, new Date().toISOString());
      d.exec('COMMIT');
      done.push(f);
    } catch (e) {
      d.exec('ROLLBACK');
      throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
    }
  }
  return done;
}
