/**
 * PARALLEL FACT RETRIEVAL (FR-05, FR-20).
 *
 * Independent reads run concurrently with per-source timeout, bounded retries and a
 * circuit breaker. Each source result records status, latency, attempts and the source's
 * own freshness timestamp, and is persisted to `integration_calls`. Conflicts between
 * sources are detected deterministically. A missing, failed, stale or conflicting
 * required source makes the snapshot unsafe for sensitive writes.
 */
import { adapters } from '../adapters/registry.ts';
import { SourceUnavailableError, type AdapterContext, type CardSummary, type DisputeRule, type FeeData, type FraudAlert, type PaymentRecord, type DeclineRecord, type PriorCase, type CustomerProfile, type Transaction } from '../adapters/types.ts';
import { env } from '../config/env.ts';
import { policy, type IssueType, type SourceName } from '../config/policy.ts';
import { get, parseJson, run } from '../db/db.ts';
import { nowIso, nowMs } from '../lib/clock.ts';
import { newId } from '../lib/ids.ts';
import { CircuitBreakerRegistry, CircuitOpenError, TimeoutError, withRetries, withTimeout } from '../lib/resilience.ts';
import { audit, ASSISTANT } from '../audit/audit.ts';
import { emitTimeline } from '../events/timeline.ts';
import { SOURCE_DISPLAY } from './labels.ts';

export type SourceStatus = 'ok' | 'error' | 'timeout' | 'unavailable' | 'circuit_open';

export interface SourceResult<T = unknown> {
  source: SourceName;
  status: SourceStatus;
  stale: boolean;
  asOf: string | null;
  latencyMs: number;
  attempts: number;
  errorCode: string | null;
  data: T | null;
}

export interface Conflict {
  type: 'card_status_mismatch' | 'amount_mismatch' | 'payment_ledger_mismatch';
  sources: SourceName[];
  ref: string;
  detail: string;
}

export interface SourceDataMap {
  customer_profile: CustomerProfile;
  card_status: CardSummary[];
  transactions: Transaction[];
  fraud_alerts: FraudAlert[];
  prior_cases: PriorCase[];
  dispute_rules: DisputeRule[];
  payment_status: PaymentRecord[];
  fee_policy: FeeData;
  card_declines: DeclineRecord[];
}

export interface Snapshot {
  id: string;
  sessionId: string;
  customerId: string;
  issueType: IssueType | null;
  startedAt: string;
  completedAt: string;
  wallMs: number;
  sumSourceMs: number;
  sources: { [K in SourceName]?: SourceResult<SourceDataMap[K]> };
  conflicts: Conflict[];
}

export const TRANSACTION_LOOKBACK_DAYS = 120;
const SOURCE_SETS: Record<IssueType, SourceName[]> = {
  unrecognised_transaction: ['customer_profile', 'card_status', 'transactions', 'fraud_alerts', 'prior_cases', 'dispute_rules'],
  lost_stolen_card: ['customer_profile', 'card_status', 'transactions', 'fraud_alerts', 'prior_cases', 'dispute_rules'],
  wrong_or_duplicate_charge: ['customer_profile', 'card_status', 'transactions', 'fraud_alerts', 'prior_cases', 'dispute_rules'],
  payment_not_showing: ['customer_profile', 'card_status', 'transactions', 'fraud_alerts', 'prior_cases', 'payment_status'],
  fee_query: ['customer_profile', 'card_status', 'transactions', 'fraud_alerts', 'prior_cases', 'fee_policy', 'payment_status'],
  card_declined: ['customer_profile', 'card_status', 'card_declines', 'fraud_alerts', 'prior_cases'],
  account_inquiry: ['customer_profile', 'card_status', 'transactions', 'prior_cases'],
};
export const sourcesForIssue = (t: IssueType) => SOURCE_SETS[t];

export const breakers = new CircuitBreakerRegistry(() => policy().retrieval.circuitBreaker, nowMs);

