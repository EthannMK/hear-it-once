/**
 * LIVE VOICE BRIDGE — one per active call.
 *
 *   browser mic ──PCM16k──▶ bridge ──▶ LiveProvider (Gemini Live on Vertex AI)
 *   browser spk ◀──PCM24k── bridge ◀── LiveProvider
 *                              │
 *                              ├─ tool calls ─▶ runTool() ─▶ orchestrator / policy / actions (server-side)
 *                              └─ timeline events, transcript turns and call view ─▶ browser
 *
 * What is true here is only what the application recorded: transcript turns come from the
 * database, activity events come from the timeline, handover status comes from the handoff
 * rows. The bridge never reports a state it has not observed.
 */
import { all, get } from '../db/db.ts';
import { AppError } from '../lib/errors.ts';
import { log } from '../lib/logger.ts';
import { redactText } from '../lib/redact.ts';
import { audit, ASSISTANT } from '../audit/audit.ts';
import { emitTimeline, subscribe, type TimelineEvent } from '../events/timeline.ts';
import { getContext, handleInput } from '../conversation/orchestrator.ts';
import { addTurn } from '../handoff/handoff-service.ts';
import { buildCallView } from '../api/views.ts';
import type { LiveConnectOptions, LiveProvider, LiveSession, LiveToolCall } from './provider.ts';
import { LILY_TOOLS, lilySystemInstruction } from './lily.ts';
import { runTool } from './tools.ts';
import { normaliseSpoken } from './speech.ts';

export type ServerMessage =
  | { type: 'ready'; provider: string; model: string; resumed: boolean }
  | { type: 'audio'; data: string }
  | { type: 'interrupted' }
  | { type: 'partial'; speaker: 'customer' | 'assistant'; text: string }
  | { type: 'turns'; turns: { seq: number; speaker: string; kind: string; text: string; at: string }[] }
  | { type: 'phase'; phase: 'processing' | 'idle'; tool?: string }
  | { type: 'timeline'; event: TimelineEvent }
  | { type: 'view'; view: unknown }
  | { type: 'voice'; status: 'reconnecting' | 'restored' | 'lost'; message: string }
  | { type: 'ended'; view: unknown }
  | { type: 'error'; code: string; message: string };

const MAX_RECONNECTS = 3;
const TEXT_WAIT_QUIET_MS = 350;
const TEXT_WAIT_MAX_MS = 2500;

export class LiveBridge {
  private session: LiveSession | null = null;
  private closed = false;
  private muted = false;
  private reconnects = 0;
  private reconnecting = false;

