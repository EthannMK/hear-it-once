/**
 * Live voice WebSocket, journey data for the landing page, and the staff live handover stream.
 */
import type { FastifyInstance } from 'fastify';
import { get } from '../../db/db.ts';
import { log } from '../../lib/logger.ts';
import { requirePermission } from '../../auth/rbac.ts';
import { SCENARIOS } from '../../db/scenarios.ts';
import { subscribeAll } from '../../events/timeline.ts';
import { callerOwns } from '../app.ts';
import { LiveBridge, auditLiveStart, type ServerMessage } from '../../live/bridge.ts';
import { createLiveProvider, liveAvailability } from '../../live/registry.ts';
import { JOURNEY_SCENARIOS, journeyCard } from '../../live/journey.ts';

const bridges = new Map<string, LiveBridge>();
const MAX_AUDIO_B64 = 32 * 1024;

export function registerLiveRoutes(app: FastifyInstance): void {
  app.get('/api/live/status', async () => ({ ...(await liveAvailability()), simulated: true }));

  app.get('/api/journey/scenarios', async () => ({
    demoData: true,
    items: JOURNEY_SCENARIOS.map((j) => journeyCard(j, SCENARIOS.find((s) => s.id === j.scenarioId)!)),
  }));

  /** Bidirectional voice. The caller token cookie (path /api/calls) authenticates the browser. */
  app.get<{ Params: { id: string } }>('/api/calls/:id/live', { websocket: true }, async (socket, req) => {
    const { id } = req.params;
    const send = (m: ServerMessage) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(m));
    };
    const reject = (code: string, message: string) => {
      send({ type: 'error', code, message });
      socket.close(1008, code);
    };
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return reject('FORBIDDEN', 'Cross-origin voice connections are not allowed.');
    if (!get('SELECT 1 FROM call_sessions WHERE id = ?', [id])) return reject('NOT_FOUND', 'Call not found.');
    if (!callerOwns(req, id)) return reject('FORBIDDEN', 'This call belongs to a different caller session.');
    if (get<{ ended_at: string | null }>('SELECT ended_at FROM call_sessions WHERE id = ?', [id])?.ended_at) return reject('CALL_ENDED', 'This call has ended.');

    const avail = await liveAvailability();
    if (!avail.available) return reject('VOICE_UNAVAILABLE', avail.reason ?? 'Live voice is unavailable.');

    // One live connection per call: a newer one replaces the older.
    bridges.get(id)?.close('replaced_by_new_connection');
    let bridge: LiveBridge;
    try {
      const provider = await createLiveProvider();
      bridge = new LiveBridge(id, send, provider);
      bridges.set(id, bridge);
      await bridge.start();
      auditLiveStart(id, provider.name);
    } catch (e) {
      bridges.delete(id);
      log.warn('live voice failed to start', { sessionId: id, error: (e as Error).message });
      return reject('VOICE_UNAVAILABLE', 'Live voice could not connect. You can keep going by typing; nothing on the call was lost.');
    }

    const ping = setInterval(() => socket.readyState === 1 && socket.ping(), 20_000);
    socket.on('message', (raw: Buffer) => {
      let msg: { type?: string; data?: string; muted?: boolean; text?: string };
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      switch (msg.type) {
        case 'audio':
          if (typeof msg.data === 'string' && msg.data.length <= MAX_AUDIO_B64) bridge.onClientAudio(msg.data);
          break;
        case 'mute':
          bridge.setMuted(!!msg.muted);
          break;
        case 'text':
          if (typeof msg.text === 'string') void bridge.onClientText(msg.text);
          break;
        case 'end':
          void bridge.endCall();
          break;
      }
    });
    socket.on('close', () => {
      clearInterval(ping);
      if (bridges.get(id) === bridge) bridges.delete(id);
      bridge.close('browser_disconnected');
    });
    socket.on('error', () => socket.close());
  });

  /**
   * Staff live stream (server-sent events): the agent console learns about new, accepted and
   * completed handovers the moment they are persisted, with no refresh. Needs handoff.read.
   */
  app.get('/api/handoffs/stream', async (req, reply) => {
    requirePermission(req.staff, 'handoff.read');
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff' });
    res.write('retry: 2000\n\n');
    const off = subscribeAll((e) => {
      if (!e.type.startsWith('handoff.') && e.type !== 'call.closed') return;
      res.write(`event: handoff\ndata: ${JSON.stringify({ type: e.type, sessionId: e.sessionId, title: e.title, status: e.status, at: e.at, ref: e.ref })}\n\n`);
    });
    const ping = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      off();
    });
  });
}

export function closeAllLiveBridges(): void {
  for (const b of bridges.values()) b.close('server_shutdown');
  bridges.clear();
}
