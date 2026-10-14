/** Staff API: demo sign-in, agent console, cases, calls, audit, KPIs, QA review. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.ts';
import { policy } from '../../config/policy.ts';
import { PILOT_TARGETS } from '../../config/targets.ts';
import { get, run, all } from '../../db/db.ts';
import { nowIso } from '../../lib/clock.ts';
import { AppError } from '../../lib/errors.ts';
import { audit } from '../../audit/audit.ts';
import { queryAudit } from '../../audit/audit.ts';
import { issueStaffToken, listStaffUsers, requirePermission, staffActor } from '../../auth/rbac.ts';
import { getCaseDetail } from '../../cases/case-service.ts';
import { acceptHandoff, agentMessage, completeHandoff, getHandoff, listHandoffs } from '../../handoff/handoff-service.ts';
import { approveAction, getOp, opHistory, reconcile, rejectApproval } from '../../actions/action-service.ts';
import { computeKpis, KpiFilterSchema } from '../../reporting/kpi.ts';
import { buildCallView, listCalls, listCases, opsOverview } from '../views.ts';
import { STAFF_COOKIE } from '../app.ts';

const Page = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25), cursor: z.string().max(64).optional() });

export function registerStaffRoutes(app: FastifyInstance): void {
  /* ---------------------------------------------------------------- demo authentication */
  app.get('/api/auth/demo-users', async () => ({ items: listStaffUsers(), note: 'Demo role selection — NOT production authentication.' }));

  app.post('/api/auth/demo-login', { config: { rateLimit: { max: env().NODE_ENV === 'test' ? 10_000 : 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { userId } = z.object({ userId: z.string().max(40) }).strict().parse(req.body);
    const u = get<{ id: string; role: string }>('SELECT id, role FROM staff_users WHERE id = ?', [userId]);
    if (!u) throw new AppError('UNAUTHENTICATED', 'Unknown demo user.');
    reply.setCookie(STAFF_COOKIE, issueStaffToken(u.id), { httpOnly: true, sameSite: 'strict', path: '/', secure: env().NODE_ENV === 'production', maxAge: 8 * 3600 });
    audit({ actor: { type: u.role as 'agent', id: u.id }, event: 'auth.demo_login', status: 'ok' });
    return { userId: u.id, role: u.role };
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(STAFF_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    if (!req.staff) return { authenticated: false };
    return { authenticated: true, userId: req.staff.userId, role: req.staff.role, displayName: req.staff.displayName, permissions: [...req.staff.permissions] };
  });

  /* ---------------------------------------------------------------- agent console */
  app.get('/api/handoffs', async (req) => {
    requirePermission(req.staff, 'handoff.read');
    const { status } = z.object({ status: z.enum(['requested', 'queued', 'connected', 'completed', 'no_agent', 'failed', 'cancelled']).optional() }).parse(req.query);
    return { items: listHandoffs(status) };
  });

  app.get<{ Params: { id: string } }>('/api/handoffs/:id', async (req) => {
    const p = requirePermission(req.staff, 'handoff.read');
    const h = getHandoff(req.params.id);
    if (!h) throw new AppError('NOT_FOUND', 'Handoff not found.');
    audit({ actor: staffActor(p), event: 'handoff.brief_viewed', status: 'ok', resourceType: 'handoff', resourceId: req.params.id, sessionId: String(h.session_id) });
    return { handoff: h, call: buildCallView(String(h.session_id), { audience: 'staff' }), case: h.case_id ? getCaseDetail(String(h.case_id)) : null };
  });

  app.post<{ Params: { id: string } }>('/api/handoffs/:id/accept', async (req) => {
    const p = requirePermission(req.staff, 'handoff.accept');
    return acceptHandoff(req.params.id, { ...staffActor(p), id: p.userId });
  });

  app.post<{ Params: { id: string } }>('/api/handoffs/:id/message', async (req) => {
    const p = requirePermission(req.staff, 'handoff.message');
    const { text } = z.object({ text: z.string().min(1).max(1000) }).strict().parse(req.body);
    agentMessage(req.params.id, staffActor(p), text);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/handoffs/:id/complete', async (req) => {
    const p = requirePermission(req.staff, 'handoff.complete');
    const body = z.object({ outcome: z.enum(['resolved', 'unresolved', 'follow_up_required']), notes: z.string().max(2000).default(''), customerRepeatedIssue: z.boolean().default(false) }).strict().parse(req.body);
    return completeHandoff(req.params.id, staffActor(p), body);
  });

  app.post<{ Params: { id: string } }>('/api/actions/:id/approve', async (req) => {
    const p = requirePermission(req.staff, 'action.approve');
    const op = getOp(req.params.id);
    if (!op) throw new AppError('NOT_FOUND', 'Operation not found.');
    const r = await approveAction(op.id, staffActor(p), get<{ correlation_id: string }>('SELECT correlation_id FROM call_sessions WHERE id = ?', [op.session_id])!.correlation_id);
    return { ...r, history: opHistory(r.id) };
  });

  app.post<{ Params: { id: string } }>('/api/actions/:id/reject', async (req) => {
    const p = requirePermission(req.staff, 'action.approve');
    const { reason } = z.object({ reason: z.string().min(3).max(200) }).strict().parse(req.body);
    return rejectApproval(req.params.id, staffActor(p), 'agent-console', reason);
  });

  app.post<{ Params: { id: string } }>('/api/actions/:id/reconcile', async (req) => {
    const p = requirePermission(req.staff, 'action.reconcile');
    const r = await reconcile(req.params.id, staffActor(p), 'agent-console');
    return { ...r, history: opHistory(r.id) };
  });

  /* ---------------------------------------------------------------- cases & calls */
  app.get('/api/cases', async (req) => {
    const p = requirePermission(req.staff, 'case.read');
    const q = Page.extend({ status: z.string().max(20).optional(), issueType: z.string().max(40).optional() }).parse(req.query);
    audit({ actor: staffActor(p), event: 'case.list_viewed', status: 'ok', metadata: { filters: q } });
    return listCases(q);
  });

  app.get<{ Params: { id: string } }>('/api/cases/:id', async (req) => {
    const p = requirePermission(req.staff, 'case.read');
    const c = getCaseDetail(req.params.id);
    if (!c) throw new AppError('NOT_FOUND', 'Case not found.');
    audit({ actor: staffActor(p), event: 'case.viewed', status: 'ok', resourceType: 'case', resourceId: req.params.id, sessionId: String(c.session_id) });
    return c;
  });

  app.get('/api/calls', async (req) => {
    const p = requirePermission(req.staff, 'call.read');
    const q = Page.extend({ from: z.string().max(40).optional(), to: z.string().max(40).optional(), issueType: z.string().max(40).optional(), outcome: z.string().max(40).optional(), origin: z.enum(['demo_session', 'seeded_illustrative']).optional() }).parse(req.query);
    audit({ actor: staffActor(p), event: 'call.list_viewed', status: 'ok' });
    return listCalls(q);
  });

  /* ---------------------------------------------------------------- audit, KPIs, QA */
  app.get('/api/audit', async (req) => {
    const p = requirePermission(req.staff, 'audit.read');
    const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.coerce.number().int().optional(), sessionId: z.string().max(40).optional(), event: z.string().max(60).optional(), from: z.string().max(40).optional(), to: z.string().max(40).optional() }).parse(req.query);
    audit({ actor: staffActor(p), event: 'audit.viewed', status: 'ok' });
    return queryAudit(q);
  });

  app.get('/api/kpis', async (req) => {
    requirePermission(req.staff, 'kpi.read');
    const f = KpiFilterSchema.parse(req.query);
    return computeKpis(f);
  });

  app.get('/api/ops/overview', async (req) => {
    requirePermission(req.staff, 'kpi.read');
    return opsOverview();
  });

  app.get('/api/policy', async (req) => {
    requirePermission(req.staff, 'policy.read');
    return { policy: policy(), targets: PILOT_TARGETS, note: 'Prototype policy values are assumptions pending bank approval (docs/DECISIONS.md).' };
  });

  app.post('/api/qa/reviews', async (req) => {
    const p = requirePermission(req.staff, 'qa.review');
    const body = z
      .object({
        sessionId: z.string().max(40),
        actionCorrect: z.boolean().nullable().default(null),
        safetyIncident: z.boolean().default(false),
        customerRepeatedIssue: z.boolean().default(false),
        score: z.number().int().min(0).max(100).nullable().default(null),
        notes: z.string().max(1000).default(''),
        flagged: z.boolean().default(true),
      })
      .strict()
      .parse(req.body);
    if (!get('SELECT 1 FROM call_sessions WHERE id = ?', [body.sessionId])) throw new AppError('NOT_FOUND', 'Call not found.');
    run(
      `INSERT INTO qa_reviews (session_id, reviewer_id, action_correct, safety_incident, customer_repeated_issue, score, notes, created_at) VALUES (?,?,?,?,?,?,?,?)`,
      [body.sessionId, p.userId, body.actionCorrect === null ? null : body.actionCorrect ? 1 : 0, body.safetyIncident ? 1 : 0, body.customerRepeatedIssue ? 1 : 0, body.score, body.notes, nowIso()],
    );
    run('UPDATE call_sessions SET qa_flagged = ? WHERE id = ?', [body.flagged ? 1 : 0, body.sessionId]);
    audit({ actor: staffActor(p), event: 'qa.review_recorded', status: 'ok', resourceType: 'session', resourceId: body.sessionId, sessionId: body.sessionId });
    return { ok: true, reviews: all('SELECT * FROM qa_reviews WHERE session_id = ? ORDER BY id DESC', [body.sessionId]) };
  });
}
