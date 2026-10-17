/**
 * Gemini Live on Vertex AI (server-side). Uses the official @google/genai SDK in Vertex mode, so
 * authentication is Application Default Credentials: on Cloud Run that is the service identity,
 * locally it is `gcloud auth application-default login`. No API key or token ever reaches the
 * browser; the browser only talks to this server's WebSocket.
 */
import { Behavior, EndSensitivity, GoogleGenAI, Modality, Type, type LiveServerMessage, type Session } from '@google/genai';
import { env } from '../config/env.ts';
import { log } from '../lib/logger.ts';
import type { LiveConnectOptions, LiveProvider, LiveSession, LiveToolDecl } from './provider.ts';

const TYPE_MAP = { string: Type.STRING, number: Type.NUMBER, boolean: Type.BOOLEAN } as const;

function declarations(tools: LiveToolDecl[]) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: {
      type: Type.OBJECT,
      properties: Object.fromEntries(Object.entries(t.parameters.properties).map(([k, v]) => [k, { type: TYPE_MAP[v.type], description: v.description, ...(v.enum ? { enum: v.enum } : {}) }])),
      required: t.parameters.required ?? [],
    },
  }));
}

/** Models that failed to open a session in this process. They are skipped on later calls so a missing model costs one try, not one per call. */
const unusable = new Set<string>();

/** 3.x Live models call tools asynchronously by default. This app waits for each tool result, so ask for blocking calls. */
const needsBlocking = (model: string) => /(^|[-/])3[.-]\d/.test(model);

/**
 * The voice to ask for. Resolved in one place so the voice that is sent and the voice that is
 * logged can never disagree — the whole point of the log line is to answer "who was speaking?"
 * after the fact.
 */
const voiceFor = (opts: LiveConnectOptions) => opts.voice ?? env().LIVE_VOICE;

export class GeminiLiveProvider implements LiveProvider {
  readonly name = 'gemini-live-vertex';
  /** The model that last opened a session (or the first candidate before any call). */
  model: string;
  /** Entries are `model` or `model@location` (for models served only from another location, e.g. `gemini-3.8-live@global`). */
  private readonly candidates: string[];
  private readonly clients = new Map<string, GoogleGenAI>();
  private readonly project: string;

  constructor(project: string) {
    const e = env();
    // LIVE_MODEL may list several IDs, best first. The first one this project can open is used.
    this.candidates = e.LIVE_MODEL.split(',').map((m) => m.trim()).filter(Boolean);
    this.model = this.candidates[0];
    this.project = project;
  }

  private client(location: string): GoogleGenAI {
    let c = this.clients.get(location);
    if (!c) { c = new GoogleGenAI({ vertexai: true, project: this.project, location }); this.clients.set(location, c); }
    return c;
  }

  /**
   * Open a session, trying the configured models in order.
   *
   * `opts.pinnedEntry`, when set, is the entry an earlier connection on this same call succeeded
   * with, and it is tried first and on its own before anything else. That matters for one reason:
   * the models in the list do not share a voice catalogue. A model that does not recognise the voice
   * we ask for falls back to ITS default, and the default on several Live models is a male voice —
   * which is how a caller ends up halfway through a call with Lily and finishing it with somebody
   * else. Falling back to a different model is the right thing to do when a call cannot start at
   * all; doing it silently in the middle of a call is not.
   */
  async connect(opts: LiveConnectOptions): Promise<LiveSession> {
    const rest = [...this.candidates.filter((m) => !unusable.has(m)), ...this.candidates.filter((m) => unusable.has(m))];
    const order = opts.pinnedEntry ? [opts.pinnedEntry, ...rest.filter((m) => m !== opts.pinnedEntry)] : rest;
    let lastError: Error | null = null;
    for (const entry of order) {
      const [model, loc] = entry.split('@');
      const location = loc || env().GOOGLE_CLOUD_LOCATION;
      // Full config first (session resumption, context compression), then the minimal one for models that reject extras.
      for (const rich of [true, false]) {
        try {
          const s = await this.open(model, location, opts, rich);
          this.model = model;
          s.entry = entry;
          s.voice = voiceFor(opts);
          unusable.delete(entry);
          if (opts.pinnedEntry && entry !== opts.pinnedEntry) {
            log.warn('reconnected on a different Live model; the voice may not match the rest of the call', { was: opts.pinnedEntry, now: entry, voice: s.voice });
          }
          return s;
        } catch (err) {
          lastError = err as Error;
          log.warn('live model could not open a session', { model, location, rich, error: lastError.message });
        }
      }
      unusable.add(entry);
    }
    throw lastError ?? new Error('No Live model is configured');
  }

