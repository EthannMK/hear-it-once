/**
 * Caller-facing API (text simulator / voice channel). Every route checks that the request
 * holds the caller token for that session. Agents may also act through these routes with
 * the appropriate permission.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { env } from '../../config/env.ts';
import { policy } from '../../config/policy.ts';
import { get } from '../../db/db.ts';
import { AppError } from '../../lib/errors.ts';
import { newId } from '../../lib/ids.ts';
import { SCENARIOS } from '../../db/scenarios.ts';
import { startCall, handleInput, type CallInput } from '../../conversation/orchestrator.ts';
import { getOp, opHistory, reconcile, requestAction, retryAction, currentSnapshotId } from '../../actions/action-service.ts';
import { audit, type Actor } from '../../audit/audit.ts';
import { requirePermission, staffActor } from '../../auth/rbac.ts';
import { buildCallView } from '../views.ts';
import { CALL_COOKIE, callerOwns, requireCaller } from '../app.ts';
import { SUPPORTED_LANGUAGES } from '../../voice/interfaces.ts';

const StartCall = z
  .object({
    scenarioId: z.string().regex(/^S\d{2}$/).optional(),
    callerAni: z.string().max(32).optional(),
    channel: z.enum(['text_simulator', 'voice_browser']).default('text_simulator'),
    moodStart: z.enum(['calm', 'worried', 'frustrated', 'upset']).optional(),
  })
  .strict();

const Input = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('utterance'), text: z.string().max(1000), clientMessageId: z.string().max(64).optional(), asrConfidence: z.number().min(0).max(1).optional() }).strict(),
  z.object({ kind: z.literal('choice'), optionId: z.string().max(64), clientMessageId: z.string().max(64).optional() }).strict(),
  z.object({ kind: z.literal('consent'), proposalId: z.string().max(64), decision: z.enum(['accept', 'decline']), clientMessageId: z.string().max(64).optional() }).strict(),
  z.object({ kind: z.literal('request_human'), clientMessageId: z.string().max(64).optional() }).strict(),
  z.object({ kind: z.literal('silence') }).strict(),
  z.object({ kind: z.literal('interrupt') }).strict(),
  z.object({ kind: z.literal('reconcile'), clientMessageId: z.string().max(64).optional() }).strict(),
  z.object({ kind: z.literal('hangup') }).strict(),
  z.object({ kind: z.literal('survey'), score: z.number().int().min(1).max(5) }).strict(),
]);

const DirectAction = z
  .object({
    type: z.enum(['block_card', 'order_replacement', 'submit_dispute', 'reverse_fee']),
    targetRef: z.string().min(3).max(64),
    params: z.record(z.unknown()).default({}),
    consentId: z.string().max(64).nullable().default(null),
  })
  .strict();

/** Caller (token holder) or staff with a permission. Returns the acting principal. */
function actorFor(req: FastifyRequest, sessionId: string, staffPerm: Parameters<typeof requirePermission>[1]): Actor {
  if (callerOwns(req, sessionId)) return { type: 'customer_session', id: sessionId };
  if (req.staff) return staffActor(requirePermission(req.staff, staffPerm));
  if (!get('SELECT 1 FROM call_sessions WHERE id = ?', [sessionId])) throw new AppError('NOT_FOUND', 'Call not found.');
  throw new AppError('UNAUTHENTICATED', 'Caller session token or staff sign-in required.');
}

