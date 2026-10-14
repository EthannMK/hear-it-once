/**
 * PROVIDER-NEUTRAL LIVE VOICE INTERFACE.
 *
 * A LiveProvider opens one bidirectional speech session (audio in, audio out, transcripts, tool
 * calls). The bridge depends only on this interface, so Gemini Live on Vertex AI is one
 * implementation and a scripted stand-in (tests only) is another. Audio is raw little-endian
 * 16-bit PCM, base64 encoded: 16 kHz from the caller, 24 kHz from the model.
 */

export interface LiveToolDecl {
  name: string;
  description: string;
  /** JSON-schema-like object: { type: 'object', properties: {...}, required?: [...] } */
  parameters: { type: 'object'; properties: Record<string, { type: 'string' | 'number' | 'boolean'; description: string; enum?: string[] }>; required?: string[] };
}

export interface LiveToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LiveEvents {
  /** Model speech, PCM 24 kHz base64. */
  onAudio(pcmBase64: string): void;
  /** Caller speech recognised so far. `final` marks the end of a recognised segment. */
  onInputText(text: string, final: boolean): void;
  /** Model speech transcript so far. */
  onOutputText(text: string, final: boolean): void;
  /** The caller spoke over the model: playback must stop and the queue be emptied. */
  onInterrupted(): void;
  onTurnComplete(): void;
  onToolCall(calls: LiveToolCall[]): void;
  /** The provider will end the session soon (e.g. session time limit); reconnect to continue. */
  onGoAway?(timeLeftMs: number | null): void;
  onError(err: Error): void;
  onClose(reason: string): void;
}

export interface LiveSession {
  sendAudio(pcm16kBase64: string): void;
  /** A short system-originated instruction, e.g. to greet or to announce a confirmed event. */
  sendText(text: string): void;
  sendToolResponse(call: { id: string; name: string }, response: Record<string, unknown>): void;
  close(): void;
}

export interface LiveConnectOptions {
  systemInstruction: string;
  tools: LiveToolDecl[];
  events: LiveEvents;
}

export interface LiveProvider {
  readonly name: string;
  readonly model: string;
  connect(opts: LiveConnectOptions): Promise<LiveSession>;
}

export interface LiveAvailability {
  available: boolean;
  provider: string;
  model: string | null;
  /** Plain-language reason shown to the caller and the operator when unavailable. */
  reason: string | null;
  location: string | null;
}
