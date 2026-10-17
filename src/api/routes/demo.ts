/**
 * Public demo-environment endpoints (no sign-in), so judges can start, replay and understand
 * the demo. They expose synthetic data only and are disabled outside DEMO_MODE.
 */
import type { FastifyInstance } from 'fastify';
import { env } from '../../config/env.ts';
import { policy } from '../../config/policy.ts';
import { all, get } from '../../db/db.ts';
import { AppError } from '../../lib/errors.ts';
import { audit } from '../../audit/audit.ts';
import { resetScenario } from '../../db/seed.ts';
import { breakers } from '../../retrieval/retrieval.ts';
import { SOURCE_DISPLAY } from '../../retrieval/labels.ts';
import { INFO } from '../../kb/bank-info.ts';
import { KB_ARTICLES, knowledgeBase } from '../../kb/kb.ts';
import { SUPPORTED_LANGUAGES } from '../../voice/interfaces.ts';

export function registerDemoRoutes(app: FastifyInstance): void {
  /** What is simulated vs configured — shown honestly in the UI. */
  app.get('/api/demo/environment', async () => ({
    mode: env().ADAPTER_MODE === 'mock' ? 'demo' : env().ADAPTER_MODE === 'bigquery' ? 'bigquery' : 'integration',
    dataSource: env().ADAPTER_MODE === 'bigquery' ? `BigQuery ${env().BQ_PROJECT ?? env().GOOGLE_CLOUD_PROJECT ?? ''}.${env().BQ_DATASET}` : 'local synthetic tables',
    demoMode: env().DEMO_MODE,
    policyProfile: policy().profile,
    connectors: [
      ...Object.entries(SOURCE_DISPLAY).map(([k, label]) => ({ id: k, label, kind: 'read', status: env().ADAPTER_MODE === 'bigquery' && k !== 'prior_cases' ? 'bigquery' : 'simulated' })),
      { id: 'card_control', label: 'Card control (block)', kind: 'write', status: 'simulated' },
      { id: 'replacement', label: 'Card issuing (replacement)', kind: 'write', status: 'simulated' },
      { id: 'dispute_intake', label: 'Dispute intake', kind: 'write', status: 'simulated' },
      { id: 'fee_ledger', label: 'Fee ledger', kind: 'write', status: 'simulated' },
      { id: 'identity', label: 'Identity verification (DOB + passcode)', kind: 'verify', status: 'simulated' },
      { id: 'kb', label: `Knowledge base (${KB_ARTICLES.length + INFO.length} synthetic articles)`, kind: 'read', status: 'simulated', provider: knowledgeBase().name },
      { id: 'agent_desk', label: 'Agent desk / transfer', kind: 'telephony', status: 'simulated' },
      { id: 'intent', label: `Intent model: ${env().INTENT_MODEL === 'rules' ? 'deterministic rules' : env().INTENT_MODEL}`, kind: 'ai', status: env().INTENT_MODEL === 'rules' ? 'local' : 'configured' },
      { id: 'voice', label: 'Speech recognition & synthesis', kind: 'voice', status: 'browser', note: 'Uses your browser’s built-in speech features where supported; text input always works.' },
    ],
    languages: SUPPORTED_LANGUAGES,
  }));

  /** Aggregate activity from real demo calls, for the landing page's proof-of-work strip. */
  app.get('/api/demo/activity', async () => {
    const today = new Date(Date.now() - 24 * 3600_000).toISOString();
    const counts = get<{ calls: number; resolved: number; handed: number }>(
      `SELECT COUNT(*) calls, COALESCE(SUM(outcome = 'resolved'),0) resolved, COALESCE(SUM(outcome IN ('handed_off','fallback')),0) handed FROM call_sessions WHERE data_origin = 'demo_session' AND answered_at >= ?`,
      [today],
    ) ?? { calls: 0, resolved: 0, handed: 0 };
    const confirmed = get<{ n: number }>("SELECT COUNT(*) n FROM action_operations WHERE data_origin = 'demo_session' AND status = 'succeeded' AND requested_at >= ?", [today])?.n ?? 0;
    const last = get<{ session_id: string }>(
      "SELECT t.session_id FROM timeline_events t JOIN call_sessions s ON s.id = t.session_id WHERE s.data_origin = 'demo_session' AND t.type = 'call.closed' ORDER BY t.id DESC LIMIT 1",
    );
    const trail = last
      ? all<{ stage: string; title: string; status: string; created_at: string }>('SELECT stage, title, status, created_at FROM timeline_events WHERE session_id = ? ORDER BY id', [last.session_id]).map((e) => ({ stage: e.stage, title: e.title, status: e.status, at: e.created_at }))
      : [];
    return { label: 'Demo / synthetic data — last 24 hours', calls: counts.calls ?? 0, resolved: counts.resolved ?? 0, handedOff: counts.handed ?? 0, actionsConfirmed: confirmed, lastCallTrail: trail };
  });

  /** Replay a scenario: reset only that synthetic customer's fixtures and calls. */
  app.post<{ Params: { id: string } }>('/api/demo/scenarios/:id/reset', { config: { rateLimit: { max: env().NODE_ENV === 'test' ? 10_000 : 30, timeWindow: '1 minute' } } }, async (req) => {
    if (!env().DEMO_MODE) throw new AppError('FORBIDDEN', 'Demo reset is only available in demo mode.');
    if (!/^S\d{2}$/.test(req.params.id) || !resetScenario(req.params.id)) throw new AppError('NOT_FOUND', 'Unknown scenario.');
    breakers.reset();
    audit({ actor: { type: 'system', id: 'demo-reset' }, event: 'demo.scenario_reset', status: 'ok', metadata: { scenario: req.params.id } });
    return { ok: true, scenario: req.params.id, synthetic: true };
  });
}
