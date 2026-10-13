/** Entry point: `npm start`. Migrates, seeds on first run, serves the API and UI. */
import { env } from './config/env.ts';
import { db } from './db/db.ts';
import { isSeeded, seedAll } from './db/seed.ts';
import { buildApp } from './api/app.ts';
import { log } from './lib/logger.ts';
import { purgeExpiredTranscripts } from './reporting/retention.ts';

const e = env();
db(); // open + migrate
if (!isSeeded()) {
  seedAll();
  log.info('seeded synthetic demo data', { db: e.HIO_DB_PATH });
}
const purged = purgeExpiredTranscripts();
if (purged) log.info('retention purge', { turnsRedacted: purged });

const app = await buildApp();
await app.listen({ port: e.PORT, host: e.HOST });
log.info('Hear It Once (SIMULATED PROTOTYPE) listening', { url: `http://${e.HOST}:${e.PORT}`, policyProfile: e.POLICY_PROFILE, adapterMode: e.ADAPTER_MODE, demoMode: e.DEMO_MODE });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close();
    db().close();
    process.exit(0);
  });
}
