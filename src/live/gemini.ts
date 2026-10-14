/**
 * Gemini Live on Vertex AI (server-side). Uses the official @google/genai SDK in Vertex mode, so
 * authentication is Application Default Credentials: on Cloud Run that is the service identity,
 * locally it is `gcloud auth application-default login`. No API key or token ever reaches the
 * browser; the browser only talks to this server's WebSocket.
 */
import { GoogleGenAI, Modality, Type, type LiveServerMessage, type Session } from '@google/genai';
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

export class GeminiLiveProvider implements LiveProvider {
  readonly name = 'gemini-live-vertex';
  readonly model: string;
  private readonly ai: GoogleGenAI;

  constructor(project: string) {
    const e = env();
    this.model = e.LIVE_MODEL;
    this.ai = new GoogleGenAI({ vertexai: true, project, location: e.GOOGLE_CLOUD_LOCATION });
  }

  async connect(opts: LiveConnectOptions): Promise<LiveSession> {
    const { events } = opts;
    let closed = false;
    const session: Session = await this.ai.live.connect({
      model: this.model,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: opts.systemInstruction,
        tools: [{ functionDeclarations: declarations(opts.tools) }],
        // Transcripts of both sides drive the on-screen conversation and consent checks.
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: env().LIVE_VOICE } } },
      },
      callbacks: {
        onmessage: (m: LiveServerMessage) => {
          try {
            handle(m, events);
          } catch (err) {
            events.onError(err as Error);
          }
        },
        onerror: (e) => events.onError(new Error(e?.message || 'Live connection error')),
        onclose: (e) => {
          if (closed) return;
          closed = true;
          events.onClose(e?.reason || 'closed');
        },
      },
    });
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
