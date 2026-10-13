/**
 * Demo fault injection for mock adapters. Faults are persisted (mock_faults) so scenarios
 * are repeatable and resettable. Scope: a synthetic customer, a demo scenario, or global.
 */
import { all, run } from '../../db/db.ts';
import type { AdapterContext } from '../types.ts';

export type Fault = 'unavailable' | 'timeout' | 'stale' | 'fail' | 'timeout_after_submit' | 'pending' | 'error';

export function activeFaults(target: string, ctx: Pick<AdapterContext, 'customerId' | 'scenarioId'>): Set<Fault> {
  const rows = all<{ fault: Fault }>(
    `SELECT fault FROM mock_faults WHERE enabled = 1 AND target = ? AND (
       scope = 'global' OR (scope = 'customer' AND scope_ref = ?) OR (scope = 'scenario' AND scope_ref = ?))`,
    [target, ctx.customerId ?? '', ctx.scenarioId ?? ''],
  );
  return new Set(rows.map((r) => r.fault));
}

export function listFaults() {
  return all('SELECT * FROM mock_faults ORDER BY scope, scope_ref, target');
}

export function setFault(input: { scope: 'customer' | 'scenario' | 'global'; scopeRef?: string; target: string; fault: Fault; enabled: boolean; note?: string }): void {
  run(
    `INSERT INTO mock_faults (scope, scope_ref, target, fault, enabled, note) VALUES (?,?,?,?,?,?)
     ON CONFLICT(scope, scope_ref, target, fault) DO UPDATE SET enabled = excluded.enabled, note = COALESCE(excluded.note, mock_faults.note)`,
    [input.scope, input.scopeRef ?? '*', input.target, input.fault, input.enabled ? 1 : 0, input.note ?? null],
  );
}

/** Simulated latency, scaled down in tests. */
export const mockTiming = {
  latencyScale: Number(process.env.MOCK_LATENCY_SCALE ?? (process.env.NODE_ENV === 'test' ? 0.05 : 1)),
  /** How long a "timeout_after_submit" write hangs before replying (must exceed action timeout). */
  hangMs: 10_000,
};

export function simulatedLatency(baseMs: number, jitterMs: number): Promise<void> {
  const ms = Math.round((baseMs + Math.random() * jitterMs) * mockTiming.latencyScale);
  return new Promise((r) => setTimeout(r, ms));
}
