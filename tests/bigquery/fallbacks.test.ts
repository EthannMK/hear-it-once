/** BigQuery mode when BigQuery misbehaves: lookups report "unavailable" (never invented data), knowledge falls back. */
import { describe, it, expect, afterEach } from 'vitest';
import { freshDb } from '../helpers.ts';
import { setBigQueryClientForTests, type BqClient } from '../../src/adapters/bigquery/client.ts';
import { bigQueryRegistry } from '../../src/adapters/bigquery/index.ts';
import { bigQueryKnowledgeBase } from '../../src/kb/bigquery-kb.ts';
import { SourceUnavailableError } from '../../src/adapters/types.ts';
import { env, loadEnv } from '../../src/config/env.ts';

const down: BqClient = { project: 'p', dataset: 'd', query: async () => { throw new Error('backend down'); }, insert: async () => { throw new Error('backend down'); } };
const ctx = { correlationId: 't', customerId: 'CUS-1001' };

afterEach(() => setBigQueryClientForTests(null));

describe('BigQuery mode, failure handling', () => {
  it('a failed lookup is reported as unavailable, so the call takes its safe path', async () => {
    freshDb();
    setBigQueryClientForTests(down);
    await expect(bigQueryRegistry.readers.transactions.listTransactions(ctx, 'CUS-1001', 30)).rejects.toBeInstanceOf(SourceUnavailableError);
    await expect(bigQueryRegistry.identity.checkCardNumber(ctx, 'CUS-1001', '1234')).rejects.toThrow();
  });

  it('a failed write is "not received" (safe to retry), never a success', async () => {
    freshDb();
    setBigQueryClientForTests(down);
    await expect(bigQueryRegistry.writers.card_control.blockCard({ ...ctx, sessionId: 's' }, { cardRef: 'CRD-1001A', reason: 'lost' }, 'k1')).rejects.toBeInstanceOf(SourceUnavailableError);
  });

  it('knowledge search falls back to the built-in knowledge base', async () => {
    freshDb();
    setBigQueryClientForTests(down);
    const r = await bigQueryKnowledgeBase.search({ issueType: 'lost_stolen_card', text: 'I lost my card', context: [] });
    expect(r[0].article.id).toBe('KB-102');
  });

  it('BigQuery mode gives lookups and writes more time unless set explicitly', () => {
    const base = { NODE_ENV: 'test', SESSION_SECRET: env().SESSION_SECRET };
    expect(loadEnv({ ...base, ADAPTER_MODE: 'bigquery' })).toMatchObject({ ADAPTER_TIMEOUT_MS: 8000, ACTION_TIMEOUT_MS: 12000 });
    expect(loadEnv({ ...base, ADAPTER_MODE: 'bigquery', ADAPTER_TIMEOUT_MS: '3000' }).ADAPTER_TIMEOUT_MS).toBe(3000);
    expect(loadEnv({ ...base }).ADAPTER_TIMEOUT_MS).toBe(1500);
  });
});
