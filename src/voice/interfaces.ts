/**
 * PROVIDER-NEUTRAL VOICE & TELEPHONY INTERFACES (BRD §10, prompt §7).
 * Business logic depends only on these. The prototype ships:
 *  - TextSimulatorChannel (mandatory fallback; same backend workflows), and
 *  - an optional in-browser Web Speech capture/playback in the simulator UI, which sends the
 *    recognised text + confidence through the same input API (no server-side provider).
 * A production deployment would add real ASR/TTS/telephony implementations here.
 */
export interface Utterance {
  text: string;
  /** 0..1 recogniser confidence; undefined for typed text. */
  confidence?: number;
  language?: string;
  isFinal: boolean;
}

export interface SpeechToText {
  readonly provider: string;
  readonly supportedLanguages: string[];
  transcribe(audio: ArrayBuffer, opts: { language: string }): Promise<Utterance>;
}

export interface TextToSpeech {
  readonly provider: string;
  synthesize(text: string, opts: { language: string; voice?: string }): Promise<ArrayBuffer>;
  /** Barge-in: stop current playback when the caller starts speaking. */
  cancel(callId: string): void;
}

export type TransferResult = { status: 'queued'; queuePosition: number } | { status: 'no_agent' } | { status: 'failed'; reason: string };

export interface TelephonyAdapter {
  readonly provider: string;
  /** Request a warm transfer; returns queue status. 'connected' is only confirmed later by the agent leg. */
  requestTransfer(handoffId: string, priority: 'normal' | 'urgent'): Promise<TransferResult>;
  hangup(callId: string): Promise<void>;
}

/** Languages the prototype has actually been tested with (BRD: do not claim untested support). */
export const SUPPORTED_LANGUAGES = ['en-US'] as const;