export function registerCallRoutes(app: FastifyInstance): void {
  app.get('/api/meta', async () => ({
    simulated: true,
    demoMode: env().DEMO_MODE,
    adapterMode: env().ADAPTER_MODE,
    policyProfile: policy().profile,
    intentModel: env().INTENT_MODEL,
    supportedLanguages: SUPPORTED_LANGUAGES,
    banner: 'SIMULATED PROTOTYPE — synthetic data and mock bank systems only. No real card, payment or dispute is affected.',
  }));

  app.get('/api/scenarios', async () => ({
    items: SCENARIOS.map((s) => ({ id: s.id, title: s.title, issue: s.issue, customerName: s.customer.name, callerAni: s.customer.phone, customerNumber: s.customer.number, dob: env().DEMO_MODE ? s.customer.dob : undefined, script: s.script, expected: s.expected, synthetic: true })),
  }));

  app.post('/api/calls', { config: { rateLimit: { max: env().NODE_ENV === 'test' ? 10_000 : 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = StartCall.parse(req.body ?? {});
    const scenario = body.scenarioId ? SCENARIOS.find((s) => s.id === body.scenarioId) : undefined;
    if (body.scenarioId && !scenario) throw new AppError('NOT_FOUND', 'Unknown scenario.');
    const token = randomBytes(24).toString('base64url');
    const sessionId = await startCall({ channel: body.channel, scenarioId: body.scenarioId ?? null, callerAni: body.callerAni ?? scenario?.customer.phone ?? null, callerToken: token, moodStart: body.moodStart ?? null });
    reply.setCookie(CALL_COOKIE, token, { httpOnly: true, sameSite: 'strict', path: '/api/calls', secure: env().NODE_ENV === 'production' });
    return reply.status(201).send({ sessionId, callToken: token, view: buildCallView(sessionId, { audience: 'caller' }) });
  });

  app.get<{ Params: { id: string } }>('/api/calls/:id', async (req) => {
    const { id } = req.params;
    if (callerOwns(req, id)) return buildCallView(id, { audience: 'caller' });
    const p = requirePermission(req.staff, 'call.read');
    const v = buildCallView(id, { audience: 'staff' });
    if (!v) throw new AppError('NOT_FOUND', 'Call not found.');
    audit({ actor: staffActor(p), event: 'call.viewed', status: 'ok', resourceType: 'session', resourceId: id, sessionId: id });
    return v;
  });

  app.post<{ Params: { id: string } }>('/api/calls/:id/input', { config: { rateLimit: { max: env().NODE_ENV === 'test' ? 10_000 : 90, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = req.params;
    requireCaller(req, id);
    const input = Input.parse(req.body) as CallInput;
    await handleInput(id, input);
    return buildCallView(id, { audience: 'caller' });
  });

  /**
   * Direct action API (used by integrations, the agent console and negative tests). The same
   * action service and policy engine apply: verification, consent, sources, eligibility.
   */
  app.post<{ Params: { id: string } }>('/api/calls/:id/actions', { config: { rateLimit: { max: env().NODE_ENV === 'test' ? 10_000 : 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = req.params;
    const actor = actorFor(req, id, 'action.request');
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9:_-]{8,128}$/.test(key)) throw new AppError('VALIDATION_FAILED', 'An Idempotency-Key header (8–128 chars) is required.');
    const body = DirectAction.parse(req.body);
    const s = get<{ customer_id: string | null; correlation_id: string; scenario_id: string | null }>('SELECT customer_id, correlation_id, scenario_id FROM call_sessions WHERE id = ?', [id])!;
    if (!s.customer_id) {
      audit({ actor, event: 'action.rejected', status: 'denied', sessionId: id, metadata: { type: body.type, reason: 'VERIFICATION_REQUIRED' } });
      throw new AppError('VERIFICATION_REQUIRED', 'The caller must complete identity verification before any action.');
    }
    const caseId = get<{ id: string }>('SELECT id FROM cases WHERE session_id = ?', [id])?.id ?? null;
    const { op, created } = await requestAction(
      {
        type: body.type, sessionId: id, caseId, customerId: s.customer_id, targetRef: body.targetRef, params: body.params, consentId: body.consentId,
        snapshotId: currentSnapshotId(id), actor: { type: actor.type === 'agent' ? 'agent' : 'customer_session', id: actor.id },
        idempotencyKey: `api:${key}`, correlationId: s.correlation_id ?? newId('COR'), scenarioId: s.scenario_id,
      },
      actor,
    );
    const view = { operation: { ...op, policy_decision: op.policy_decision_json ? JSON.parse(op.policy_decision_json) : null, policy_decision_json: undefined, history: opHistory(op.id) }, idempotentReplay: !created };
    if (op.status === 'rejected') {
      const code = op.error_code ?? 'POLICY_DENIED';
      const status = code === 'VERIFICATION_REQUIRED' || code === 'FORBIDDEN' ? 403 : 422;
      return reply.status(status).send({ error: { code, message: op.error_message ?? 'Rejected by policy.', details: view } });
    }
    return reply.status(created ? 201 : 200).send(view);
  });

  app.get<{ Params: { id: string; opId: string } }>('/api/calls/:id/actions/:opId', async (req) => {
    const { id, opId } = req.params;
    actorFor(req, id, 'call.read');
    const op = getOp(opId);
    if (!op || op.session_id !== id) throw new AppError('NOT_FOUND', 'Operation not found.');
    return { ...op, history: opHistory(opId) };
  });

  app.post<{ Params: { id: string; opId: string } }>('/api/calls/:id/actions/:opId/reconcile', async (req) => {
    const { id, opId } = req.params;
    const actor = actorFor(req, id, 'action.reconcile');
    const op = getOp(opId);
    if (!op || op.session_id !== id) throw new AppError('NOT_FOUND', 'Operation not found.');
    const s = get<{ correlation_id: string }>('SELECT correlation_id FROM call_sessions WHERE id = ?', [id])!;
    const r = await reconcile(opId, actor, s.correlation_id);
    return { ...r, history: opHistory(opId) };
  });

  app.post<{ Params: { id: string; opId: string } }>('/api/calls/:id/actions/:opId/retry', async (req) => {
    const { id, opId } = req.params;
    const actor = actorFor(req, id, 'action.request');
    const op = getOp(opId);
    if (!op || op.session_id !== id) throw new AppError('NOT_FOUND', 'Operation not found.');
    const s = get<{ correlation_id: string }>('SELECT correlation_id FROM call_sessions WHERE id = ?', [id])!;
    const r = await retryAction(opId, actor, s.correlation_id);
    return { ...r, history: opHistory(opId) };
  });
}
