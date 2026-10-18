/**
 * The agent's BigQuery views cannot be run from the test suite — only BigQuery can compile them.
 * What can be checked here is the rule they all have to follow.
 *
 * Demo data is put back between calls. Every table written during a call therefore holds rows
 * belonging to customer states that no longer exist, and a view that reads one without filtering
 * on the reset shows the agent history that has been undone. Three views were written without it:
 * the same charge disputed on two demo calls came back as two live disputes, and the agent told a
 * judge exactly that.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RAW = readFileSync(join(process.cwd(), 'agents/backoffice/views.sql'), 'utf8');
/** The statements only. The file's comments name the columns it leaves out, which is not a leak. */
const SQL = RAW.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

/** Tables the app writes to during a call, so anything reading them predates a possible reset. */
const EVENT_TABLES = ['card_status_events', 'fee_reversals', 'dispute_submissions', 'replacement_orders'];

/** Each `CREATE OR REPLACE VIEW ... ;` statement, by view name. */
function views(): { name: string; body: string }[] {
  return SQL.split(/CREATE OR REPLACE VIEW/)
    .slice(1)
    .map((chunk) => {
      const name = chunk.match(/DATASET\.([a-z_]+)`/)?.[1] ?? 'unknown';
      return { name, body: chunk.slice(0, chunk.indexOf(';') + 1) };
    });
}

describe('the agent views', () => {
  it('finds the views', () => {
    expect(views().length).toBeGreaterThan(10);
  });

  it('every view reading a call-written table honours the demo reset', () => {
    const offenders = views()
      .filter((v) => EVENT_TABLES.some((t) => v.body.includes(`DATASET.${t}\``)))
      .filter((v) => !v.body.includes('demo_resets'))
      .map((v) => v.name);
    expect(offenders).toEqual([]);
  });

  it('exposes nothing that identifies a person beyond what an agent needs', () => {
    // These columns exist in the dataset and must never reach the agent's views.
    for (const forbidden of ['pan_sha256', 'dob_hash', 'phone_hash']) {
      expect(SQL).not.toContain(forbidden);
    }
    // and the comments really are only comments
    expect(RAW).toContain('pan_sha256');
  });

  it('reads only from the bank dataset, never writes', () => {
    expect(SQL).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\b/i);
  });
});
