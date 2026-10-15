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
import { getContext, handleInput, observeSpeech, setAgentLang } from '../conversation/orchestrator.ts';
import { addTurn } from '../handoff/handoff-service.ts';
import { buildCallView } from '../api/views.ts';
import type { LiveConnectOptions, LiveProvider, LiveSession, LiveToolCall } from './provider.ts';
import { LILY_TOOLS, TOOL, lilySystemInstruction } from './lily.ts';
import { LANGUAGES, isLang, type LangCode } from './languages.ts';
import { runTool } from './tools.ts';
import { normaliseSpoken } from './speech.ts';
import { knownForAssistant } from '../conversation/facts.ts';

export type ServerMessage =
  | { type: 'ready'; provider: string; model: string; resumed: boolean; agent: { lang: string; name: string } }
  | { type: 'agent'; lang: string; name: string; from: string }
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
  /**
   * Incremented every time a provider session is replaced (language change, reconnect). Callbacks
   * capture the epoch they were created with: a socket that is closing can still deliver buffered
   * audio and text, and without this guard those frames reach the browser while the new agent is
   * already speaking, so two voices play over each other.
   */
  private epoch = 0;
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
  private pendingTools = 0;
  private lastSentSeq = 0;
  private unsubscribe: (() => void) | null = null;
  private goAwayTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly sessionId: string,
    private readonly send: (m: ServerMessage) => void,
    private readonly provider: LiveProvider,
    private language: LangCode = 'en',
  ) {}

  /** Set when the customer agreed to move to another agent; applied once the current agent finishes the handover sentence. */
  private pendingAgent: LangCode | null = null;
  private pendingAgentTimer: NodeJS.Timeout | null = null;

  /* ------------------------------------------------------------------ lifecycle */

  async start(): Promise<void> {
    this.lastSentSeq = 0;
    // A resumed call keeps the agent it had; a new call always starts with Lily.
    const saved = getContext(this.sessionId).agentLang;
    this.language = isLang(saved) ? saved : 'en';
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
    this.send({ type: 'ready', provider: this.provider.name, model: this.provider.model, resumed, agent: { lang: this.language, name: LANGUAGES[this.language].agent } });
    this.syncTurns();
    this.pushView();
    emitTimeline(this.sessionId, { type: 'voice.connected', stage: 'understand', title: resumed ? 'Voice connection restored' : 'Live voice connected', detail: `${this.provider.name} · ${this.provider.model}`, status: 'ok', source: 'voice bridge' });
    if (!resumed) {
      this.awaitingGreeting = true;
      this.session?.sendText('The customer has just connected. Greet them now, following your instructions.');
    }
  }

  private async openProviderSession(resumed: boolean, joinedFrom: LangCode | null = null): Promise<void> {
    const mine = ++this.epoch;
    /** False once this session has been replaced: its remaining frames belong to no one. */
    const current = () => this.epoch === mine && !this.closed;
    const opts: LiveConnectOptions = {
      systemInstruction: lilySystemInstruction({ recap: resumed ? this.recap() : null, language: this.language, joinedFrom }),
      voice: this.language === 'en' ? undefined : LANGUAGES[this.language].voice,
      tools: LILY_TOOLS,
      events: {
        onAudio: (b64) => {
          if (!current()) return;
          this.modelSpoke = true;
          this.send({ type: 'audio', data: b64 });
        },
        onInputText: (text, final) => { if (current()) this.onInputText(text, final); },
        onOutputText: (text, final) => { if (current()) this.onOutputText(text, final); },
        onInterrupted: () => { if (current()) this.onInterrupted(); },
        onTurnComplete: () => { if (current()) this.onTurnComplete(); },
        onToolCall: (calls) => { if (current()) this.onToolCalls(calls); },
        onGoAway: (ms) => { if (current()) this.onGoAway(ms); },
        onError: (err) => {
          log.warn('live provider error', { sessionId: this.sessionId, error: err.message, stale: !current() });
        },
        onClose: (reason) => { if (current()) this.onProviderClosed(reason); },
      },
    };
    this.session = await this.provider.connect(opts);
  }

  /** Stop the provider session. The call itself stays open so the caller can reconnect. */
  close(reason = 'client_closed'): void {
    if (this.closed) return;
    this.closed = true;
    if (this.goAwayTimer) clearTimeout(this.goAwayTimer);
    if (this.pendingAgentTimer) clearTimeout(this.pendingAgentTimer);
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
    // A tool call is waiting to run: it takes these words itself.
    if (text && !this.userConsumed && this.pendingTools > 0) return;
    if (text && !this.userConsumed) {
      // Not taken by a tool: still part of what the customer told us. The back end records it,
      // captures its details into the call facts and keeps it for the next step, so the customer
      // is never asked for it again. Tool calls are queued behind this, so ordering is kept.
      this.userConsumed = true;
      const said = normaliseSpoken(text);
      this.toolQueue = this.toolQueue.then(() =>
        observeSpeech(this.sessionId, said)
          .catch((e) => log.warn('could not record customer speech', { sessionId: this.sessionId, error: (e as Error).message }))
          .then(() => this.syncTurns()),
      );
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
    // The outgoing agent has finished the handover sentence: bring in the next one.
    if (this.pendingAgent) void this.performAgentSwitch();
  }

  /* ------------------------------------------------------------------ agent handover (language) */

  /** The customer agreed to another language. The outgoing agent says one short line, then the call moves. */
  private requestAgentSwitch(call: LiveToolCall): void {
    const to = call.args.language;
    if (!isLang(to) || to === this.language) {
      this.session?.sendToolResponse({ id: call.id, name: call.name }, { ok: false, message: 'That agent already has the call. Carry on.' });
      return;
    }
    this.pendingAgent = to;
    // If the turn never completes (dropped audio), the move still happens.
    this.pendingAgentTimer = setTimeout(() => void this.performAgentSwitch(), 7000);
    this.suppressModelText = false;
    this.session?.sendToolResponse({ id: call.id, name: call.name }, { ok: true, message: `Say one short sentence in the current language handing the call to ${LANGUAGES[to].agent}, who speaks ${LANGUAGES[to].name}. Say nothing else; ${LANGUAGES[to].agent} will take over.` });
  }

  private async performAgentSwitch(): Promise<void> {
    const to = this.pendingAgent;
    if (!to || this.closed || this.reconnecting) return;
    this.pendingAgent = null;
    if (this.pendingAgentTimer) clearTimeout(this.pendingAgentTimer);
    const from = this.language;
    this.reconnecting = true;
    const old = this.session;
    this.session = null;
    this.epoch++; // anything still arriving from the outgoing session is now ignored
    try { old?.close(); } catch { /* already gone */ }
    // Stop whatever the outgoing agent had already streamed: the browser plays its queue to the end
    // otherwise, and the incoming agent's greeting lands on top of it.
    this.send({ type: 'interrupted' });
    this.language = to;
    setAgentLang(this.sessionId, to);
    addTurn(this.sessionId, 'system', `${LANGUAGES[from].agent} passed the call to ${LANGUAGES[to].agent} (${LANGUAGES[to].name}).`, { kind: `agent_switch:${LANGUAGES[to].agent}` });
    emitTimeline(this.sessionId, { type: 'agent.switched', stage: 'understand', title: `${LANGUAGES[to].agent} (${LANGUAGES[to].name}) took over from ${LANGUAGES[from].agent}`, detail: 'The customer agreed to the language change. Everything already known was carried across.', status: 'ok', source: 'voice bridge' });
    this.syncTurns();
    this.userText = ''; this.userConsumed = false; this.modelText = ''; this.suppressModelText = false;
    for (let attempt = 1; attempt <= MAX_RECONNECTS && !this.closed; attempt++) {
      try {
        await this.openProviderSession(true, from);
        this.reconnecting = false;
        this.send({ type: 'agent', lang: to, name: LANGUAGES[to].agent, from: LANGUAGES[from].agent });
        this.awaitingGreeting = false;
        (this.session as LiveSession | null)?.sendText(`You have just taken over the call from ${LANGUAGES[from].agent}. Introduce yourself now, following your instructions.`);
        this.pushView();
        return;
      } catch (e) {
        log.warn('agent switch failed to connect', { sessionId: this.sessionId, attempt, error: (e as Error).message });
        await new Promise((r) => setTimeout(r, 600 * attempt));
      }
    }
    this.reconnecting = false;
    if (!this.closed) {
      this.language = from;
      setAgentLang(this.sessionId, from);
      this.send({ type: 'voice', status: 'lost', message: 'The language change did not connect. You can keep going by typing; nothing on the call was lost.' });
    }
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
    this.pendingTools += calls.length;
    for (const call of calls) this.toolQueue = this.toolQueue.then(() => this.runOne(call)).finally(() => { this.pendingTools--; });
  }

  private async runOne(call: LiveToolCall): Promise<void> {
    if (this.closed || !this.session) return;
    if (call.name === TOOL.switch) return this.requestAgentSwitch(call);
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
    const known = knownForAssistant(getContext(this.sessionId).facts);
    const lines = this.turnsSoFar()
      .slice(-12)
      .map((t) => `${t.speaker === 'customer' ? 'Customer' : 'Agent/system'}: ${t.text}`);
    const facts = Object.entries(known).map(([k, v]) => `- ${k}: ${v}`);
    return [...lines, ...(facts.length ? ['', 'Already known (do not ask again):', ...facts] : [])].join('\n');
  }
}

export function auditLiveStart(sessionId: string, provider: string): void {
  audit({ actor: ASSISTANT, event: 'live.session_started', status: 'ok', sessionId, metadata: { provider } });
}
