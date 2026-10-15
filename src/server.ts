/** Entry point: `npm start`. Migrates, seeds on first run, serves the API and UI. */
import { env } from './config/env.ts';
import { db } from './db/db.ts';
import { isSeeded, seedAll } from './db/seed.ts';
import { buildApp } from './api/app.ts';
import { log } from './lib/logger.ts';
import { purgeExpiredTranscripts } from './reporting/retention.ts';
import { restoreSnapshot, startSnapshots } from './db/snapshot.ts';

const e = env();
// Durable storage: bring back the last saved database before opening it (no-op unless configured).
await restoreSnapshot(e.HIO_DB_PATH);
db(); // open + migrate
if (!isSeeded()) {
  seedAll();
  log.info('seeded synthetic demo data', { db: e.HIO_DB_PATH });
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
