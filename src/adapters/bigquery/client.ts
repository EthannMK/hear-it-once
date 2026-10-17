/**
 * BigQuery access for ADAPTER_MODE=bigquery.
 *
 * Every query is parameterised (no string-built values) and runs in the dataset's location.
 * Authentication is Application Default Credentials: the Cloud Run service account in
 * production, `gcloud auth application-default login` locally. Tests replace the client with an
 * in-memory fake through setBigQueryClientForTests.
 */
import { BigQuery } from '@google-cloud/bigquery';
import { env } from '../../config/env.ts';

/** Values are strings (or string arrays): numbers go into SQL as validated literals, which keeps parameter typing simple. */
export type Params = Record<string, string | string[]>;

export interface BqClient {
  /** Run a read query and return plain rows (timestamps as ISO strings). */
  query<T = Record<string, unknown>>(sql: string, params?: Params): Promise<T[]>;
  /** Append rows to a table (streaming insert: visible to queries straight away). */
  insert(table: string, rows: Record<string, unknown>[]): Promise<void>;
  readonly project: string;
  readonly dataset: string;
}

export function bqConfig() {
  const e = env();
  const project = e.BQ_PROJECT ?? e.GOOGLE_CLOUD_PROJECT ?? '';
  return { project, dataset: e.BQ_DATASET, location: e.BQ_LOCATION, embeddingModel: e.BQ_EMBEDDING_MODEL === 'off' ? '' : e.BQ_EMBEDDING_MODEL };
}

/** Fully qualified table name, back-quoted. Names come from code, never from callers. */
export function T(c: BqClient, table: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(table)) throw new Error(`bad table name ${table}`);
  return `\`${c.project}.${c.dataset}.${table}\``;
}

/** BigQuery returns TIMESTAMP / DATE / DATETIME as wrapper objects; turn them into ISO strings. */
function plain(v: unknown): unknown {
  if (v && typeof v === 'object') {
    if ('value' in (v as object) && Object.keys(v as object).length === 1 && typeof (v as { value: unknown }).value === 'string') {
      const raw = (v as { value: string }).value;
      if (raw.length === 10) return raw; // DATE
      const d = new Date(/Z$|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`);
      return Number.isNaN(d.getTime()) ? raw : d.toISOString();
    }
    if (Array.isArray(v)) return v.map(plain);
    if (Buffer.isBuffer(v)) return v;
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, plain(x)]));
  }
  return v;
}

class RealClient implements BqClient {
  private readonly bq: BigQuery;
  constructor(readonly project: string, readonly dataset: string, private readonly location: string, endpoint?: string) {
    this.bq = endpoint
      ? // Local emulator: no Google credentials involved.
        new BigQuery({ projectId: project, location, apiEndpoint: endpoint, authClient: { getRequestHeaders: async () => ({}), getClient: async () => ({}), getProjectId: async () => project } as never })
      : new BigQuery({ projectId: project, location });
  }
  async query<T>(sql: string, params: Params = {}): Promise<T[]> {
    // Declare parameter types explicitly (all values are strings or string arrays) instead of letting the client guess.
    const types = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, Array.isArray(v) ? ['STRING'] : 'STRING']));
    const [rows] = await this.bq.query({ query: sql, params, types, location: this.location, useQueryCache: true, jobTimeoutMs: 20_000 });
    return rows.map((r) => plain(r) as T);
  }
  async insert(table: string, rows: Record<string, unknown>[]): Promise<void> {
    if (!rows.length) return;
    await this.bq.dataset(this.dataset).table(table).insert(rows, { ignoreUnknownValues: false, skipInvalidRows: false });
  }
}

let override: BqClient | null = null;
let real: BqClient | null = null;

export function bigQuery(): BqClient {
  if (override) return override;
  if (real) return real;
  const c = bqConfig();
  if (!c.project) throw new Error('ADAPTER_MODE=bigquery needs BQ_PROJECT or GOOGLE_CLOUD_PROJECT.');
  real = new RealClient(c.project, c.dataset, c.location, env().BQ_API_ENDPOINT);
  return real;
}

export function setBigQueryClientForTests(c: BqClient | null): void {
  override = c;
}
