/** CRM case workspace API. Staff only; every read and write is permission-checked and audited. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.ts';
import { adapters } from '../../adapters/registry.ts';
import { customerHistory } from '../../adapters/bigquery/replica.ts';
import { requirePermission, staffActor } from '../../auth/rbac.ts';
import { audit } from '../../audit/audit.ts';
import { ask, backOfficeEngine, insights } from '../../backoffice/backoffice.ts';
import { caseIdForSession, caseWorkspace, latestCaseId, createTicket, customerProfile, decideRecommendation, editCase, listCrmCases, searchCustomers, taxonomy, updateTicket } from '../../crm/crm.ts';

const Id = z.string().min(3).max(40).regex(/^[A-Za-z0-9_-]+$/);

export function registerCrmRoutes(app: FastifyInstance): void {
  app.get('/api/crm/taxonomy', async (req) => {
    requirePermission(req.staff, 'case.read');
    return taxonomy();
  });

  app.get('/api/crm/customers', async (req) => {
    const p = requirePermission(req.staff, 'case.read');
    const { q } = z.object({ q: z.string().max(120).default('') }).parse(req.query);
    return searchCustomers(q, staffActor(p));
  });

  app.get<{ Params: { id: string } }>('/api/crm/customers/:id', async (req) => {
    const p = requirePermission(req.staff, 'case.read');
    const id = Id.parse(req.params.id);
    const profile = customerProfile(id, staffActor(p));
    // BigQuery mode: add the customer's full account history, read live from BigQuery.
    const history = adapters().mode === 'bigquery' ? await customerHistory(id).catch(() => null) : null;
    return history ? { ...profile, history } : profile;
  });

  /* -------- back-office agent (read-only): insights for a case or customer, and questions */
  const Target = z.object({ caseId: Id.optional(), customerId: Id.optional() }).refine((t) => !!t.caseId !== !!t.customerId, 'Give a caseId or a customerId.');
  app.get('/api/backoffice/status', async (req) => {
    requirePermission(req.staff, 'case.read');
    return { engine: backOfficeEngine() };
  });
  app.get('/api/backoffice/insights', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const p = requirePermission(req.staff, 'case.read');
    const t = Target.parse(req.query);
    return insights(t, p.userId);
  });
  app.post('/api/backoffice/ask', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const p = requirePermission(req.staff, 'case.read');
    const body = z.object({ caseId: Id.optional(), customerId: Id.optional(), question: z.string().min(1).max(500) }).parse(req.body ?? {});
    const t = Target.parse({ caseId: body.caseId, customerId: body.customerId });
    const r = await ask(t, body.question, p.userId);
    audit({ actor: staffActor(p), event: 'backoffice.asked', status: 'ok', resourceType: t.caseId ? 'case' : 'customer', resourceId: (t.caseId ?? t.customerId)!, metadata: { mode: r.mode, ms: r.ms, tools: r.steps.map((s) => s.tool) } });
    return r;
  });

  app.get('/api/crm/cases', async (req) => {
    const p = requirePermission(req.staff, 'case.read');
    return listCrmCases(req.query, staffActor(p));
  });

  /** The case to open when the agent's screen is opened without one (waiting or live call first). */
  app.get('/api/crm/latest', async (req) => {
    requirePermission(req.staff, 'case.read');
    return { caseId: latestCaseId() };
  });

  /** The case for a call (used when a call ends and the page flips to the agent's view). */
  app.get<{ Params: { id: string } }>('/api/crm/calls/:id', async (req) => {
    requirePermission(req.staff, 'case.read');
    const caseId = caseIdForSession(Id.parse(req.params.id));
    if (!caseId) throw new AppError('NOT_FOUND', 'No case was opened for this call yet.');
    return { caseId };
  });

  app.get<{ Params: { id: string } }>('/api/crm/cases/:id', async (req) => {
    const p = requirePermission(req.staff, 'case.read');
    const w = caseWorkspace(Id.parse(req.params.id), staffActor(p));
    // BigQuery mode: the verified customer's full account history, read live from BigQuery.
    const history = adapters().mode === 'bigquery' && w.account && w.customer ? await customerHistory(w.customer.id).catch(() => null) : null;
    return history ? { ...w, history } : w;
  });

  app.patch<{ Params: { id: string } }>('/api/crm/cases/:id', async (req) => {
    const p = requirePermission(req.staff, 'case.update');
    return editCase(Id.parse(req.params.id), { ...staffActor(p), id: p.userId }, req.body ?? {});
  });

  app.post<{ Params: { id: string; kind: string } }>('/api/crm/cases/:id/recommendations/:kind', async (req) => {
    const p = requirePermission(req.staff, 'case.update');
    return decideRecommendation(Id.parse(req.params.id), z.string().max(60).regex(/^[a-z_]+$/).parse(req.params.kind), { ...staffActor(p), id: p.userId }, req.body ?? {});
  });

  app.post<{ Params: { id: string } }>('/api/crm/cases/:id/tickets', async (req, reply) => {
    const p = requirePermission(req.staff, 'case.update');
    const r = createTicket(Id.parse(req.params.id), { ...staffActor(p), id: p.userId }, req.body ?? {});
    reply.code(r.duplicate ? 200 : 201);
    return r;
  });

  app.patch<{ Params: { id: string } }>('/api/crm/tickets/:id', async (req) => {
    const p = requirePermission(req.staff, 'case.update');
    return updateTicket(Id.parse(req.params.id), { ...staffActor(p), id: p.userId }, req.body ?? {});
  });
}
