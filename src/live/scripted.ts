/**
 * SCRIPTED STAND-IN for a live speech provider. It exists so the whole bridge (tools, guards,
 * transcripts, barge-in, handover) can be exercised end to end without calling Google. It is
 * only constructible when NODE_ENV=test; it is never offered at runtime.
 */
import type { LiveConnectOptions, LiveProvider, LiveSession, LiveToolCall } from './provider.ts';

export class ScriptedSession implements LiveSession {
  readonly audioIn: string[] = [];
  readonly texts: string[] = [];
  readonly toolResponses: { id: string; name: string; response: Record<string, unknown> }[] = [];
  closed = false;
  constructor(public readonly opts: LiveConnectOptions) {}

  sendAudio(b64: string): void {
    this.audioIn.push(b64);
  }
  sendText(text: string): void {
    this.texts.push(text);
  }
  sendToolResponse(call: { id: string; name: string }, response: Record<string, unknown>): void {
    this.toolResponses.push({ id: call.id, name: call.name, response });
  }
  close(): void {
    this.closed = true;
  }

  /* Test controls: emulate what the provider would deliver. */
  heard(text: string, final = true): void {
    this.opts.events.onInputText(text, final);
  }
  said(text: string, final = true): void {
    this.opts.events.onOutputText(text, final);
  }
  audioOut(b64 = 'AAAA'): void {
    this.opts.events.onAudio(b64);
  }
  interrupt(): void {
    this.opts.events.onInterrupted();
  }
  turnComplete(): void {
    this.opts.events.onTurnComplete();
  }
  toolCall(name: string, args: Record<string, unknown> = {}, id = `call-${Math.random().toString(36).slice(2, 8)}`): LiveToolCall {
    const c = { id, name, args };
    this.opts.events.onToolCall([c]);
    return c;
  }
  drop(reason = 'network'): void {
    this.opts.events.onClose(reason);
  }
}

export class ScriptedProvider implements LiveProvider {
  readonly name = 'scripted-test';
  readonly model = 'scripted';
  static sessions: ScriptedSession[] = [];
  static failNext: Error | null = null;

  constructor() {
    if (process.env.NODE_ENV !== 'test') throw new Error('The scripted live provider is only available under NODE_ENV=test');
  }
  static reset(): void {
    ScriptedProvider.sessions = [];
    ScriptedProvider.failNext = null;
  }
  static get last(): ScriptedSession {
    const s = ScriptedProvider.sessions.at(-1);
    if (!s) throw new Error('no scripted session');
    return s;
  }
  async connect(opts: LiveConnectOptions): Promise<LiveSession> {
    if (ScriptedProvider.failNext) {
      const e = ScriptedProvider.failNext;
      ScriptedProvider.failNext = null;
      throw e;
    }
    const s = new ScriptedSession(opts);
    ScriptedProvider.sessions.push(s);
    return s;
  }
}