function reader(source: SourceName, ctx: AdapterContext, customerId: string): () => Promise<{ data: unknown; asOf: string }> {
  const r = adapters().readers;
  switch (source) {
    case 'customer_profile': return () => r.customer_profile.getProfile(ctx, customerId);
    case 'card_status': return () => r.card_status.listCards(ctx, customerId);
    case 'transactions': return () => r.transactions.listTransactions(ctx, customerId, TRANSACTION_LOOKBACK_DAYS);
    case 'fraud_alerts': return () => r.fraud_alerts.listAlerts(ctx, customerId);
    case 'prior_cases': return () => r.prior_cases.listCases(ctx, customerId, 90);
    case 'dispute_rules': return () => r.dispute_rules.getRules(ctx);
    case 'payment_status': return () => r.payment_status.listPayments(ctx, customerId, 45);
    case 'fee_policy': return () => r.fee_policy.getFeeData(ctx, customerId);
    case 'card_declines': return () => r.card_declines.listDeclines(ctx, customerId, 14);
  }
}

async function readOne(source: SourceName, ctx: AdapterContext, customerId: string): Promise<SourceResult> {
  const start = nowMs();
  const e = env();
  let attempts = 0;
  try {
    const { value } = await withRetries(
      async (n) => {
        attempts = n;
        // Real mode: one breaker per downstream system. Mock mode: faults are injected per synthetic
        // customer, so breakers are also scoped per customer to keep demo scenarios independent.
        const key = adapters().mode === 'mock' ? `${source}:${customerId}` : source;
        return breakers.run(key, () => withTimeout(reader(source, ctx, customerId)(), e.ADAPTER_TIMEOUT_MS));
      },
      {
        retries: e.ADAPTER_READ_RETRIES,
        baseDelayMs: 25,
        retryOn: (err) => !(err instanceof CircuitOpenError) && !(err instanceof SourceUnavailableError && err.code === 'NOT_FOUND'),
      },
    );
    const maxAge = policy().retrieval.maxStalenessSeconds[source] ?? 900;
    const stale = nowMs() - Date.parse(value.asOf) > maxAge * 1000;
    return { source, status: 'ok', stale, asOf: value.asOf, latencyMs: nowMs() - start, attempts, errorCode: stale ? 'STALE' : null, data: value.data };
  } catch (err) {
    const status: SourceStatus =
      err instanceof TimeoutError ? 'timeout' : err instanceof CircuitOpenError ? 'circuit_open' : err instanceof SourceUnavailableError ? (err.code === 'SOURCE_ERROR' ? 'error' : 'unavailable') : 'error';
    const code = err instanceof SourceUnavailableError ? err.code : err instanceof TimeoutError ? 'TIMEOUT' : err instanceof CircuitOpenError ? 'CIRCUIT_OPEN' : 'ERROR';
    return { source, status, stale: false, asOf: null, latencyMs: nowMs() - start, attempts: Math.max(1, attempts), errorCode: code, data: null };
  }
}

/** Deterministic cross-source consistency checks. */
export function detectConflicts(s: Snapshot['sources']): Conflict[] {
  const out: Conflict[] = [];
  const cards = s.card_status?.status === 'ok' ? s.card_status.data ?? [] : null;
  const alerts = s.fraud_alerts?.status === 'ok' ? s.fraud_alerts.data ?? [] : null;
  const txns = s.transactions?.status === 'ok' ? s.transactions.data ?? [] : null;
  const pays = s.payment_status?.status === 'ok' ? s.payment_status.data ?? [] : null;
  if (cards && alerts) {
    for (const a of alerts.filter((x) => x.status === 'open' && x.reportedCardStatus && x.cardRef)) {
      const c = cards.find((x) => x.cardRef === a.cardRef);
      if (c && c.status !== a.reportedCardStatus)
        out.push({ type: 'card_status_mismatch', sources: ['card_status', 'fraud_alerts'], ref: c.cardRef, detail: `Card system reports "${c.status}", fraud system reports "${a.reportedCardStatus}" for card ending ${c.last4}.` });
    }
  }
  if (txns && alerts) {
    for (const a of alerts.filter((x) => x.transactionId && x.reportedAmountMinor != null)) {
      const t = txns.find((x) => x.transactionId === a.transactionId);
      if (t && t.amountMinor !== a.reportedAmountMinor)
        out.push({ type: 'amount_mismatch', sources: ['transactions', 'fraud_alerts'], ref: t.transactionId, detail: `Transaction system amount ${t.amountMinor} differs from fraud system amount ${a.reportedAmountMinor}.` });
    }
  }
  if (txns && pays) {
    for (const p of pays.filter((x) => x.status === 'posted' && x.postedAt)) {
      const posted = Date.parse(p.postedAt!);
      const match = txns.some((t) => t.kind === 'payment' && Math.abs(t.amountMinor) === p.amountMinor && Math.abs(Date.parse(t.transactedAt) - posted) <= 4 * 86_400_000);
      if (!match) out.push({ type: 'payment_ledger_mismatch', sources: ['payment_status', 'transactions'], ref: p.paymentId, detail: 'Payment system reports the payment as posted but no matching credit appears in transaction history.' });
    }
  }
  return out;
}

