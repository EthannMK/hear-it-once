/**
 * DURABLE STORAGE FOR A SINGLE-INSTANCE DEPLOYMENT.
 *
 * The database is one SQLite file on the container's local disk, which Cloud Run discards on every
 * restart and every new revision. Transcripts, call memory, cases, tickets and agent edits all live
 * in that file, so without this module they vanish with the container.
 *
 * With HIO_BACKUP_BUCKET set, a consistent copy of the database is written to Cloud Storage a few
 * seconds after anything changes and again on shutdown, and the newest copy is restored on start
 * (only when no local file exists yet). HIO_BACKUP_DIR does the same with a local folder, for
 * development and tests. With neither set, nothing changes: the file stays local.
 *
 * Limits, stated plainly: a copy is taken at most every few seconds, so a crash (not a normal
 * shutdown) can lose the last few seconds of writes. Only one instance may run, which the
 * deployment already enforces with --max-instances=1.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { GoogleAuth } from 'google-auth-library';
import { env } from '../config/env.ts';
import { log } from '../lib/logger.ts';

/** Where snapshots are kept. Reads return null when no snapshot exists yet. */
export interface SnapshotStore {
  read(): Promise<Buffer | null>;
  write(data: Buffer): Promise<void>;
  describe(): string;
}

const OBJECT = 'hear-it-once/hio.db';

class FolderStore implements SnapshotStore {
  constructor(private dir: string) {}
  private file = () => join(this.dir, 'hio.db');
  async read() {
    return existsSync(this.file()) ? readFileSync(this.file()) : null;
  }
  async write(data: Buffer) {
    mkdirSync(this.dir, { recursive: true });
    // Write beside the target and rename, so a crash never leaves a half-written snapshot.
    const tmp = `${this.file()}.tmp`;
    writeFileSync(tmp, data);
    const { renameSync } = await import('node:fs');
    renameSync(tmp, this.file());
  }
  describe() {
    return `folder ${this.dir}`;
  }
}

class BucketStore implements SnapshotStore {
  private auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/devstorage.read_write'] });
  constructor(private bucket: string) {}
  async read() {
    const client = await this.auth.getClient();
    try {
      const r = await client.request<ArrayBuffer>({ url: `https://storage.googleapis.com/storage/v1/b/${this.bucket}/o/${encodeURIComponent(OBJECT)}?alt=media`, responseType: 'arraybuffer' });
      return Buffer.from(r.data);
    } catch (e) {
      if ((e as { status?: number; code?: number }).status === 404 || (e as { code?: number }).code === 404) return null;
      throw e;
    }
  }
  async write(data: Buffer) {
    const client = await this.auth.getClient();
    await client.request({
      url: `https://storage.googleapis.com/upload/storage/v1/b/${this.bucket}/o?uploadType=media&name=${encodeURIComponent(OBJECT)}`,
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: data as unknown as string,
    });
  }
  describe() {
    return `bucket gs://${this.bucket}`;
  }
}

/** The store chosen by the environment, or null when durable storage is not configured. */
export function configuredStore(): SnapshotStore | null {
  const e = env();
  if (e.HIO_BACKUP_BUCKET) return new BucketStore(e.HIO_BACKUP_BUCKET);
  if (e.HIO_BACKUP_DIR) return new FolderStore(e.HIO_BACKUP_DIR);
  return null;
}

/** Put the newest snapshot at `dbPath`, but only when there is no local database yet. */
export async function restoreSnapshot(dbPath: string, store: SnapshotStore | null = configuredStore()): Promise<'restored' | 'local_exists' | 'no_snapshot' | 'disabled' | 'failed'> {
  if (!store || dbPath === ':memory:') return 'disabled';
  if (existsSync(dbPath)) return 'local_exists';
  try {
    const data = await store.read();
    if (!data || data.length < 100) return 'no_snapshot';
    mkdirSync(dirname(dbPath), { recursive: true });
    writeFileSync(dbPath, data);
    log.info('database restored from snapshot', { from: store.describe(), bytes: data.length });
    return 'restored';
  } catch (e) {
    // Starting empty (and re-seeding) is better than not starting. The failure is logged loudly.
    log.error('could not restore the database snapshot; starting with a fresh database', { error: (e as Error).message });
    return 'failed';
  }
}

/** A consistent copy of the live database (safe while it is being written), as bytes. */
export function snapshotBytes(d: DatabaseSync): Buffer {
  const tmp = join(tmpdir(), `hio-snap-${process.pid}-${Date.now()}.db`);
  try {
    d.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    return readFileSync(tmp);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export interface Snapshotter {
  /** Save now if anything changed since the last save. */
  flush(): Promise<boolean>;
  stop(): void;
}

/** Save the database a few seconds after it changes, and on demand (shutdown). */
export function startSnapshots(d: DatabaseSync, store: SnapshotStore | null = configuredStore(), everyMs = env().HIO_BACKUP_INTERVAL_MS): Snapshotter {
  if (!store) return { flush: async () => false, stop() {} };
  const changes = () => Number((d.prepare('SELECT total_changes() AS n').get() as { n: number | bigint }).n);
  let saved = -1;
  let busy: Promise<boolean> | null = null;

  const save = async (): Promise<boolean> => {
    const now = changes();
    if (now === saved) return false;
    try {
      await store.write(snapshotBytes(d));
      saved = now;
      return true;
    } catch (e) {
      log.error('database snapshot failed; will retry', { error: (e as Error).message });
      return false;
    }
  };
  const flush = () => (busy ??= save().finally(() => { busy = null; }));
  const timer = setInterval(() => void flush(), everyMs);
  timer.unref();
  log.info('durable storage on', { to: store.describe(), everyMs });
  return { flush, stop: () => clearInterval(timer) };
}
