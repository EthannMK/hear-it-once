/** Entry point: `npm start`. Migrates, seeds on first run, serves the API and UI. */
import { env } from './config/env.ts';
import { db } from './db/db.ts';
import { backfillTxnDetail, isSeeded, seedAll } from './db/seed.ts';
import { sealExistingRows } from './audit/chain.ts';
import { buildApp } from './api/app.ts';
import { log } from './lib/logger.ts';
import { purgeExpiredTranscripts } from './reporting/retention.ts';
import { restoreSnapshot, startSnapshots } from './db/snapshot.ts';
import { adapters } from './adapters/registry.ts';
import { syncReplicaFromBigQuery } from './adapters/bigquery/replica.ts';

const e = env();
// Durable storage: bring back the last saved database before opening it (no-op unless configured).
await restoreSnapshot(e.HIO_DB_PATH);
db(); // open + migrate
if (!isSeeded()) {
  seedAll();
  log.info('seeded synthetic demo data', { db: e.HIO_DB_PATH });
} else {
  // A database saved by an older build has the card-detail columns but no values in them.
  backfillTxnDetail();
}
// Audit rows written before the log was chained are hashed in place, so the chain covers the whole
// log. Verification reports which rows were sealed this way rather than as they were written.
const sealed = sealExistingRows();
if (sealed) log.info('sealed audit rows written before the chain existed', { rows: sealed });
// BigQuery mode: lookups go to BigQuery live; the app's copy of the bank rows is refreshed from it now.
if (e.ADAPTER_MODE === 'bigquery') {
  adapters();
  try {
    await Promise.race([syncReplicaFromBigQuery(), new Promise((_, rej) => setTimeout(() => rej(new Error('timed out after 60 s')), 60_000))]);
  } catch (err) {
    log.warn('could not refresh the local copy from BigQuery; live lookups still use BigQuery', { error: (err as Error).message });
  }
}
const snapshots = startSnapshots(db());
const purged = purgeExpiredTranscripts();
if (purged) log.info('retention purge', { turnsRedacted: purged });

const app = await buildApp();
await app.listen({ port: e.PORT, host: e.HOST });
log.info('Hear It Once (SIMULATED PROTOTYPE) listening', { url: `http://${e.HOST}:${e.PORT}`, policyProfile: e.POLICY_PROFILE, adapterMode: e.ADAPTER_MODE, demoMode: e.DEMO_MODE });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close();
    snapshots.stop();
    await snapshots.flush(); // save the final state before the container goes away
    db().close();
    process.exit(0);
  });
}
