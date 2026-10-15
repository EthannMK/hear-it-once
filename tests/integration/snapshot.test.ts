/**
 * DURABLE STORAGE: the database survives a container restart. A copy is written to the store and the
 * newest copy is restored when the local file is gone. Uses a local folder store (same interface as
 * the Cloud Storage one).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../../src/db/db.ts';
import { restoreSnapshot, startSnapshots, type SnapshotStore } from '../../src/db/snapshot.ts';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'hio-snap-test-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** An in-memory store, so the test needs no disk beyond the database files. */
const memoryStore = (): SnapshotStore & { data: Buffer | null; writes: number } => ({
  data: null, writes: 0,
  async read() { return this.data; },
  async write(b: Buffer) { this.data = b; this.writes++; },
  describe: () => 'memory',
});

describe('durable storage', () => {
  it('restores the last saved database, transcript included, after the local file is lost', async () => {
    const store = memoryStore();
    const a = join(tmp(), 'a.db');
    const d1 = openDb(a);
    d1.exec('CREATE TABLE conversation_turns (id INTEGER PRIMARY KEY, session_id TEXT, speaker TEXT, text TEXT)');
    d1.prepare('INSERT INTO conversation_turns (session_id, speaker, text) VALUES (?,?,?)').run('S1', 'customer', 'I do not recognise a charge on my card.');
    const snaps = startSnapshots(d1, store, 60_000);
    expect(await snaps.flush()).toBe(true);
    snaps.stop();
    d1.close();
    rmSync(a, { force: true }); rmSync(`${a}-wal`, { force: true }); rmSync(`${a}-shm`, { force: true });

    // A new container: no local file, the snapshot is brought back.
    const b = join(tmp(), 'b.db');
    expect(await restoreSnapshot(b, store)).toBe('restored');
    const d2 = new DatabaseSync(b);
    const row = d2.prepare('SELECT speaker, text FROM conversation_turns WHERE session_id = ?').get('S1') as { speaker: string; text: string };
    expect(row).toEqual(expect.objectContaining({ speaker: 'customer', text: 'I do not recognise a charge on my card.' }));
    d2.close();
  });

  it('only saves when something changed, and never overwrites an existing local database', async () => {
    const store = memoryStore();
    const f = join(tmp(), 'c.db');
    const d = openDb(f);
    d.exec('CREATE TABLE t (n INTEGER)');
    const snaps = startSnapshots(d, store, 60_000);
    expect(await snaps.flush()).toBe(true);
    expect(await snaps.flush()).toBe(false); // nothing new
    d.exec('INSERT INTO t VALUES (1)');
    expect(await snaps.flush()).toBe(true);
    expect(store.writes).toBe(2);
    snaps.stop();
    d.close();
    expect(await restoreSnapshot(f, store)).toBe('local_exists');
    expect(existsSync(f)).toBe(true);
  });

  it('starts empty, not broken, when the store cannot be read, and is off when not configured', async () => {
    const broken: SnapshotStore = { read: async () => { throw new Error('storage unavailable'); }, write: async () => undefined, describe: () => 'broken' };
    expect(await restoreSnapshot(join(tmp(), 'd.db'), broken)).toBe('failed');
    expect(await restoreSnapshot(join(tmp(), 'e.db'), memoryStore())).toBe('no_snapshot');
    expect(await restoreSnapshot(join(tmp(), 'f.db'), null)).toBe('disabled');
  });
});