  private async open(model: string, location: string, opts: LiveConnectOptions, rich: boolean): Promise<LiveSession> {
    const { events } = opts;
    let closed = false;
    let ready = false;
    let settle: { ok: () => void; fail: (e: Error) => void } = { ok: () => {}, fail: () => {} };
    const setup = new Promise<void>((resolve, reject) => { settle = { ok: resolve, fail: reject }; });
    const fns = declarations(opts.tools).map((d) => (needsBlocking(model) ? { ...d, behavior: Behavior.BLOCKING } : d));
    const session: Session = await this.client(location).live.connect({
      model,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: opts.systemInstruction,
        tools: [{ functionDeclarations: fns }],
        // Transcripts of both sides drive the on-screen conversation and consent checks.
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceFor(opts) } } },
        // Callers pause between groups of digits. A longer silence window stops Lily cutting in mid-number.
        realtimeInputConfig: { automaticActivityDetection: { endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW, silenceDurationMs: 1100 } },
        ...(rich ? { sessionResumption: {}, contextWindowCompression: { slidingWindow: {} } } : {}),
      },
      callbacks: {
        onmessage: (m: LiveServerMessage) => {
          if (m.setupComplete) { ready = true; settle.ok(); }
          try {
            handle(m, events);
          } catch (err) {
            events.onError(err as Error);
          }
        },
        onerror: (e) => { const err = new Error(e?.message || 'Live connection error'); if (!ready) settle.fail(err); else events.onError(err); },
        onclose: (e) => {
          if (!ready) return settle.fail(new Error(e?.reason || 'closed before setup'));
          if (closed) return;
          closed = true;
          events.onClose(e?.reason || 'closed');
        },
      },
    });
    const timer = setTimeout(() => settle.fail(new Error('Live setup timed out')), 9000);
    try {
      await setup;
    } catch (err) {
      try { session.close(); } catch { /* already closed */ }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    return {
      sendAudio: (b64) => session.sendRealtimeInput({ audio: { data: b64, mimeType: 'audio/pcm;rate=16000' } }),
      sendText: (text) => session.sendRealtimeInput({ text }),
      sendToolResponse: (call, response) => session.sendToolResponse({ functionResponses: [{ id: call.id, name: call.name, response }] }),
      close: () => {
        closed = true;
        try {
          session.close();
        } catch (err) {
          log.warn('live session close failed', { error: (err as Error).message });
        }
      },
    };
  }
}

function handle(m: LiveServerMessage, ev: LiveConnectOptions['events']): void {
  const sc = m.serverContent;
  if (sc) {
    for (const part of sc.modelTurn?.parts ?? []) {
      const d = part.inlineData?.data;
      if (d && (part.inlineData?.mimeType ?? '').startsWith('audio/')) ev.onAudio(d);
    }
    if (sc.inputTranscription?.text) ev.onInputText(sc.inputTranscription.text, !!sc.inputTranscription.finished);
    if (sc.outputTranscription?.text) ev.onOutputText(sc.outputTranscription.text, !!sc.outputTranscription.finished);
    if (sc.interrupted) ev.onInterrupted();
    if (sc.turnComplete) ev.onTurnComplete();
  }
  if (m.toolCall?.functionCalls?.length) {
    ev.onToolCall(m.toolCall.functionCalls.map((c) => ({ id: c.id ?? c.name ?? 'call', name: c.name ?? '', args: (c.args ?? {}) as Record<string, unknown> })));
  }
  if (m.goAway) {
    const secs = Number.parseFloat(String(m.goAway.timeLeft ?? '').replace('s', ''));
    ev.onGoAway?.(Number.isFinite(secs) ? secs * 1000 : null);
  }
}
