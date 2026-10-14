/**
 * Fastify application: security headers, auth decorators, error mapping, rate limits, routes.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { env } from '../config/env.ts';
import { get } from '../db/db.ts';
import { AppError, isAppError } from '../lib/errors.ts';
import { safeEqual, sha256 } from '../lib/ids.ts';
import { log } from '../lib/logger.ts';
import { verifyStaffToken, type StaffPrincipal } from '../auth/rbac.ts';
import { registerCallRoutes } from './routes/calls.ts';
import { registerStaffRoutes } from './routes/staff.ts';
import { registerAdminRoutes } from './routes/admin.ts';
import { registerDemoRoutes } from './routes/demo.ts';
import { registerLiveRoutes } from './routes/live.ts';

declare module 'fastify' {
  interface FastifyRequest {
    staff: StaffPrincipal | null;
  }
}

/** WebSocket origins for the CSP: same host, ws/wss. Safari does not treat 'self' as covering ws. */
function wsOrigin(host: string | undefined): string {
  return host && /^[A-Za-z0-9.:-]+$/.test(host) ? `ws://${host} wss://${host}` : '';
}

export const STAFF_COOKIE = 'hio_staff';
export const CALL_COOKIE = 'hio_call';

/** The caller token proves this browser/leg started the call. Accepts cookie or header. */
export function callerOwns(req: FastifyRequest, sessionId: string): boolean {
  const token = (req.headers['x-call-token'] as string | undefined) ?? req.cookies[CALL_COOKIE];
  if (!token) return false;
  const row = get<{ caller_token_hash: string | null }>('SELECT caller_token_hash FROM call_sessions WHERE id = ?', [sessionId]);
  return !!row?.caller_token_hash && safeEqual(row.caller_token_hash, sha256(`call:${token}`));
}

export function requireCaller(req: FastifyRequest, sessionId: string): void {
  if (!get('SELECT 1 FROM call_sessions WHERE id = ?', [sessionId])) throw new AppError('NOT_FOUND', 'Call not found.');
  if (!callerOwns(req, sessionId)) throw new AppError('FORBIDDEN', 'This call belongs to a different caller session.');
}

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 32 * 1024, trustProxy: false });
  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 128 * 1024 } });
  await app.register(rateLimit, {
    global: true,
    max: env().NODE_ENV === 'test' ? 10_000 : 600,
    timeWindow: '1 minute',
    errorResponseBuilder: (_req, ctx) => ({ statusCode: 429, error: { code: 'RATE_LIMITED', message: `Too many requests; retry in ${Math.ceil(ctx.ttl / 1000)}s.` } }),
  });

  app.decorateRequest('staff', null);
  app.addHook('onRequest', async (req) => {
    req.staff = verifyStaffToken(req.cookies[STAFF_COOKIE]);
  });
  // CSRF hardening for cookie-authenticated writes: JSON only (forms can't send it cross-site
  // without a CORS preflight, which we never grant) + SameSite=Strict cookies.
  app.addHook('preHandler', async (req) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.url.startsWith('/api/')) {
      const ct = String(req.headers['content-type'] ?? '');
      if (!ct.startsWith('application/json')) throw new AppError('VALIDATION_FAILED', 'Content-Type must be application/json.');
    }
  });
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self)');
    reply.header(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' ${wsOrigin(req.headers.host)}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
    );
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  app.setErrorHandler((err: unknown, req: FastifyRequest, reply: FastifyReply) => {
    if (isAppError(err)) return reply.status(err.status).send({ error: { code: err.code, message: err.safeMessage, details: err.details ?? null } });
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_FAILED', message: 'Invalid request.', details: { issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } } });
    const e = err as { statusCode?: number; message?: string; code?: string };
    if (e.statusCode === 429) return reply.status(429).send({ error: { code: 'RATE_LIMITED', message: e.message ?? 'Too many requests.' } });
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: { code: 'VALIDATION_FAILED', message: e.message ?? 'Bad request.' } });
    log.error('http.unhandled', { url: req.url, method: req.method, err: e.message });
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Something went wrong. No action was taken.' } });
  });

  app.get('/api/health', async () => ({ status: 'ok', simulated: true, time: new Date().toISOString() }));

  registerCallRoutes(app);
  registerStaffRoutes(app);
  registerAdminRoutes(app);
  registerDemoRoutes(app);
  registerLiveRoutes(app);

  const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
  await app.register(fastifyStatic, { root: publicDir, index: ['index.html'], cacheControl: false });
  // Only two screens exist: the judge page (/) and the agent workspace (/agent.html). Old links land on the judge page.
  for (const old of ['/classic.html', '/dashboard.html', '/lab.html']) app.get(old, (_req, reply) => reply.redirect('/', 302));
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
    return reply.status(404).type('text/plain').send('Not found');
  });
  return app;
}
