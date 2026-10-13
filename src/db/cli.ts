/** CLI: npm run db:migrate | db:seed | db:reset */
import { migrate, openDb, setDb } from './db.ts';
import { isSeeded, resetDemoData, seedAll } from './seed.ts';
import { env } from '../config/env.ts';

const cmd = process.argv[2];
const path = env().HIO_DB_PATH;
const d = openDb(path);
setDb(d);
const applied = migrate(d);
switch (cmd) {
  case 'migrate': {
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Schema up to date.', `(${path})`);
    break;
  }
  case 'seed':
    if (isSeeded()) console.log('Already seeded; use "npm run db:reset" to wipe and re-seed synthetic data.');
    else {
      seedAll();
      console.log(`Seeded synthetic demo data into ${path}`);
    }
    break;
  case 'reset':
    resetDemoData();
    console.log(`Reset: synthetic demo data wiped and re-seeded in ${path}`);
    break;
  default:
    console.error('Usage: tsx src/db/cli.ts <migrate|seed|reset>');
    process.exit(1);
}