export async function retrieveFacts(input: { sessionId: string; correlationId: string; scenarioId: string | null; customerId: string; issueType: IssueType; dataOrigin?: string }): Promise<Snapshot> {
  const id = newId('SNAP');
  const startedAt = nowIso();
  const start = nowMs();
  run('INSERT INTO retrieval_snapshots (id, session_id, issue_type, started_at) VALUES (?,?,?,?)', [id, input.sessionId, input.issueType, startedAt]);
  run('UPDATE call_sessions SET retrieval_started_at = COALESCE(retrieval_started_at, ?) WHERE id = ?', [startedAt, input.sessionId]);
  const ctx: AdapterContext = { correlationId: input.correlationId, sessionId: input.sessionId, scenarioId: input.scenarioId, customerId: input.customerId };
  const names = sourcesForIssue(input.issueType);

  emitTimeline(input.sessionId, {
    type: 'systems.queried',
    stage: 'investigate',
    title: `Querying ${names.length} systems in parallel`,
    detail: names.map((n) => SOURCE_DISPLAY[n]).join(' · ') + '. Simulated connectors (mock adapters) — not real bank systems.',
    status: 'running',
    source: 'parallel retrieval',
    ref: id,
    data: { sources: names },
  });
  // Concurrent, independent reads — each reports the moment it finishes.
  const results = await Promise.all(
    names.map((n) =>
      readOne(n, ctx, input.customerId).then((r) => {
        emitTimeline(input.sessionId, {
          type: 'source.completed',
          stage: 'investigate',
          title: `${SOURCE_DISPLAY[n]}: ${r.status === 'ok' ? (r.stale ? 'returned stale data' : 'returned') : r.status.replace('_', ' ')}`,
          detail: `${r.latencyMs} ms · ${r.attempts} attempt${r.attempts === 1 ? '' : 's'}${r.asOf ? ` · data as of ${r.asOf}` : ''}${r.errorCode && r.status !== 'ok' ? ` · ${r.errorCode}` : ''}`,
          status: r.status === 'ok' ? (r.stale ? 'warn' : 'ok') : 'failed',
          source: `${SOURCE_DISPLAY[n]} (simulated)`,
          ref: id,
          data: { source: n, status: r.status, stale: r.stale, latencyMs: r.latencyMs, attempts: r.attempts, startedMs: start },
        });
        return r;
      }),
    ),
  );

  const sources: Snapshot['sources'] = {};
  for (const r of results) (sources as Record<string, SourceResult>)[r.source] = r;
  const conflicts = detectConflicts(sources);
  const completedAt = nowIso();
  const snap: Snapshot = {
    id,
    sessionId: input.sessionId,
    customerId: input.customerId,
    issueType: input.issueType,
    startedAt,
    completedAt,
    wallMs: nowMs() - start,
    sumSourceMs: results.reduce((a, r) => a + r.latencyMs, 0),
    sources,
    conflicts,
  };

  for (const r of results) {
    run(
      `INSERT INTO integration_calls (session_id, snapshot_id, correlation_id, source, operation, direction, status, latency_ms, attempts, source_as_of, stale, error_code, started_at)
       VALUES (?,?,?,?,?, 'read', ?,?,?,?,?,?,?)`,
      [input.sessionId, id, input.correlationId, r.source, 'read', r.status === 'ok' && r.stale ? 'stale' : r.status, r.latencyMs, r.attempts, r.asOf, r.stale ? 1 : 0, r.errorCode, startedAt],
    );
  }
  run('UPDATE retrieval_snapshots SET completed_at = ?, wall_ms = ?, sum_source_ms = ?, conflicts_json = ?, summary_json = ? WHERE id = ?', [
    completedAt, snap.wallMs, snap.sumSourceMs, JSON.stringify(conflicts), JSON.stringify(sources), id,
  ]);
  run('UPDATE call_sessions SET retrieval_completed_at = ? WHERE id = ?', [completedAt, input.sessionId]);
  const bad = results.filter((r) => r.status !== 'ok' || r.stale).length;
  emitTimeline(input.sessionId, {
    type: 'systems.completed',
    stage: 'investigate',
    title: bad ? `${results.length - bad} of ${results.length} systems returned usable data` : `All ${results.length} systems returned`,
    detail: `Finished in ${snap.wallMs} ms; run one after another they would have taken ${snap.sumSourceMs} ms.${conflicts.length ? ` ${conflicts.length} conflict(s) detected.` : ''}`,
    status: bad || conflicts.length ? 'warn' : 'ok',
    source: 'parallel retrieval',
    ref: id,
    data: { wallMs: snap.wallMs, sumSourceMs: snap.sumSourceMs },
  });
  for (const c of conflicts) emitTimeline(input.sessionId, { type: 'systems.conflict', stage: 'investigate', title: 'Systems disagree — no decision will be made on this data', detail: c.detail, status: 'blocked', source: c.sources.join(' vs '), ref: id });
  audit({
    actor: ASSISTANT,
    event: 'source.read_parallel',
    status: results.every((r) => r.status === 'ok') ? 'ok' : 'failed',
    resourceType: 'snapshot',
    resourceId: id,
    sessionId: input.sessionId,
    correlationId: input.correlationId,
    metadata: {
      customerRef: input.customerId,
      sources: results.map((r) => ({ source: r.source, status: r.status, stale: r.stale, latencyMs: r.latencyMs, attempts: r.attempts })),
      wallMs: snap.wallMs,
      sumSourceMs: snap.sumSourceMs,
      conflicts: conflicts.map((c) => c.type),
    },
  });
  return snap;
}

