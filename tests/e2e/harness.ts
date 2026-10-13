import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.ts';
import { freshDb } from '../helpers.ts';
import { SCENARIOS } from '../../src/db/scenarios.ts';
import { get, all } from '../../src/db/db.ts';

export type View = any;

export async function setup(opts: { history?: boolean } = {}) {
  freshDb(opts);
  return buildApp();
}

let msgSeq = 0;

/** Drives the API exactly like the simulator UI does. */
export class Caller {
  sessionId = '';
  token = '';
  view: View = null;
  constructor(private app: FastifyInstance) {}

  async start(scenarioId?: string, extra: Record<string, unknown> = {}) {
    const r = await this.app.inject({ method: 'POST', url: '/api/calls', payload: { ...(scenarioId ? { scenarioId } : {}), ...extra } });
    if (r.statusCode !== 201) throw new Error(`start failed ${r.statusCode} ${r.body}`);
    const b = r.json();
    this.sessionId = b.sessionId;
    this.token = b.callToken;
    this.view = b.view;
    return this.view;
  }
  async input(payload: Record<string, unknown>, expectStatus = 200) {
    const r = await this.app.inject({ method: 'POST', url: `/api/calls/${this.sessionId}/input`, headers: { 'x-call-token': this.token }, payload });
    if (r.statusCode !== expectStatus) throw new Error(`input ${JSON.stringify(payload)} → ${r.statusCode} ${r.body}`);
    this.view = r.json();
    return this.view;
  }
  say(text: string, extra: Record<string, unknown> = {}) {
    return this.input({ kind: 'utterance', text, clientMessageId: `m${++msgSeq}`, ...extra });
  }
  async verify(scenarioId: string) {
    const s = SCENARIOS.find((x) => x.id === scenarioId)!;
    await this.say(`my date of birth is ${s.customer.dob}`);
    const code = this.view.demoDevice?.code;
    if (!code) throw new Error(`no OTP shown; last: ${this.lastAssistant()}`);
    return this.say(code);
  }
  consent(decision: 'accept' | 'decline' = 'accept') {
    return this.input({ kind: 'consent', proposalId: this.view.proposal.id, decision, clientMessageId: `m${++msgSeq}` });
  }
  async refresh() {
    const r = await this.app.inject({ method: 'GET', url: `/api/calls/${this.sessionId}`, headers: { 'x-call-token': this.token } });
    this.view = r.json();
    return this.view;
  }
  lastAssistant(): string {
    const t = this.view.transcript.filter((x: any) => x.speaker !== 'customer');
    return t.map((x: any) => x.text).slice(-3).join('\n---\n');
  }
  transcriptText(): string {
    return this.view.transcript.map((x: any) => `${x.speaker}: ${x.text}`).join('\n');
  }
  ops() {
    return all<any>('SELECT * FROM action_operations WHERE session_id = ? ORDER BY requested_at', [this.sessionId]);
  }
  session() {
    return get<any>('SELECT * FROM call_sessions WHERE id = ?', [this.sessionId]);
  }
  caseRow() {
    return get<any>('SELECT * FROM cases WHERE session_id = ?', [this.sessionId]);
  }
}

export async function staffLogin(app: FastifyInstance, userId: string): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/api/auth/demo-login', payload: { userId } });
  if (r.statusCode !== 200) throw new Error(r.body);
  const c = r.cookies.find((x) => x.name === 'hio_staff')!;
  return `hio_staff=${c.value}`;
}
