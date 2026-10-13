import { openDb, setDb, migrate } from '../src/db/db.ts';
import { seedAll } from '../src/db/seed.ts';
import { resetClock } from '../src/lib/clock.ts';
import { setPolicyForTests } from '../src/config/policy.ts';
import { setAdapters } from '../src/adapters/registry.ts';

/** Fresh in-memory database with schema + synthetic seed (no illustrative history unless asked). */
export function freshDb(opts: { history?: boolean } = {}) {
  resetClock();
  setPolicyForTests(null);
  setAdapters(null);
  const d = openDb(':memory:');
  setDb(d);
  migrate(d);
  seedAll({ history: opts.history ?? false });
  return d;
}
