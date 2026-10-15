/** CRM case workspace API. Staff only; every read and write is permission-checked and audited. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.ts';
import { requirePermission, staffActor } from '../../auth/rbac.ts';
import { caseIdForSession, caseWorkspace, createTicket, customerProfile, decideRecommendation, editCase, listCrmCases, searchCustomers, taxonomy, updateTicket } from '../../crm/crm.ts';

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
    return customerProfile(Id.parse(req.params.id), staffActor(p));
  });

  app.get('/api/crm/cases', async (req) => {
    const p = requirePermission(req.staff, 'case.read');
    return listCrmCases(req.query, staffActor(p));
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
    return caseWorkspace(Id.parse(req.params.id), staffActor(p));
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
