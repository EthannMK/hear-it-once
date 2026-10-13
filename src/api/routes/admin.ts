/** Admin / developer API: reset synthetic data, mock fault configuration, demo settings. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { run, get } from '../../db/db.ts';
import { nowIso } from '../../lib/clock.ts';
import { AppError } from '../../lib/errors.ts';
import { audit } from '../../audit/audit.ts';
import { requirePermission, staffActor } from '../../auth/rbac.ts';
import { listFaults, setFault } from '../../adapters/mock/faults.ts';
import { resetDemoData } from '../../db/seed.ts';
import { breakers } from '../../retrieval/retrieval.ts';

export function registerAdminRoutes(app: FastifyInstance): void {
  app.post('/api/admin/reset', async (req) => {
    const p = requirePermission(req.staff, 'demo.reset');
    const { confirm } = z.object({ confirm: z.literal('RESET SYNTHETIC DATA') }).strict().parse(req.body);
    void confirm;
    resetDemoData();
    breakers.reset();
    audit({ actor: staffActor(p), event: 'demo.reset', status: 'ok', metadata: { note: 'synthetic demo data wiped and re-seeded' } });
    return { ok: true, resetAt: nowIso() };
  });

  app.get('/api/admin/faults', async (req) => {
    requirePermission(req.staff, 'demo.faults');
    const agents = get<{ value: string }>("SELECT value FROM app_settings WHERE key = 'agents_available'")?.value ?? 'true';
    return { items: listFaults(), settings: { agentsAvailable: agents === 'true' } };
  });

  app.put('/api/admin/faults', async (req) => {
    const p = requirePermission(req.staff, 'demo.faults');
    const body = z
      .object({
        scope: z.enum(['customer', 'scenario', 'global']),
        scopeRef: z.string().max(40).optional(),
        target: z.enum(['customer_profile', 'card_status', 'transactions', 'fraud_alerts', 'prior_cases', 'dispute_rules', 'payment_status', 'fee_policy', 'card_control', 'replacement', 'dispute_intake', 'fee_ledger', 'assistant']),
        fault: z.enum(['unavailable', 'timeout', 'stale', 'fail', 'timeout_after_submit', 'pending', 'error']),
        enabled: z.boolean(),
      })
      .strict()
      .parse(req.body);
    setFault(body);
    breakers.reset();
    audit({ actor: staffActor(p), event: 'demo.fault_configured', status: 'ok', metadata: body });
    return { items: listFaults() };
  });

  app.put('/api/admin/settings', async (req) => {
    const p = requirePermission(req.staff, 'demo.faults');
    const { agentsAvailable } = z.object({ agentsAvailable: z.boolean() }).strict().parse(req.body);
    run("INSERT INTO app_settings (key, value) VALUES ('agents_available', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [String(agentsAvailable)]);
    audit({ actor: staffActor(p), event: 'demo.settings_changed', status: 'ok', metadata: { agentsAvailable } });
    return { agentsAvailable };
  });

  /** SIMULATED downstream dispute review, so the "dispute without rework" metric can be demonstrated. */
  app.post<{ Params: { id: string } }>('/api/admin/disputes/:id/simulate-review', async (req) => {
    const p = requirePermission(req.staff, 'demo.faults');
    const { outcome } = z.object({ outcome: z.enum(['accepted_without_rework', 'rework_required']) }).strict().parse(req.body);
    const d = get<{ status: string }>('SELECT status FROM disputes WHERE id = ?', [req.params.id]);
    if (!d) throw new AppError('NOT_FOUND', 'Dispute not found.');
    if (d.status !== 'submitted') throw new AppError('CONFLICT', 'Only a submitted dispute can receive a (simulated) downstream review.');
    run('UPDATE disputes SET downstream_status = ?, rework_required = ?, updated_at = ? WHERE id = ?', [`simulated_${outcome}`, outcome === 'rework_required' ? 1 : 0, nowIso(), req.params.id]);
    audit({ actor: staffActor(p), event: 'demo.dispute_review_simulated', status: 'ok', resourceType: 'dispute', resourceId: req.params.id, metadata: { outcome } });
    return { ok: true, simulated: true };
  });
}