  // Per customer turn
  private userText = '';
  private userConsumed = false;
  private lastUserChunkAt = 0;
  private turnCounter = 0;
  // Per model turn
  private modelText = '';
  private suppressModelText = false;
  private modelSpoke = false;
  /** True from a tool response until Lily has spoken the result; her paraphrase is not stored twice. */
  private awaitingGreeting = false;
  private toolSpeechPending = false;
  private toolSpeechStarted = false;
  private toolQueue: Promise<void> = Promise.resolve();
  private lastSentSeq = 0;
  private unsubscribe: (() => void) | null = null;
  private goAwayTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly sessionId: string,
    private readonly send: (m: ServerMessage) => void,
    private readonly provider: LiveProvider,
  ) {}

  /* ------------------------------------------------------------------ lifecycle */

  async start(): Promise<void> {
    this.lastSentSeq = 0;
    this.unsubscribe = subscribe(this.sessionId, (e) => this.onTimeline(e));
    // Anything beyond the on-screen notice means the conversation is already under way.
    const resumed = this.turnsSoFar().some((t) => t.speaker !== 'system');
    try {
      await this.openProviderSession(resumed);
    } catch (e) {
      this.unsubscribe?.();
      this.unsubscribe = null;
      throw e;
    }
    this.send({ type: 'ready', provider: this.provider.name, model: this.provider.model, resumed });
    this.syncTurns();
    this.pushView();
    emitTimeline(this.sessionId, { type: 'voice.connected', stage: 'understand', title: resumed ? 'Voice connection restored' : 'Live voice connected', detail: `${this.provider.name} · ${this.provider.model}`, status: 'ok', source: 'voice bridge' });
    if (!resumed) {
      this.awaitingGreeting = true;
      this.session?.sendText('The customer has just connected. Greet them now, following your instructions.');
    }
  }

  private async openProviderSession(resumed: boolean): Promise<void> {
    const opts: LiveConnectOptions = {
      systemInstruction: lilySystemInstruction({ recap: resumed ? this.recap() : null }),
      tools: LILY_TOOLS,
      events: {
        onAudio: (b64) => {
          this.modelSpoke = true;
          this.send({ type: 'audio', data: b64 });
        },
        onInputText: (text, final) => this.onInputText(text, final),
        onOutputText: (text, final) => this.onOutputText(text, final),
        onInterrupted: () => this.onInterrupted(),
        onTurnComplete: () => this.onTurnComplete(),
        onToolCall: (calls) => this.onToolCalls(calls),
        onGoAway: (ms) => this.onGoAway(ms),
        onError: (err) => {
          log.warn('live provider error', { sessionId: this.sessionId, error: err.message });
        },
        onClose: (reason) => this.onProviderClosed(reason),
      },
    };
    this.session = await this.provider.connect(opts);
  }

  /** Stop the provider session. The call itself stays open so the caller can reconnect. */
  close(reason = 'client_closed'): void {
    if (this.closed) return;
    this.closed = true;
    if (this.goAwayTimer) clearTimeout(this.goAwayTimer);
    this.unsubscribe?.();
    this.session?.close();
    this.session = null;
    try {
      emitTimeline(this.sessionId, { type: 'voice.disconnected', stage: 'understand', title: 'Live voice disconnected', detail: reason, status: 'info', source: 'voice bridge' });
    } catch {
      /* the call may have been removed (demo reset); nothing to record against */
    }
  }

  /* ------------------------------------------------------------------ browser → server */

  onClientAudio(b64: string): void {
    if (this.closed || this.muted || !this.session || this.reconnecting) return;
    this.session.sendAudio(b64);
  }

  setMuted(muted: boolean): void {
    if (this.muted === muted) return;
    this.muted = muted;
    emitTimeline(this.sessionId, { type: muted ? 'voice.muted' : 'voice.unmuted', stage: 'understand', title: muted ? 'Microphone muted — Lily is not listening' : 'Microphone on — Lily is listening', status: 'info', source: 'voice bridge' });
  }

  /** The customer typed instead of speaking while the call is live. Same back end, same rules. */
  async onClientText(text: string): Promise<void> {
    const clean = text.trim().slice(0, 1000);
    if (!clean || this.closed) return;
    this.send({ type: 'phase', phase: 'processing' });
    const before = this.maxSeq();
    try {
      await handleInput(this.sessionId, { kind: 'utterance', text: clean, clientMessageId: `typed-${Date.now().toString(36)}-${++this.turnCounter}` });
    } catch (e) {
      this.send({ type: 'error', code: e instanceof AppError ? e.code : 'INTERNAL', message: e instanceof AppError ? e.message : 'That could not be processed.' });
    }
    const said = this.turnsAfter(before).filter((t) => t.speaker !== 'customer').map((t) => t.text);
    this.syncTurns();
    this.pushView();
    this.send({ type: 'phase', phase: 'idle' });
    if (said.length && this.session) this.session.sendText(`The customer typed a message instead of speaking, and the banking back end replied: "${said.join(' ')}". Say that reply to them naturally, keeping every fact exactly. Do not add anything.`);
  }

  async endCall(): Promise<void> {
    try {
      await handleInput(this.sessionId, { kind: 'hangup' });
    } catch (e) {
      log.warn('hangup failed', { sessionId: this.sessionId, error: (e as Error).message });
    }
    this.syncTurns();
    this.send({ type: 'ended', view: buildCallView(this.sessionId, { audience: 'caller' }) });
    this.close('call_ended');
  }

  /* ------------------------------------------------------------------ provider → server */

  private onInputText(text: string, final: boolean): void {
    // A new customer turn begins after the previous one was consumed or closed.
    if (this.userConsumed) {
      this.userText = '';
      this.userConsumed = false;
    }
    this.userText += text;
    this.lastUserChunkAt = Date.now();
    this.send({ type: 'partial', speaker: 'customer', text: this.userText.trim() });
    void final;
  }

  private onOutputText(text: string, final: boolean): void {
    this.modelSpoke = true;
    if (this.toolSpeechPending) this.toolSpeechStarted = true;
    this.modelText += text;
    if (!this.suppressModelText) this.send({ type: 'partial', speaker: 'assistant', text: this.modelText.trim() });
    void final;
  }

  /**
   * The customer's turn is over (the model turn ended or was interrupted). Anything a tool did not
   * take is ordinary conversation and is recorded as such. It is deliberately NOT closed when the
   * model starts speaking: Lily may say "let me check" before the tool call arrives.
   */
  private closeUserTurn(): void {
    const text = this.userText.trim();
    if (text && !this.userConsumed) {
      addTurn(this.sessionId, 'customer', normaliseSpoken(text), { kind: 'voice' });
      this.userConsumed = true;
      this.syncTurns();
    }
    this.send({ type: 'partial', speaker: 'customer', text: '' });
  }

  private onInterrupted(): void {
    this.send({ type: 'interrupted' });
    // What the customer said before barging in was an ordinary turn unless a tool already took it.
    this.closeUserTurn();
    this.flushModelTurn(true);
    emitTimeline(this.sessionId, { type: 'voice.barge_in', stage: 'understand', title: 'Customer spoke over Lily — playback stopped', status: 'info', source: 'voice bridge' });
    void handleInput(this.sessionId, { kind: 'interrupt' }).catch(() => undefined);
  }

  private onTurnComplete(): void {
    this.closeUserTurn();
    this.flushModelTurn(false);
    this.send({ type: 'partial', speaker: 'assistant', text: '' });
  }

  /** Persist what Lily said ONLY when she spoke freely (no tool result owns this turn). */
  private flushModelTurn(interrupted: boolean): void {
    const text = this.modelText.trim();
    if (text && !this.suppressModelText) {
      addTurn(this.sessionId, 'assistant', interrupted ? `${text} …` : text, { kind: interrupted ? 'voice_interrupted' : 'voice' });
      this.syncTurns();
      if (this.awaitingGreeting && !interrupted) {
        this.awaitingGreeting = false;
        emitTimeline(this.sessionId, { type: 'disclosure.given', stage: 'understand', title: 'Lily introduced herself as an AI assistant', detail: 'Spoken greeting recorded in the transcript; the recording and privacy notice is shown on screen.', status: 'ok', source: 'voice bridge' });
      }
    }
    this.modelText = '';
    this.modelSpoke = false;
    // Keep suppressing until the spoken result of a tool call has been heard (or she was interrupted).
    if (interrupted || !this.toolSpeechPending || this.toolSpeechStarted) {
      this.suppressModelText = false;
      this.toolSpeechPending = false;
      this.toolSpeechStarted = false;
    }
  }

  private onToolCalls(calls: LiveToolCall[]): void {
    // Serialise: tool calls are handled strictly in order, and each one is fully validated server-side.
    for (const call of calls) this.toolQueue = this.toolQueue.then(() => this.runOne(call));
  }

  private async runOne(call: LiveToolCall): Promise<void> {
    if (this.closed || !this.session) return;
    this.send({ type: 'phase', phase: 'processing', tool: call.name });
    await this.waitForCustomerWords();
    const turnId = String(++this.turnCounter);
    const customerText = this.userConsumed ? '' : normaliseSpoken(this.userText.trim());
    const result = await runTool(call.name, call.args, {
      sessionId: this.sessionId,
      customerText,
      turnId,
      consumeCustomerText: () => {
        this.userConsumed = true;
      },
    });
    // The orchestrator owns the transcript for this turn; Lily's paraphrase must not be stored twice.
    this.suppressModelText = true;
    this.toolSpeechPending = true;
    this.toolSpeechStarted = false;
    this.modelText = '';
    this.send({ type: 'partial', speaker: 'customer', text: '' });
    this.syncTurns();
    this.pushView();
    this.send({ type: 'phase', phase: 'idle' });
    if (this.closed || !this.session) return;
    this.session.sendToolResponse({ id: call.id, name: call.name }, result);
  }

  /** The recogniser may deliver the final words just after the tool call: wait until they settle. */
  private async waitForCustomerWords(): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < TEXT_WAIT_MAX_MS) {
      const quiet = Date.now() - this.lastUserChunkAt >= TEXT_WAIT_QUIET_MS;
      if (this.userText.trim() && !this.userConsumed && quiet) return;
      if (this.userConsumed && Date.now() - start > TEXT_WAIT_QUIET_MS) return;
      await new Promise((r) => setTimeout(r, 60));
    }
  }

  /* ------------------------------------------------------------------ resilience */

  private onGoAway(timeLeftMs: number | null): void {
    emitTimeline(this.sessionId, { type: 'voice.session_limit', stage: 'understand', title: 'Voice session is reaching its time limit — reconnecting', status: 'warn', source: 'voice bridge' });
    const wait = Math.max(500, (timeLeftMs ?? 5000) - 3000);
    this.goAwayTimer = setTimeout(() => void this.reconnect('session limit'), wait);
  }

  private onProviderClosed(reason: string): void {
    if (this.closed || this.reconnecting) return;
    const ended = getContext(this.sessionId).stage === 'ended';
    if (ended) return;
    void this.reconnect(reason || 'connection closed');
  }

  private async reconnect(why: string): Promise<void> {
    if (this.closed || this.reconnecting) return;
    this.reconnecting = true;
    this.send({ type: 'voice', status: 'reconnecting', message: 'Voice connection interrupted. Reconnecting…' });
    emitTimeline(this.sessionId, { type: 'voice.reconnecting', stage: 'understand', title: 'Voice connection lost — reconnecting', detail: why, status: 'warn', source: 'voice bridge' });
    const old = this.session;
    this.session = null;
    try {
      old?.close();
    } catch {
      /* already gone */
    }
    while (!this.closed && this.reconnects < MAX_RECONNECTS) {
      this.reconnects++;
      await new Promise((r) => setTimeout(r, 800 * this.reconnects));
      try {
        this.userText = '';
        this.userConsumed = false;
        this.modelText = '';
        this.suppressModelText = false;
        await this.openProviderSession(true);
        this.reconnecting = false;
        this.reconnects = 0;
        this.send({ type: 'voice', status: 'restored', message: 'Voice restored.' });
        emitTimeline(this.sessionId, { type: 'voice.connected', stage: 'understand', title: 'Voice connection restored', status: 'ok', source: 'voice bridge' });
        return;
      } catch (e) {
        log.warn('live reconnect failed', { sessionId: this.sessionId, attempt: this.reconnects, error: (e as Error).message });
      }
    }
    this.reconnecting = false;
    if (this.closed) return;
    this.send({ type: 'voice', status: 'lost', message: 'Voice could not be restored. You can keep going by typing; nothing on the call was lost.' });
    emitTimeline(this.sessionId, { type: 'voice.lost', stage: 'understand', title: 'Voice could not be restored — text fallback available', status: 'failed', source: 'voice bridge' });
  }

  /* ------------------------------------------------------------------ server → browser */

  private onTimeline(e: TimelineEvent): void {
    this.send({ type: 'timeline', event: e });
    if (e.type === 'handoff.connected') {
      this.syncTurns();
      this.pushView();
      // Confirmed by the system: only now may Lily say an agent has joined.
      this.session?.sendText(`SYSTEM EVENT (confirmed): ${redactText(e.title)}. Tell the customer in one short sentence that an agent has accepted their case, then stay quiet unless they speak.`);
    } else if (e.type.startsWith('handoff.') || e.type === 'call.closed') {
      this.syncTurns();
      this.pushView();
    }
  }

  private pushView(): void {
    const view = buildCallView(this.sessionId, { audience: 'caller' });
    if (view) this.send({ type: 'view', view });
  }

  private syncTurns(): void {
    const turns = all<{ seq: number; speaker: string; kind: string; text: string; created_at: string }>(
      'SELECT seq, speaker, kind, text, created_at FROM conversation_turns WHERE session_id = ? AND seq > ? ORDER BY seq',
      [this.sessionId, this.lastSentSeq],
    );
    if (!turns.length) return;
    this.lastSentSeq = turns[turns.length - 1].seq;
    this.send({ type: 'turns', turns: turns.map((t) => ({ seq: t.seq, speaker: t.speaker, kind: t.kind, text: t.text, at: t.created_at })) });
  }

  private maxSeq(): number {
    return get<{ m: number | null }>('SELECT MAX(seq) m FROM conversation_turns WHERE session_id = ?', [this.sessionId])?.m ?? 0;
  }
  private turnsAfter(seq: number) {
    return all<{ seq: number; speaker: string; text: string }>('SELECT seq, speaker, text FROM conversation_turns WHERE session_id = ? AND seq > ? ORDER BY seq', [this.sessionId, seq]);
  }
  private turnsSoFar() {
    return all<{ speaker: string; text: string }>('SELECT speaker, text FROM conversation_turns WHERE session_id = ? ORDER BY seq', [this.sessionId]);
  }
  private recap(): string {
    return this.turnsSoFar()
      .slice(-12)
      .map((t) => `${t.speaker === 'customer' ? 'Customer' : 'Lily/system'}: ${t.text}`)
      .join('\n');
  }
}

export function auditLiveStart(sessionId: string, provider: string): void {
  audit({ actor: ASSISTANT, event: 'live.session_started', status: 'ok', sessionId, metadata: { provider } });
}