export function loadSnapshot(id: string): Snapshot | null {
  const r = get<Record<string, unknown>>('SELECT * FROM retrieval_snapshots WHERE id = ?', [id]);
  if (!r) return null;
  const sess = get<{ customer_id: string }>('SELECT customer_id FROM call_sessions WHERE id = ?', [r.session_id]);
  return {
    id: String(r.id),
    sessionId: String(r.session_id),
    customerId: sess?.customer_id ?? '',
    issueType: (r.issue_type as IssueType) ?? null,
    startedAt: String(r.started_at),
    completedAt: String(r.completed_at ?? r.started_at),
    wallMs: Number(r.wall_ms ?? 0),
    sumSourceMs: Number(r.sum_source_ms ?? 0),
    sources: parseJson(r.summary_json, {}),
    conflicts: parseJson(r.conflicts_json, []),
  };
}

/** Is a source usable for a decision/write? (ok, not stale) */
export const usable = (r: SourceResult | undefined): boolean => !!r && r.status === 'ok' && !r.stale;

export interface SourceSafety {
  safe: boolean;
  unavailable: SourceName[];
  stale: SourceName[];
  conflicting: Conflict[];
  snapshotTooOld: boolean;
}

/** Check that the required sources are present, fresh and conflict-free. */
export function assessSources(snap: Snapshot, required: SourceName[]): SourceSafety {
  const unavailable = required.filter((s) => !snap.sources[s] || snap.sources[s]!.status !== 'ok');
  const stale = required.filter((s) => snap.sources[s]?.status === 'ok' && snap.sources[s]!.stale);
  const conflicting = snap.conflicts.filter((c) => c.sources.some((s) => required.includes(s)));
  const snapshotTooOld = nowMs() - Date.parse(snap.completedAt) > policy().retrieval.snapshotMaxAgeSeconds * 1000;
  return { safe: !unavailable.length && !stale.length && !conflicting.length && !snapshotTooOld, unavailable, stale, conflicting, snapshotTooOld };
}

export function sourceData<K extends SourceName>(snap: Snapshot, k: K): SourceDataMap[K] | null {
  const r = snap.sources[k] as SourceResult<SourceDataMap[K]> | undefined;
  return r && r.status === 'ok' ? r.data : null;
}
