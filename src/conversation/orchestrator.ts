/**
 * CONVERSATION ORCHESTRATOR — a deterministic dialogue state machine.
 *
 * The same orchestrator serves the text simulator, the optional browser-voice channel and
 * any future telephony channel. It owns dialogue state only; verification, retrieval,
 * eligibility, policy, actions, cases and handoff live in their own services. The intent
 * model is used solely to classify and extract; it never decides or authorises.
 *
 * Every input is serialised per session (in-process lock) and persisted, so a page reload or
 * server restart resumes from the stored context.
 */
import { GeminiIntentModel, HybridIntentModel } from '../ai/intent-gemini.ts';
import { env } from '../config/env.ts';
import { policy, type IssueType } from '../config/policy.ts';
import { all, get, parseJson, run, tx } from '../db/db.ts';
import { nowIso, nowMs } from '../lib/clock.ts';
import { newId, sha256 } from '../lib/ids.ts';
import { AppError } from '../lib/errors.ts';
import { redactText } from '../lib/redact.ts';
import { log } from '../lib/logger.ts';
import { audit, ASSISTANT, type Actor } from '../audit/audit.ts';
import { activeFaults } from '../adapters/mock/faults.ts';
import { adapters } from '../adapters/registry.ts';
import { AnthropicIntentModel, RulesIntentModel, detectSignals, extractSlots, type Classification, type IntentModel, type IssueSlots } from '../ai/intent.ts';
import { isCorrection, normaliseMerchant, parseOrdinalChoice, parseYesNo } from '../ai/parsers.ts';
import { analyseCall } from '../analysis/analysis.ts';
import { initialVerification, isVerified, startVerification, submitVerificationAnswer, type VerificationState } from '../verification/verification.ts';
import { readCheck, submitAgentCheck, type AgentCheck } from '../verification/agent-check.ts';
import { retrieveFacts, loadSnapshot, sourceData, type Snapshot } from '../retrieval/retrieval.ts';
import { WORKFLOWS } from '../workflows/index.ts';
import type { Choice, ProposedAction, WorkflowCtx, WorkflowResult, WorkflowState } from '../workflows/types.ts';
import { addRiskFlag, caseEvent, ensureCase, recordFindings, regenerateSummary, updateCase } from '../cases/case-service.ts';
import { createDisputeDraft } from '../disputes/dispute-service.ts';
import { confirmAndExecute, declineAction, getOp, opsForSession, prepareAction, reconcile, retryAction, type Operation } from '../actions/action-service.ts';
import { addTurn, requestHandoff } from '../handoff/handoff-service.ts';
import * as M from './messages.ts';
import { emitTimeline, type TimelineInput, type Stage as TStage } from '../events/timeline.ts';
import { computeTags, diffTags, sentimentFrom, type CallTags } from './tags.ts';
import { knowledgeBase, recordKbReference } from '../kb/kb.ts';
import { profileById, PROFILE_DEFS } from '../live/profiles.ts';
import { refreshDemoFixtures } from '../db/seed.ts';
import { SCENARIOS, scenarioById } from '../db/scenarios.ts';
import { maskPhone } from '../lib/redact.ts';
import { HANDOFF_REASON_LABELS, ISSUE_LABELS, formatDate, formatMoney } from './format.ts';
import { createTicket } from '../crm/crm.ts';
import { answerFromInfo, NOT_FOUND, NOT_FOUND_AGAIN } from '../kb/bank-info.ts';
import { THIRD_PARTY, assessContactRisk, checkNationalId, contactChangeKind, parseNationalIdLast4, READ_ALOUD, STEP_UP_MAX_ATTEMPTS, type Assurance, type ContactKind, type Risk } from './security.ts';
import { sideTalk } from './sidetalk.ts';
import { FAREWELL, LET_ME_TALK } from '../ai/parsers.ts';
import { normaliseSpoken } from '../live/speech.ts';
import { type Facts, factsFromCustomerText, setFact, setIssueFacts } from './facts.ts';
import { readUnavailable, saysCredentialUnavailable } from './unavailable.ts';
import { assistantMayAct, assistantMayHandleCalls, safetyState, OFF_MESSAGE, PAUSED_DETAIL } from '../safety/control.ts';

export type Stage =
  | 'awaiting_issue'
  | 'clarifying_issue'
  | 'identifying'
  | 'awaiting_dob'
  | 'awaiting_otp'
  | 'awaiting_card'
  | 'stepup'
  | 'workflow'
  | 'wrap_up'
  | 'awaiting_survey'
  | 'handoff'
  | 'ended'
  | 'fallback';

type Pending =
  | { kind: 'choice'; purpose: string; options: Choice[]; scope: 'issue' | 'workflow' }
  | { kind: 'consent'; proposalId: string }
  | { kind: 'yes_no'; purpose: string; agentReason?: string; resume?: Pending; resumePrompt?: string }
  | { kind: 'free_text'; purpose: string };

export interface CallContext {
  stage: Stage;
  issue: (Omit<Classification, 'slots'> & { statement: string; slots: IssueSlots; clarifications: number }) | null;
  verification: VerificationState;
  snapshotId: string | null;
  caseId: string | null;
  wf: WorkflowState | null;
  pending: Pending | null;
  resume: { proposalId: string; consentId: string } | null;
  silenceCount: number;
  unclearCount: number;
  distressCount: number;
  lastPrompt: string;
  flags: string[];
  lastUtterance: { hash: string; at: string; prompt?: string } | null;
  firstName: string | null;
  /** Free-talk demo mode: the synthetic persona is chosen from the caller's intent. */
  freeMode?: boolean;
  persona?: { scenarioId: string; name: string; customerNumber: string; phoneMasked: string } | null;
  sentiment?: { sentiment: CallTags['sentiment']; basis: string } | null;
  tags?: CallTags | null;
  /** Further banking topics raised after the first was handled, in the same verified call. */
  secondary?: { issueType: IssueType; at: string }[];
  /** Northstar demo: which identity check this call uses. Defaults to date of birth + passcode. */
  verificationMode?: 'dob_otp' | 'card_number';
  /** Active demo customer profile for this call (server-side context). */
  profileId?: string | null;
  /** Structured memory of the call: what is known, with status and source (see facts.ts). */
  facts?: Facts;
  /** The caller is not pre-identified: the card number they give identifies and verifies them. */
  cardIdentify?: boolean;
  /** Last general topic answered, so a short follow-up such as "how do I do it at an ATM" keeps its subject. */
  lastInfoTopic?: string;
  /** The one reference the caller is given for an escalation: spoken on the call and shown on screen. */
  escalationRef?: string | null;
  /** A passcode check the human agent asked for. Kept here so it survives a reconnect. */
  agentCheck?: AgentCheck;
  /** How many times a person was offered after an unclear request, so the wording changes. */
  offerCount?: number;
  /** How many times the bank information had no answer, so the wording alternates. */
  notFoundCount?: number;
  /** Which virtual agent currently has the call (en = Lily, my = Hnin, fil = Maya). */
  agentLang?: string;
  /** How many times in a row the card number could not be read; picks gentler, more specific help each time. */
  cardUnparsed?: number;
  /** The caller has said they cannot supply a credential: it is not asked for a third time. */
  cannotSupply?: { card?: boolean; phone?: boolean; otp?: boolean };
  /** The second identity route (date of birth and a passcode) has been offered once. */
  altOffered?: boolean;
  /** Answers in a row that were not the credential asked for, so the same thing is not asked again. */
  unparsed?: { step: string; n: number } | null;
  /** basic = normal identity check passed. strong = also passed the second-level check in this call. */
  assurance?: Assurance;
  /** A second-level check is being asked for; `then` is what happens once it passes. */
  stepUp?: { then: 'contact' | 'readout'; returnTo: Stage; attempts: number; unparsed: number } | null;
  /** A contact-detail change in progress (collected and confirmed here, applied only by a person). */
  contact?: { kind: ContactKind; step: 'value' | 'confirm1' | 'confirm2'; value?: string; risk: Risk; tries: number } | null;
  /** True for exactly one answer, after the customer confirmed it is safe to read account activity aloud. */
  readoutOk?: boolean;
}

/** Default synthetic persona per issue type for free-talk demos (no injected faults). */
export const FREE_TALK_PERSONA: Record<IssueType, string> = {
  unrecognised_transaction: 'S01',
  lost_stolen_card: 'S02',
  wrong_or_duplicate_charge: 'S03',
  payment_not_showing: 'S04',
  fee_query: 'S05',
  card_declined: 'S19',
  account_inquiry: 'S01',
};

export type CallInput =
  | { kind: 'utterance'; text: string; clientMessageId?: string; asrConfidence?: number }
  | { kind: 'choice'; optionId: string; clientMessageId?: string }
  | { kind: 'consent'; proposalId: string; decision: 'accept' | 'decline'; clientMessageId?: string }
  | { kind: 'request_human'; clientMessageId?: string; spokenText?: string }
  | { kind: 'silence' }
  | { kind: 'interrupt' }
  | { kind: 'reconcile'; clientMessageId?: string }
  | { kind: 'hangup' }
  | { kind: 'survey'; score: number };

interface Session {
  id: string;
  correlationId: string;
  scenarioId: string | null;
  dataOrigin: string;
  ctx: CallContext;
  actor: Actor;
}

/* ------------------------------------------------------------------------- session store */

const locks = new Map<string, Promise<unknown>>();
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => (release = r));
  const chained = prev.then(() => next);
  locks.set(key, chained);
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === chained) locks.delete(key);
  }
}

function load(sessionId: string): Session {
  const r = get<{ id: string; correlation_id: string; scenario_id: string | null; data_origin: string; context_json: string }>(
    'SELECT id, correlation_id, scenario_id, data_origin, context_json FROM call_sessions WHERE id = ?',
    [sessionId],
  );
  if (!r) throw new AppError('NOT_FOUND', 'Call not found.');
  return { id: r.id, correlationId: r.correlation_id, scenarioId: r.scenario_id, dataOrigin: r.data_origin, ctx: JSON.parse(r.context_json), actor: { type: 'customer_session', id: r.id } };
}

function save(s: Session): void {
  run('UPDATE call_sessions SET context_json = ?, state = ?, version = version + 1, updated_at = ? WHERE id = ?', [JSON.stringify(s.ctx), s.ctx.stage, nowIso(), s.id]);
}

function event(s: Session, type: string, detail: Record<string, unknown> = {}): void {
  run('INSERT INTO session_events (session_id, event_type, detail_json, created_at) VALUES (?,?,?,?)', [s.id, type, JSON.stringify(detail), nowIso()]);
}

function say(s: Session, text: string, speaker: 'assistant' | 'system' = 'assistant'): void {
  if (!text.trim()) return;
  addTurn(s.id, speaker, text);
  if (speaker === 'assistant') s.ctx.lastPrompt = text;
}

function tl(s: Session, e: TimelineInput): void {
  emitTimeline(s.id, { ref: s.ctx.caseId ?? s.correlationId, ...e });
}

/** Recompute live call tags and record how the classification changed. */
function refreshTags(s: Session, stage: TStage): void {
  const t = computeTags(s.id, { issue: s.ctx.issue, sentiment: s.ctx.sentiment, flags: s.ctx.flags, secondary: s.ctx.secondary?.map((x) => x.issueType) });
  const changes = diffTags(s.ctx.tags, t);
  if (!s.ctx.tags && t.intent) {
    tl(s, { type: 'call.tagged', stage, title: `Call tagged: ${t.intentLabel} · ${t.category}`, detail: `Urgency ${t.urgency} (${t.urgencyReason}). Sentiment ${t.sentiment} — indicative only.`, source: 'classification', data: { tags: t } });
  } else if (changes.length) {
    tl(s, { type: 'tags.updated', stage, title: 'Call tags updated', detail: changes.join('; '), source: 'classification', data: { tags: t, changes } });
  }
  s.ctx.tags = t;
}

/** Retrieve synthetic knowledge-base guidance relevant to the call. */
async function retrieveGuidance(s: Session, stage: TStage, context: string[], opts: { supportsNextStep?: boolean; agentReview?: boolean } = {}): Promise<void> {
  const issueType = s.ctx.issue?.issueType ?? null;
  const query = [issueType, ...context].filter(Boolean).join(' + ') || 'general';
  const results = await knowledgeBase().search({ issueType, text: s.ctx.issue?.statement ?? '', context });
  if (!results.length) {
    tl(s, { type: 'kb.none', stage, title: 'No relevant knowledge article found', detail: `Query: ${query}. Continuing with configured rules only.`, status: 'warn', source: 'knowledge base' });
    return;
  }
  for (const r of results) {
    recordKbReference(s.id, r, query, { supportsNextStep: !!opts.supportsNextStep, agentReview: !!opts.agentReview });
    tl(s, { type: 'kb.retrieved', stage, title: `Guidance retrieved: ${r.article.id} ${r.article.title}`, detail: `Why: ${r.reason}. ${r.article.excerpt}`, status: 'ok', source: 'knowledge base', data: { articleId: r.article.id } });
  }
}

/* ------------------------------------------------------------------------- intent model */

let modelOverride: IntentModel | null = null;
export function setIntentModelForTests(m: IntentModel | null): void {
  modelOverride = m;
}
const rules = new RulesIntentModel();
function intentModel(): IntentModel {
  if (modelOverride) return modelOverride;
  const e = env();
  if (e.INTENT_MODEL === 'anthropic' && e.ANTHROPIC_API_KEY && e.ANTHROPIC_MODEL) return new AnthropicIntentModel(e.ANTHROPIC_API_KEY, e.ANTHROPIC_MODEL);
  if (e.INTENT_MODEL === 'gemini' && e.GOOGLE_CLOUD_PROJECT) { geminiHybrid ??= new HybridIntentModel(rules, new GeminiIntentModel(e.GOOGLE_CLOUD_PROJECT)); return geminiHybrid; }
  return rules;
}
let geminiHybrid: IntentModel | null = null;

class AssistantUnavailableError extends Error {}

/** The caller's last few spoken statements (sensitive answers are never stored, so never included). */
function recentCustomerStatements(sessionId: string): string[] {
  return all<{ text: string }>("SELECT text FROM conversation_turns WHERE session_id = ? AND speaker = 'customer' AND sensitive_redacted = 0 AND kind IN ('utterance','voice') ORDER BY seq DESC LIMIT 3", [sessionId]).map((r) => r.text).reverse();
}

async function classify(s: Session, text: string): Promise<Classification> {
  if (activeFaults('assistant', { scenarioId: s.scenarioId, customerId: s.ctx.verification.identifiedCustomerId }).has('unavailable')) {
    throw new AssistantUnavailableError('assistant engine unavailable (injected fault)');
  }
  const m = intentModel();
  try {
    return await m.classify(text, { previousStatements: recentCustomerStatements(s.id) });
  } catch (e) {
    // Model failure is not fatal: fall back to the deterministic rules model.
    event(s, 'ai_model_error', { model: m.name, error: (e as Error).message.slice(0, 200) });
    audit({ actor: ASSISTANT, event: 'ai.model_error', status: 'error', sessionId: s.id, correlationId: s.correlationId, metadata: { model: m.name } });
    if (m === rules) throw new AssistantUnavailableError('rules model failed');
    return rules.classify(text);
  }
}

/* ------------------------------------------------------------------------- public API */

export interface StartCallInput {
  channel?: 'text_simulator' | 'voice_browser' | 'telephony';
  scenarioId?: string | null;
  callerAni?: string | null;
  callerToken: string;
  moodStart?: string | null;
  freeMode?: boolean;
  /** Northstar demo customer profile; sets the active customer and the card-number identity check. */
  profileId?: string | null;
}

export async function startCall(input: StartCallInput): Promise<string> {
  const id = newId('SES');
  const correlationId = newId('COR');
  const ts = nowIso();
  const ctx: CallContext = {
    stage: 'awaiting_issue',
    issue: null,
    verification: initialVerification(),
    snapshotId: null,
    caseId: null,
    wf: null,
    pending: null,
    resume: null,
    silenceCount: 0,
    unclearCount: 0,
    distressCount: 0,
    lastPrompt: M.GREETING,
    flags: [],
    lastUtterance: null,
    firstName: null,
    freeMode: !!input.freeMode && !input.scenarioId,
    persona: null,
    sentiment: null,
    tags: null,
    facts: {},
  };
  const profile = input.profileId ? profileById(input.profileId) : undefined;
  if (input.profileId && !profile) throw new Error('Unknown demo profile.');
  if (profile) {
    input = { ...input, scenarioId: profile.scenarioId };
    ctx.verificationMode = 'card_number';
    ctx.profileId = profile.id;
    ctx.freeMode = false;
  }
  // No customer chosen and not a scripted scenario: the card number the caller gives decides who they are.
  if (!profile && !input.scenarioId && !ctx.freeMode) { ctx.verificationMode = 'card_number'; ctx.cardIdentify = true; }
  const sc = input.scenarioId ? scenarioById(input.scenarioId) : undefined;
  if (sc) ctx.persona = { scenarioId: sc.id, name: sc.customer.name, customerNumber: sc.customer.number, phoneMasked: maskPhone(sc.customer.phone) };
  run(
    `INSERT INTO call_sessions (id, correlation_id, channel, data_origin, scenario_id, caller_ani_hash, caller_token_hash, state, context_json, outcome, mood_start, answered_at, created_at, updated_at, profile_id, verification_mode)
     VALUES (?,?,?, 'demo_session', ?,?,?, 'awaiting_issue', ?, 'in_progress', ?, ?, ?, ?, ?, ?)`,
    [id, correlationId, input.channel ?? 'text_simulator', input.scenarioId ?? null, input.callerAni ? sha256(`ani:${input.callerAni}`) : null, sha256(`call:${input.callerToken}`), JSON.stringify(ctx), input.moodStart ?? null, ts, ts, ts, profile?.id ?? null, ctx.verificationMode ?? 'dob_otp'],
  );
  const s: Session = { id, correlationId, scenarioId: input.scenarioId ?? null, dataOrigin: 'demo_session', ctx, actor: { type: 'customer_session', id } };
  // Identification by caller ID happens now (not verification). The raw ANI is not stored.
  if (input.callerAni) {
    const hit = await adapters().identity.identifyByAni({ correlationId, sessionId: id, scenarioId: s.scenarioId }, input.callerAni);
    if (hit) {
      ctx.verification.identifiedCustomerId = hit.customerId;
      ctx.verification.identifiedBy = 'ani';
    }
  }
  tl(s, { type: 'call.initiated', stage: 'understand', title: 'Call answered — no menu, no queue', detail: profile ? `Caller ID matched ${sc!.customer.name}. That identifies the caller but doesn’t prove who they are.` : null, status: 'ok', source: 'phone line', ref: correlationId });
  // The recording notice stands whoever takes the call.
  say(s, M.GREETING_NOTICE, 'system');
  event(s, 'call_answered', { channel: input.channel ?? 'text_simulator' });
  audit({ actor: s.actor, event: 'call.started', status: 'ok', resourceType: 'session', resourceId: id, sessionId: id, correlationId, metadata: { scenarioId: input.scenarioId ?? null, channel: input.channel } });
  // The off switch is read before Lily introduces herself. Asking "how can I help?" and then saying
  // she is not taking calls is worse than not asking: the caller has already started explaining.
  if (!assistantMayHandleCalls()) {
    await handoffForSwitch(s);
    save(s);
    return id;
  }
  // On a live voice call Lily speaks her own greeting; the AI disclosure is recorded when she has
  // actually said it (see the voice bridge), not assumed here.
  if (input.channel !== 'voice_browser') {
    say(s, M.GREETING);
    tl(s, { type: 'disclosure.given', stage: 'understand', title: 'AI and recording disclosure given', detail: 'The caller was told they are speaking with an AI assistant and given the recording/privacy notice before any assistance.', status: 'ok', source: 'conversation', ref: correlationId });
  }
  save(s);
  return id;
}

/**
 * The assistant has been switched off. The caller goes to a person with whatever is known so far,
 * and the case says why, so nobody picking it up thinks the assistant failed at something.
 */
async function handoffForSwitch(s: Session): Promise<void> {
  const state = safetyState();
  s.ctx.flags.push('assistant_switched_off');
  event(s, 'assistant_switched_off', { reason: state.reason });
  tl(s, {
    type: 'safety.switch',
    stage: 'understand',
    title: 'The assistant is switched off — the caller goes straight to a person',
    detail: state.reason ?? 'A safety switch is set. The assistant takes no calls while it is.',
    status: 'warn',
    source: 'safety switch',
  });
  await handoff(s, 'assistant_unavailable', state.reason ?? 'the assistant is switched off', OFF_MESSAGE, { priority: 'normal' });
}

export async function handleInput(sessionId: string, input: CallInput): Promise<void> {
  await withLock(sessionId, async () => {
    const s = load(sessionId);
    if (s.ctx.stage === 'ended') return;
    const cmid = 'clientMessageId' in input ? input.clientMessageId : undefined;
    if (cmid && get('SELECT 1 FROM conversation_turns WHERE session_id = ? AND client_message_id = ?', [s.id, cmid])) {
      event(s, 'duplicate_input_ignored', { clientMessageId: cmid });
      return;
    }
    try {
      await dispatch(s, input);
    } catch (e) {
      if (e instanceof AppError && e.code !== 'INTERNAL') throw e;
      await enterFallback(s, e as Error);
    } finally {
      save(s);
    }
  });
}

/* ------------------------------------------------------------------------- heard but not yet handled */

/**
 * What the customer said on a live call that no tool call has taken yet. Held in memory only
 * (it may contain a date of birth or card digits) and cleared as soon as the back end uses it.
 */
const unheard = new Map<string, { text: string; stage: Stage; at: number }[]>();
const UNHEARD_MAX_AGE_MS = 120_000;

/** True when the customer said something on this call that the back end has not acted on yet. */
export function hasUnhandledSpeech(sessionId: string): boolean {
  return hadUnheard(sessionId);
}
function hadUnheard(sessionId: string): boolean {
  return (unheard.get(sessionId) ?? []).length > 0;
}
function clearUnheard(sessionId: string): void {
  unheard.delete(sessionId);
}
/** Earlier words that may be combined with the current turn, or null when they must not be used. */
function takeUnheard(sessionId: string, c: CallContext): string | null {
  const list = (unheard.get(sessionId) ?? []).filter((u) => u.stage === c.stage && Date.now() - u.at < UNHEARD_MAX_AGE_MS);
  if (!list.length) return null;
  // Consent is never inferred from earlier words: Lily may have asked her own question in between.
  if (c.pending?.kind === 'consent') return null;
  // Single-answer steps use only the most recent words.
  if (c.pending?.kind === 'yes_no' || ['identifying', 'awaiting_dob', 'awaiting_otp', 'awaiting_card', 'stepup', 'awaiting_survey'].includes(c.stage)) return list[list.length - 1].text;
  return list.slice(-3).map((u) => u.text).join(' ');
}

/**
 * The customer spoke on a live call and the voice model replied without calling a tool. The words
 * are recorded, their details are captured into the call facts, and they are kept for the next
 * back-end step so the customer never has to say them again.
 */
export async function observeSpeech(sessionId: string, rawText: string): Promise<void> {
  const text = rawText.trim().slice(0, 1000);
  if (!text) return;
  await withLock(sessionId, async () => {
    const s = load(sessionId);
    const c = s.ctx;
    c.facts ??= {};
    const sensitive = SENSITIVE_STAGES.includes(c.stage);
    addTurn(s.id, 'customer', sensitive ? '[verification answer — not stored]' : text, { kind: 'voice', sensitive });
    if (c.stage === 'ended') return;
    if (c.stage === 'awaiting_card') {
      // Card digits read out between tool calls are kept with the rest of the number.
      if (absorbCardDigits(s, text)) { save(s); return; }
    } else if (!sensitive) {
      noteEarlyCardNumber(s, text);
      factsFromCustomerText(c.facts, extractSlots(text), { correction: isCorrection(text) });
      if (!c.issue && (c.stage === 'awaiting_issue' || c.stage === 'clarifying_issue')) {
        setFact(c.facts, 'issue', text, 'provided', 'customer');
        run('UPDATE call_sessions SET issue_statement = COALESCE(issue_statement, ?) WHERE id = ?', [redactText(text), s.id]);
      }
    }
    const list = (unheard.get(s.id) ?? []).filter((u) => u.stage === c.stage);
    list.push({ text, stage: c.stage, at: Date.now() });
    unheard.set(s.id, list.slice(-4));
    event(s, 'speech_observed', { stage: c.stage });
    save(s);
  });
}

/** A full card number said before the identity step: kept in memory (never stored) for that step. */
function noteEarlyCardNumber(s: Session, text: string): void {
  if (s.ctx.verificationMode !== 'card_number' || isVerified(s.ctx.verification)) return;
  const m = text.match(/(?:\d[ -]?){15}\d/);
  if (!m) return;
  const digits = m[0].replace(/\D/g, '');
  if (digits.length !== 16) return;
  captures.set(s.id, { digits, confirming: false });
  setFact(s.ctx.facts ??= {}, 'card_reference', `card ending ${digits.slice(-4)}`, 'provided', 'customer');
  tl(s, { type: 'verification.card_noted', stage: 'understand', title: 'Card number noted for the identity check', detail: 'Held in memory for this call only, never stored. It is read back and checked at the identity step.', status: 'info', source: 'identity verification' });
}

/** Silently add card digits heard between tool calls. Returns true when the words were digits. */
function absorbCardDigits(s: Session, text: string): boolean {
  const digits = text.replace(/\D/g, '');
  if (!digits) return false;
  const cap = captures.get(s.id);
  if (cap?.confirming) {
    if (digits.length === 16) captures.set(s.id, { digits, confirming: false });
    else if (digits.length === 4) captures.set(s.id, { digits: cap.digits.slice(0, 12) + digits, confirming: false });
    return true;
  }
  let next = digits.length === 16 ? digits : (cap?.digits ?? '') + digits;
  if (next.length > 16) next = digits.length <= 16 ? digits : '';
  if (next) captures.set(s.id, { digits: next, confirming: false });
  else captures.delete(s.id);
  return true;
}

/* ------------------------------------------------------------------------- dispatch */

const COMPLAINT = /\b(formal complaint|make a complaint|file a complaint|lodge a complaint|raise a complaint|log a complaint|want to complain|i'?m complaining|i am complaining)\b/i;

const SENSITIVE_STAGES: Stage[] = ['identifying', 'awaiting_dob', 'awaiting_otp', 'awaiting_card', 'stepup'];

async function dispatch(s: Session, input: CallInput): Promise<void> {
  const c = s.ctx;
  // Switched off part way through a call: the caller is passed to a person rather than being
  // answered by something that is supposed to have stopped. Hanging up and asking for a person
  // still do what they say.
  if (!assistantMayHandleCalls() && c.stage !== 'handoff' && input.kind !== 'hangup' && input.kind !== 'interrupt' && input.kind !== 'request_human') {
    return handoffForSwitch(s);
  }
  switch (input.kind) {
    case 'hangup':
      event(s, 'customer_hangup');
      return endCall(s, c.issue || get("SELECT 1 FROM kb_references WHERE session_id = ? AND article_id LIKE 'INFO-%'", [s.id]) ? undefined : 'abandoned');
    case 'interrupt':
      event(s, 'barge_in', { stage: c.stage });
      return;
    case 'silence':
      return onSilence(s);
    case 'survey':
      return onSurvey(s, input.score);
    case 'request_human':
      if (input.spokenText) addTurn(s.id, 'customer', input.spokenText.slice(0, 1000), { kind: 'voice', clientMessageId: input.clientMessageId });
      else addTurn(s.id, 'customer', '[Pressed "Talk to a person"]', { kind: 'button', clientMessageId: input.clientMessageId });
      return handoff(s, 'customer_requested', input.spokenText ? 'customer asked for a person' : 'customer pressed the agent button', 'Of course. I’ll connect you with a member of our team.');
    case 'reconcile':
      addTurn(s.id, 'customer', '[Asked to check action status]', { kind: 'button', clientMessageId: input.clientMessageId });
      return onReconcile(s);
    case 'consent':
      addTurn(s.id, 'customer', input.decision === 'accept' ? '[Confirmed: yes, go ahead]' : '[Declined]', { kind: 'consent_button', clientMessageId: input.clientMessageId });
      return onConsent(s, input.proposalId, input.decision, 'button');
    case 'choice':
      addTurn(s.id, 'customer', `[Selected: ${labelForChoice(c, input.optionId)}]`, { kind: 'choice_button', clientMessageId: input.clientMessageId });
      c.silenceCount = 0;
      return onChoice(s, input.optionId);
    case 'utterance':
      return onUtterance(s, input);
  }
}

function labelForChoice(c: CallContext, id: string): string {
  return c.pending?.kind === 'choice' ? c.pending.options.find((o) => o.id === id)?.label ?? id : id;
}

async function onUtterance(s: Session, input: Extract<CallInput, { kind: 'utterance' }>): Promise<void> {
  const c = s.ctx;
  c.facts ??= {};
  const said = input.text.trim().slice(0, 1000);
  const sensitive = SENSITIVE_STAGES.includes(c.stage);
  // Verification answers are never written to the transcript.
  if (said) addTurn(s.id, 'customer', sensitive ? '[verification answer — not stored]' : said, { sensitive, clientMessageId: input.clientMessageId, asrConfidence: input.asrConfidence ?? null });
  c.silenceCount = 0;
  // Words the customer spoke earlier in this step that the back end has not acted on yet (e.g. Lily
  // answered them before calling a tool). They are part of what the customer told us; consent is
  // the exception and must always come from the customer's latest words.
  const earlier = takeUnheard(s.id, c);
  if (!said && earlier === null && hadUnheard(s.id)) {
    clearUnheard(s.id);
    return say(s, c.pending?.kind === 'consent' ? 'Just to be sure, should I go ahead? Please say yes or no.' : c.lastPrompt);
  }
  clearUnheard(s.id);
  const text = earlier ? (said ? `${earlier} ${said}` : earlier) : said;
  // Card digits read out between tool calls are already held: carry on from them.
  if (!text && c.stage === 'awaiting_card' && captures.has(s.id)) return onVerificationAnswer(s, '');
  if (!text) return onSilence(s);
  if (!sensitive) {
    noteEarlyCardNumber(s, text);
    factsFromCustomerText(c.facts, extractSlots(text), { correction: isCorrection(text) });
    // Losing the phone is remembered from the moment it is mentioned: a passcode cannot be sent to
    // a phone the caller no longer has, so that route is never offered later in the call.
    const lost = readUnavailable(text);
    if (lost.lostPhone && !c.flags.includes('lost_phone')) {
      c.flags.push('lost_phone');
      c.cannotSupply = { ...c.cannotSupply, phone: true };
      setFact(c.facts, 'contact_reachable', 'Registered phone is lost or unreachable — no passcode can be sent to it', 'provided', 'customer');
      event(s, 'lost_phone_noted');
      tl(s, { type: 'verification.phone_unavailable', stage: 'verify', title: 'Caller has lost their phone — passcode route ruled out', detail: 'A one-time passcode goes to the registered phone. The caller no longer has it, so that check cannot be used and is not offered.', status: 'warn', source: 'identity verification' });
    }
    if (lost.lostCard && !c.flags.includes('lost_card')) c.flags.push('lost_card');
  }

  if ((c.stage === 'awaiting_issue' || c.stage === 'clarifying_issue') && !c.issue) {
    run('UPDATE call_sessions SET issue_statement = COALESCE(issue_statement, ?) WHERE id = ?', [redactText(text), s.id]);
  }

  // Low-confidence speech recognition: ask again rather than guess.
  if (input.asrConfidence != null && input.asrConfidence < policy().conversation.asrMinConfidence) {
    event(s, 'asr_low_confidence', { confidence: input.asrConfidence, stage: c.stage });
    tl(s, { type: 'input.low_confidence', stage: 'understand', title: 'Speech not recognised clearly — asked the caller to repeat', detail: `Recogniser confidence ${input.asrConfidence}. The assistant never guesses from unclear speech.`, status: 'warn', source: 'speech recognition' });
    if (c.stage === 'awaiting_issue') {
      run('UPDATE call_sessions SET issue_restatements = issue_restatements + 1 WHERE id = ?', [s.id]);
      event(s, 'issue_restatement_requested', { cause: 'asr_low_confidence' });
    }
    return say(s, "Sorry, I didn't catch that clearly. Could you say that again?");
  }

  // (Checked after the ASR gate so a misheard utterance can be repeated.)
  // Duplicate utterance (e.g. double send / echo) inside a short window → ignore.
  const h = sha256(text.toLowerCase().replace(/\s+/g, ' '));
  // A card-number answer is never treated as an echo: repeating a wrong number is a real, counted attempt (capped at three).
  if (c.stage !== 'awaiting_card' && c.lastUtterance && c.lastUtterance.hash === h && !(parseYesNo(text) !== null && c.lastUtterance.prompt !== sha256(c.lastPrompt ?? '')) && nowMs() - Date.parse(c.lastUtterance.at) < policy().conversation.duplicateUtteranceWindowMs) {
    event(s, 'duplicate_utterance_ignored');
    return;
  }
  // An echo is the same words twice. The exception is a plain yes or no to a NEW question from us (a double confirmation).
  c.lastUtterance = { hash: h, at: nowIso(), prompt: sha256(c.lastPrompt ?? '') };


  if (c.stage === 'handoff') {
    const answered = await answerAgentCheck(s, text);
    if (answered) return;
    return onWhileInHandoff(s);
  }
  if (c.stage === 'awaiting_survey') {
    const n = Number(text.match(/[1-5]/)?.[0]);
    // A real question after the rating prompt is a new request, not an answer to the survey.
    const isRequest = !Number.isFinite(n) && text.trim().split(/\s+/).length >= 3 && parseYesNo(text) !== 'no' && !FAREWELL.test(text);
    if (!isRequest) return onSurvey(s, Number.isFinite(n) ? n : null);
    c.stage = 'wrap_up';
  }

  if (!sensitive) {
    const sent = sentimentFrom(text, c.sentiment?.sentiment);
    if (sent && sent.sentiment !== c.sentiment?.sentiment) {
      c.sentiment = sent;
      if (c.tags) refreshTags(s, c.tags.identity === 'verified' ? 'explain' : 'understand');
    }
  }

  // Deterministic safety signals take precedence over everything else.
  const sig = detectSignals(text);
  if (sig.promptInjection) {
    c.flags.push('prompt_injection_attempt');
    event(s, 'prompt_injection_flagged');
    tl(s, { type: 'safety.flag', stage: 'understand', title: 'Instruction-like text in caller speech flagged and ignored', detail: 'Caller words are treated as data. They cannot change policy, permissions or actions.', status: 'warn', source: 'safety guard' });
    audit({ actor: ASSISTANT, event: 'safety.prompt_injection_flagged', status: 'info', sessionId: s.id, correlationId: s.correlationId });
    if (c.caseId) addRiskFlag(c.caseId, 'prompt_injection_attempt');
  }
  // FP-04: a caller being walked through the "safe account" scam by someone posing as the bank. The
  // warning has to come before anything else, because the loss happens while the call is going on.
  if (sig.scamCoaching && !c.flags.includes('scam_coaching_suspected')) {
    c.flags.push('scam_coaching_suspected');
    event(s, 'scam_pattern_detected', { pattern: 'FP-04' });
    tl(s, {
      type: 'safety.scam_warning',
      stage: 'understand',
      title: 'Caller may be mid-scam: bank impersonation warning given',
      detail: 'The caller described being told to move money or share a passcode. Northstar never asks for either. The call is going to a person as urgent and nothing will be changed meanwhile.',
      status: 'warn',
      source: 'fraud patterns FP-04',
    });
    audit({ actor: ASSISTANT, event: 'safety.scam_pattern_detected', status: 'info', sessionId: s.id, correlationId: s.correlationId });
    if (c.caseId) addRiskFlag(c.caseId, 'scam_coaching_suspected');
    return handoff(
      s,
      'social_engineering_suspected',
      'caller appears to be coached by someone impersonating the bank (FP-04)',
      'Please stop and listen for a moment, because this matters. Northstar will never ask you to move money to a safe account, and we will never ask you to read out a passcode, a PIN or a password. If someone has asked you to do either, they are not from the bank. Please do not do it, and end that call. I am putting you through to our fraud team now as a priority — stay on this line with me.',
      { priority: 'urgent' },
    );
  }
  if (COMPLAINT.test(text)) return handoff(s, 'complaint', 'customer asked to make a formal complaint', "I'm sorry it's come to this. I've logged your complaint and I'm passing you to a colleague who'll take it from here. They'll have everything we've discussed, so you won't need to repeat it.");
  if (sig.humanRequested) return handoff(s, 'customer_requested', 'customer asked for a person', 'Of course. I’ll connect you with a member of our team.');
  if (sig.thirdPartyCaller) {
    c.flags.push('third_party_caller');
    return handoff(
      s,
      'social_engineering_suspected',
      'caller indicated they are calling about someone else’s card/account',
      'For security, I can only help the cardholder with their own account. I’ll transfer you to an agent who can explain the options for helping someone else.',
    );
  }
  if (sig.distress) {
    c.distressCount++;
    event(s, 'distress_detected', { count: c.distressCount });
    if (c.distressCount >= 2) return handoff(s, 'communication_breakdown', 'customer distress', "I can hear this is stressful. Let me get you to a person right away — they'll see everything we've covered.");
  }

  // Things that are not an answer to the current question (repeat that, small talk, a PIN typed by mistake):
  // answer them like a person would and keep the call on track.
  const side = sideTalk(text, { inIssueStage: c.stage === 'awaiting_issue' || c.stage === 'clarifying_issue', sensitive, lastPrompt: c.lastPrompt, facts: c.facts, strikes: c.unclearCount, awaitingYesNo: c.pending?.kind === 'yes_no' });
  if (side) {
    event(s, 'side_talk', { kind: side.kind });
    if (side.alsoProcess) say(s, side.reply);
    else return side.strike ? unclear(s, side.reply) : say(s, side.reply);
  }

  // Sensitive requests are decided here, before any workflow sees the words.
  if (c.stage === 'stepup') return onStepUpAnswer(s, text);
  if (isVerified(c.verification) && (c.stage === 'workflow' || c.stage === 'wrap_up')) {
    if (c.contact) return onContactText(s, text);
    if (THIRD_PARTY.test(text)) return thirdParty(s);
    if (c.pending?.kind === 'yes_no' && c.pending.purpose === 'readout:confirm') {
      const yn = parseYesNo(text);
      if (yn) { c.pending = null; return onReadoutAnswer(s, yn === 'yes'); }
      return say(s, M.CONTACT_YES_OR_NO);
    }
    const kind = contactChangeKind(text);
    if (kind) return startContactChange(s, kind);
    if (c.wf?.name === 'account_inquiry' && READ_ALOUD.test(text) && !/\b(ignore|override|disregard|developer mode|system prompt|jailbreak)\b/i.test(text) && !extractSlots(text).amountMinor && !extractSlots(text).merchantHint) return startReadout(s);
  }

  switch (c.stage) {
    case 'awaiting_issue':
    case 'clarifying_issue':
      return onIssueText(s, text, sig.distress);
    case 'identifying':
    case 'awaiting_dob':
    case 'awaiting_otp':
    case 'awaiting_card':
      return onVerificationAnswer(s, text);
    case 'workflow':
      return onWorkflowText(s, text);
    case 'wrap_up': {
      // "Let me finish" is a request for time, never an answer to "anything else?".
      if (LET_ME_TALK.test(text)) return say(s, "Of course, go ahead. I'm listening.");
      // The caller is saying goodbye: close the call rather than leaving it open on a question.
      if (FAREWELL.test(text)) { say(s, M.GOODBYE); return endCall(s); }
      const yn = parseYesNo(text);
      // A new, supported banking topic in an already verified call is handled here, not handed off.
      if (yn === null && tryGeneralFirst(s, text)) return;
      if (yn === null && isVerified(c.verification) && text.length > 8) {
        const cls = await classify(s, redactText(text));
        if (cls.issueType && cls.confidence >= policy().conversation.minIntentConfidence) return startSecondaryTopic(s, cls, text);
        // A follow-up that only names a shop or an amount, after an account enquiry, is another charge check.
        if (!cls.issueType && c.wf?.name === 'account_inquiry' && (cls.slots.amountMinor != null || cls.slots.merchantHint)) return startSecondaryTopic(s, { ...cls, issueType: 'account_inquiry', confidence: 0.8 }, text);
      }
      if (yn === null && tryBankInfo(s, text, { allowNotFound: true })) return;
      if (yn === 'yes' || (yn === null && text.length > 12)) return handoff(s, 'customer_accepted_offer', 'additional request after resolution', "I'll connect you to an agent for that — they'll see everything from this call, so you won't need to repeat it.");
      return goSurvey(s);
    }
    case 'fallback':
      return say(s, 'Please hold while I route you to a specialist. Everything you told me is saved.', 'system');
    default:
      return;
  }
}

/**
 * A reference a person can hear once and write down: spoken in short groups, with the prefix read as
 * a word. "TCK-HTL7WHGY" becomes "ticket H T L 7, W H G Y", which survives a phone line.
 */
function sayRef(ref: string | null): string {
  if (!ref) return 'not yet assigned';
  const [prefix, body] = ref.includes('-') ? [ref.slice(0, ref.indexOf('-')), ref.slice(ref.indexOf('-') + 1)] : ['', ref];
  const word = prefix === 'TCK' ? 'ticket ' : prefix === 'CASE' ? 'case ' : prefix ? `${prefix} ` : '';
  const groups = (body.match(/.{1,4}/g) ?? [body]).map((g) => g.split('').join(' '));
  return `${word}${groups.join(', ')}`;
}

/* ------------------------------------------------------------------------- issue capture */


/* ------------------------------------------------------------------------- general bank information */

/** "Okay" and "right" can mean "I am listening". They are not enough to transfer the call. */
const WEAK_YES = /^(ok|okay|alright|all right|fine|right|hmm+|mm+|uh huh|yeah right)[\s.,!?]*$/i;
const BANKING_WORDS = /\b(my (card|account|payment|fee|charge|statement)|charge|charged|transaction|stolen|lost|dispute|fraud|decline|declined|refund|late fee)\b/i;
const QUESTION_START = /^(what|how|where|when|why|which|who|do you|does|can i|can you|could i|is there|are there|will you|i want to|i would like to|i'd like to|i need to)\b/i;

/**
 * A general question about the bank (branches, deposits, rates, how things work), answered only from
 * the bank information. Returns true when the call was answered here. A question that sounds like
 * general banking but is not covered gets an honest "I don't have that" instead of a guess or a transfer.
 */
function tryBankInfo(s: Session, text: string, opts: { allowNotFound: boolean }): boolean {
  const c = s.ctx;
  // A short follow-up inherits the subject of the last general answer ("it" means the earlier topic).
  const followUp = !!c.lastInfoTopic && text.trim().split(/\s+/).length <= 9 && /^(and |so |what about |how |where |can i |do i |is it |actually|sorry,? i meant|i meant|no,? i meant)/i.test(text.trim());
  // Inherit the earlier topic only when the sentence alone says nothing, or when the pair is a known combination
  // (a deposit asked about at an ATM). Otherwise a new question such as "can I get a loan" keeps its own answer.
  const alone = answerFromInfo(text);
  const joined = followUp ? answerFromInfo(`${c.lastInfoTopic} ${text}`) : null;
  const found = !alone ? joined : joined && joined.entry.id === 'INFO-atm-deposit' ? joined : alone;
  // Two questions in one breath ("opening hours and how do I deposit"): answer both, in the order asked.
  if (!BANKING_WORDS.test(text)) {
    const parts = text.split(/\b(?:and|also|then|plus)\b|[?;]/i).map((x) => x.trim()).filter((x) => x.split(/\s+/).length >= 2);
    const hits: NonNullable<typeof found>[] = [];
    for (const part of parts) { const f = answerFromInfo(part); if (f && !hits.some((h) => h.entry.id === f.entry.id)) hits.push(f); }
    if (hits.length >= 2) {
      const two = hits.slice(0, 2);
      c.lastInfoTopic = two[1].entry.topic;
      for (const h of two) {
        event(s, 'bank_info_answered', { topic: h.entry.id });
        recordKbReference(s.id, { article: { id: h.entry.id } as never, score: 3, reason: 'general bank information' }, redactText(text), { supportsNextStep: false, agentReview: false });
      }
      tl(s, { type: 'kb.info', stage: 'explain', title: `Answered from bank information: ${two.map((h) => h.entry.topic).join(' and ')}`, detail: 'Two questions in one turn, both answered.', status: 'ok', source: 'bank information (demo)' });
      say(s, `${two.map((h) => h.reply).join(' ')} ${M.INFO_FOLLOWUP}`);
      return true;
    }
  }
  if (found) {
    c.lastInfoTopic = found.entry.topic;
    event(s, 'bank_info_answered', { topic: found.entry.id });
    recordKbReference(s.id, { article: { id: found.entry.id } as never, score: 3, reason: 'general bank information' }, redactText(text), { supportsNextStep: false, agentReview: false });
    tl(s, { type: 'kb.info', stage: 'explain', title: `Answered from bank information: ${found.entry.topic}`, detail: 'General information, not specific to this customer.', status: 'ok', source: 'bank information (demo)' });
    say(s, `${found.reply} ${M.INFO_FOLLOWUP}`);
    return true;
  }
  if (opts.allowNotFound && !BANKING_WORDS.test(text) && QUESTION_START.test(text.trim()) && text.trim().length > 15) {
    event(s, 'bank_info_not_found', {});
    tl(s, { type: 'kb.info', stage: 'explain', title: 'No matching bank information', detail: 'The assistant says it does not have this rather than guessing.', status: 'warn', source: 'bank information (demo)' });
    c.notFoundCount = (c.notFoundCount ?? 0) + 1;
    say(s, c.notFoundCount % 2 === 1 ? NOT_FOUND : NOT_FOUND_AGAIN);
    return true;
  }
  return false;
}

/**
 * A general question ("what are your fees", "how do I deposit") is never a request about this caller's account.
 * It is answered from the bank information before any intent is guessed, in every stage that can take a new
 * question. Words like "my", or having lost or been charged something, make it personal and the normal flow runs.
 */
function tryGeneralFirst(s: Session, text: string): boolean {
  // An amount or a specific figure ("a payment of 98765 dollars to Zorbo Mart") is about one transaction, not a general topic.
  const personal = /\b(my|mine|i was|i've been|i have been|i got|i lost|i did not|i didn't|i don't recognise|i do not recognise)\b/i.test(text) || /\$|\d{2,}/.test(text) || /\b(paid|payment|purchase|charged?|transaction)\b/i.test(text);
  if (!personal && QUESTION_START.test(text.trim()) && tryBankInfo(s, text, { allowNotFound: false })) return true;
  // "How do I block my card?" is a question about how the bank works, not a report that something
  // happened. It says "my card", so the rule above holds back; this one lets it through.
  return isGeneralHowTo(text) && tryBankInfo(s, text, { allowNotFound: false });
}

/** Someone saying what has happened to them. These words start a case; nothing here is answered as general information. */
const REPORTS_AN_EVENT = [
  /\bi (?:have |'ve )?(?:just )?(?:lost|misplaced|dropped)\b/i,
  /\bi (?:can'?t|cannot|could ?n'?t) find\b/i,
  /\bmy [\w\s]{0,20}?(?:is|was|has been|have been|got|'s) (?:lost|stolen|missing|gone|taken|blocked|declined|frozen|cloned)\b/i,
  /\b(?:someone|somebody|some ?one) (?:used|took|stole|has|had|is using|charged)\b/i,
  /\bi (?:don'?t|do not|did ?n'?t|didn't) (?:recognise|recognize|make|authorise|authorize)\b/i,
  /\bi (?:was|got|have been|'ve been) (?:charged|billed|declined|double ?charged)\b/i,
  /\b(?:was|were) (?:stolen|taken)\b/i,
  /\bstolen\b/i,
  /\bunauthorised|unauthorized\b/i,
];
/** Asking for this caller's own records, which needs the security check first. */
const ASKS_OWN_RECORDS = /\b(my|mine)\b[\w\s]{0,24}\b(last|recent|latest|balance|statement|transaction|transactions|charge|charges|payment|payments|fee|fees|limit|history|spending)\b|\b(what|when|how much|which)\b[\w\s]{0,20}\bi (?:spend|spent|paid|owe|was charged)\b|\bdo i have\b/i;
/** "How do I …", "What is …", "Where can I …": a question about how the bank works, never a report. */
const HOW_TO_START = /^(?:so\s+|and\s+|also\s+|hi,?\s+|hello,?\s+|ok(?:ay)?,?\s+)*(?:can you tell me |could you tell me |please tell me |tell me |i('?d| would) like to know |i want to know )?(?:how (?:do|can|would|should|does|is|are|long|much|old)|what(?:'s| is| are| does| do)|where (?:can|do|is|are)|when (?:can|do|does|is|are)|which|why (?:do|does|is|are)|can i |could i |is there |are there |do you (?:offer|have|do|accept|charge))\b/i;

/**
 * True when the sentence asks how something works rather than reporting that something happened.
 * "How do I replace a lost card?" and "How do I block my card?" are general; "I lost my card" and
 * "what was my last charge" are not, and keep the security check they need.
 */
export function isGeneralHowTo(text: string): boolean {
  // Curly apostrophes arrive from speech recognition as often as straight ones.
  const t = text.replace(/[\u2018\u2019\u02bc\u2032]/g, "'").trim();
  if (!HOW_TO_START.test(t)) return false;
  if (REPORTS_AN_EVENT.some((re) => re.test(t))) return false;
  if (ASKS_OWN_RECORDS.test(t)) return false;
  // A figure or a named merchant means one particular charge, not a general topic.
  return !/\$\s?\d|\d{2,}/.test(t);
}

/**
 * A general question asked while the call is waiting on an answer (a choice, a yes or no, a card number):
 * answer it from the bank information, then say the call is still waiting. The pending question is kept.
 * Returns true when it answered.
 */
function answerAside(s: Session, text: string): boolean {
  if (/\b(my|mine)\b/i.test(text) || !QUESTION_START.test(text.trim()) || parseYesNo(text) !== null) return false;
  const f = answerFromInfo(text);
  if (!f) return false;
  event(s, 'bank_info_answered', { topic: f.entry.id, during: 'pending_question' });
  tl(s, { type: 'kb.info', stage: 'explain', title: `Answered from bank information: ${f.entry.topic}`, detail: 'Answered while a question was still open. The open question was kept.', status: 'ok', source: 'bank information (demo)' });
  say(s, `${f.reply} Whenever you are ready, I still need your answer to my last question.`);
  return true;
}

async function onIssueText(s: Session, text: string, distressed: boolean): Promise<void> {
  const c = s.ctx;
  // The offer of a person after an unclear request: a plain yes or no answers it, anything else is a new try.
  if (c.pending?.kind === 'yes_no' && c.pending.purpose === 'offer_agent' && c.pending.agentReason === 'ai_uncertain') {
    const p = c.pending;
    const yn = parseYesNo(text);
    if (yn && WEAK_YES.test(text.trim())) return say(s, 'Just to be sure, would you like me to connect you with a person? Please say yes or no.');
    if (yn) return onYesNoAnswer(s, p, yn === 'yes');
    c.pending = null;
  }
  // The caller is answering the menu we just read them, by position ("the second one") or by name
  // ("the lost card one"). On a voice call that is the only way to pick an option.
  // Only a positional answer is taken here. Matching the menu's wording would turn an ordinary
  // sentence that happens to contain "card" or "charge" into a chosen option, so that is left to
  // the classifier, which weighs the whole sentence.
  if (c.pending?.kind === 'choice' && c.pending.scope === 'issue') {
    const byOrdinal = parseOrdinalChoice(text, c.pending.options.length);
    if (byOrdinal != null) return onChoice(s, c.pending.options[byOrdinal].id);
  }
  const combined = c.issue && c.stage === 'clarifying_issue' ? `${c.issue.statement} ${redactText(text)}` : redactText(text);
  const cls = await classify(s, combined);
  // A general question is answered before any intent is guessed.
  if (tryGeneralFirst(s, text)) { c.unclearCount = 0; c.issue = null; c.pending = null; c.stage = 'awaiting_issue'; return; }
  // General bank questions are answered from the bank information without starting a case.
  if (!cls.issueType && tryBankInfo(s, text, { allowNotFound: true })) { c.unclearCount = 0; c.issue = null; c.pending = null; c.stage = 'awaiting_issue'; return; }
  if (cls.unsupportedTopic && !cls.issueType && tryBankInfo(s, text, { allowNotFound: false })) { c.issue = null; c.pending = null; c.stage = 'awaiting_issue'; return; }
  // A question about how something works is never a report that it happened, so it never starts a
  // case or a security check. If the bank information does not cover it, say so rather than guess.
  if (isGeneralHowTo(text)) {
    c.unclearCount = 0; c.issue = null; c.pending = null; c.stage = 'awaiting_issue';
    if (tryBankInfo(s, text, { allowNotFound: true })) return;
    event(s, 'bank_info_not_found', { generalHowTo: true });
    return say(s, `${NOT_FOUND}`);
  }
  const min = policy().conversation.minIntentConfidence;
  const clarifications = c.issue?.clarifications ?? 0;
  c.issue = { ...cls, statement: combined, slots: mergeSlots(c.issue?.slots, cls.slots), clarifications };
  run('UPDATE call_sessions SET issue_statement = ?, updated_at = ? WHERE id = ?', [combined, nowIso(), s.id]);
  event(s, 'intent_classified', { issueType: cls.issueType, confidence: cls.confidence, model: cls.model });
  tl(s, {
    type: 'intent.identified',
    stage: 'understand',
    title: cls.issueType ? `Intent identified: ${ISSUE_LABELS[cls.issueType]}` : cls.unsupportedTopic ? `Request outside supported scope (${cls.unsupportedTopic.replace(/_/g, ' ')})` : 'Intent not clear yet',
    detail: slotSummary(c.issue.slots),
    data: { confidence: cls.confidence, model: cls.model, threshold: min },
    status: cls.issueType && cls.confidence >= min ? 'ok' : 'warn',
    source: `intent model: ${cls.model}`,
  });

  if (cls.unsupportedTopic && !cls.issueType) {
    return handoff(s, 'out_of_policy', `unsupported topic: ${cls.unsupportedTopic}`, `I'm not able to help with that here — I can help with lost or stolen cards, unrecognised or duplicate charges, payments and fees. I'll transfer you to an agent who can help.`);
  }
  if (cls.issueType && cls.confidence >= min) return setIssue(s, cls.issueType, cls.confidence, distressed);

  if (clarifications >= policy().conversation.maxIssueClarifications) {
    // Unclear is not a reason to transfer. Offer a person once and keep listening if the caller declines.
    c.stage = 'clarifying_issue';
    c.pending = { kind: 'yes_no', purpose: 'offer_agent', agentReason: 'ai_uncertain' };
    event(s, 'issue_unclear_offer_agent', { confidence: cls.confidence });
    event(s, 'agent_offered', { reason: 'ai_uncertain' });
    tl(s, { type: 'clarification.requested', stage: 'understand', title: 'Still unclear, offered a person', detail: 'Unclear input does not transfer the call by itself. The customer chooses.', status: 'pending', source: 'conversation' });
    c.offerCount = (c.offerCount ?? 0) + 1;
    say(s, [
      "I'm sorry, I still haven't caught what you need. Would you like me to connect you with a person? Or you can tell me again in your own words.",
      'I can bring in a person whenever you like, just say yes. Or tell me in a few words what you need and I will try again.',
      'No problem, take your time. Say yes if you want a person now, or just tell me what is going on.',
    ][(c.offerCount - 1) % 3]);
    return;
  }
  c.issue.clarifications++;
  c.stage = 'clarifying_issue';
  c.pending = { kind: 'choice', purpose: 'issue_type', options: M.ISSUE_CHOICES, scope: 'issue' };
  event(s, 'issue_clarification_requested', { confidence: cls.confidence });
  tl(s, { type: 'clarification.requested', stage: 'understand', title: 'Asked one clarifying question', detail: 'Below the confidence threshold — offered the five supported issue types rather than guessing.', status: 'pending', source: 'conversation' });
  say(s, clarifications >= 1 ? M.CLARIFY_AGAIN : M.CLARIFY_ISSUE);
}

function slotSummary(sl: IssueSlots): string {
  const bits = [sl.merchantHint && `merchant “${sl.merchantHint}”`, sl.amountMinor != null && `amount ${formatMoneyMinor(sl.amountMinor)}`, sl.dateRange && `date ${sl.dateRange.label}`, sl.cardLast4 && `card ending ${sl.cardLast4}`, sl.lostOrStolen, sl.feeType && sl.feeType.replace(/_/g, ' ')].filter(Boolean);
  return bits.length ? `Extracted from the caller's words: ${bits.join(', ')}.` : 'No specific details extracted yet.';
}
const formatMoneyMinor = (m: number) => `$${(m / 100).toFixed(2)}`;

function mergeSlots(prev: IssueSlots | undefined, next: IssueSlots): IssueSlots {
  if (!prev) return next;
  const out = { ...prev };
  for (const [k, v] of Object.entries(next)) if (v !== null && v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

async function setIssue(s: Session, issueType: IssueType, confidence: number, distressed = false): Promise<void> {
  const c = s.ctx;
  if (!c.issue) c.issue = { issueType, confidence, alternatives: [], unsupportedTopic: null, model: 'customer_selected', statement: '', slots: extractSlots(''), clarifications: 0 };
  c.issue.issueType = issueType;
  c.issue.confidence = confidence;
  c.pending = null;
  run('UPDATE call_sessions SET issue_type = ?, eligible = 1, issue_captured_at = COALESCE(issue_captured_at, ?), issue_fields_json = ?, updated_at = ? WHERE id = ?', [
    issueType, nowIso(), JSON.stringify(c.issue.slots), nowIso(), s.id,
  ]);
  event(s, 'issue_captured', { issueType, confidence });
  setIssueFacts(c.facts ??= {}, c.issue.statement, issueType, true);
  if (c.freeMode && !c.verification.identifiedCustomerId) await bindFreeTalkPersona(s, issueType);
  say(s, (distressed ? 'I understand — and if at any point you’d prefer a person, just say so. ' : '') + M.ackIssue(issueType, isVerified(c.verification)));
  tl(s, { type: 'verification.started', stage: 'verify', title: issueType === 'lost_stolen_card' ? 'Identity verification started — card block will follow immediately' : 'Identity verification started', detail: c.verificationMode === 'card_number' ? 'The full card number is checked on the server against the customer’s record. Nothing about the account is read until it matches.' : 'Two factors required: date of birth, then a one-time passcode to the registered phone. Nothing about the account is read until both pass.', status: 'running', source: 'identity verification' });
  // Verification begins immediately (lost/stolen fast path uses the same flow, nothing else first).
  const ev = await startVerification(vctx(s), c.verification, null, c.verificationMode ?? 'dob_otp');
  if (c.verification.identifiedCustomerId && c.verification.identifiedBy === 'ani' && ev.type === 'need_identifier') {
    c.verification.status = 'awaiting_dob';
    run("UPDATE call_sessions SET verification_status = 'identified' WHERE id = ?", [s.id]);
    run("INSERT INTO verification_attempts (session_id, customer_id, step, method, outcome, created_at) VALUES (?,?, 'identify', 'ani', 'passed', ?)", [s.id, c.verification.identifiedCustomerId, nowIso()]);
  }
  if (c.cardIdentify && !c.verification.identifiedCustomerId) {
    // Nobody is assumed. Ask for the card number; whoever holds it is who the caller is.
    c.verification.status = 'awaiting_card';
    c.stage = 'awaiting_card';
    run("UPDATE call_sessions SET verification_status = 'in_progress' WHERE id = ?", [s.id]);
    const early = captures.get(s.id);
    if (early && early.digits.length === 16) {
      captures.set(s.id, { digits: early.digits, confirming: true });
      say(s, M.cardReadbackEarlier(early.digits.slice(-4)));
    } else say(s, askCardFor(c));
  } else if (c.verificationMode === 'card_number' && c.verification.identifiedCustomerId) {
    // Active demo customer is known from caller ID (identification only). Ask for the card number.
    c.verification.status = 'awaiting_card';
    run("UPDATE call_sessions SET verification_status = 'identified' WHERE id = ?", [s.id]);
    c.stage = 'awaiting_card';
    const early = captures.get(s.id);
    const said4 = c.facts?.card_reference?.status === 'provided' ? c.facts.card_reference.value.match(/\d{4}$/)?.[0] ?? null : null;
    if (early && early.digits.length === 16) {
      // The customer already gave the full number earlier in the call: confirm it instead of asking again.
      captures.set(s.id, { digits: early.digits, confirming: true });
      say(s, M.cardReadbackEarlier(early.digits.slice(-4)));
    } else say(s, said4 ? M.askCardKnowing(said4) : askCardFor(c));
  } else if (c.verification.status === 'awaiting_dob') {
    c.stage = 'awaiting_dob';
    say(s, M.ASK_DOB);
  } else {
    c.stage = 'identifying';
    say(s, M.ASK_CUSTOMER_NUMBER);
  }
  refreshTags(s, 'understand');
}

/** Free-talk demo: bind the synthetic customer whose fixtures match the caller's intent. */
async function bindFreeTalkPersona(s: Session, issueType: IssueType): Promise<void> {
  const sc = scenarioById(FREE_TALK_PERSONA[issueType]) ?? SCENARIOS[0];
  const hit = await adapters().identity.identifyByAni({ correlationId: s.correlationId, sessionId: s.id, scenarioId: sc.id }, sc.customer.phone);
  if (!hit) return;
  s.ctx.verification.identifiedCustomerId = hit.customerId;
  s.ctx.verification.identifiedBy = 'ani';
  s.ctx.persona = { scenarioId: sc.id, name: sc.customer.name, customerNumber: sc.customer.number, phoneMasked: maskPhone(sc.customer.phone) };
  s.scenarioId = sc.id;
  run('UPDATE call_sessions SET scenario_id = ? WHERE id = ?', [sc.id, s.id]);
  tl(s, { type: 'demo.persona', stage: 'verify', title: `Calling as ${sc.customer.name} (test identity)`, detail: `Chosen because the request is about ${ISSUE_LABELS[issueType].toLowerCase()}. Caller ID matched a synthetic profile — identification only, not proof of identity.`, status: 'info', source: 'demo environment' });
}

/** The card number identified the customer: take on that demo customer's profile for the rest of the call. */
function bindIdentifiedCustomer(s: Session): void {
  const c = s.ctx;
  if (!c.cardIdentify || c.profileId) return;
  const cid = c.verification.identifiedCustomerId;
  const sc = SCENARIOS.find((x) => x.customer.id === cid);
  if (!sc) return;
  const profile = PROFILE_DEFS.find((p) => p.scenarioId === sc.id);
  c.persona = { scenarioId: sc.id, name: sc.customer.name, customerNumber: sc.customer.number, phoneMasked: maskPhone(sc.customer.phone) };
  s.scenarioId = sc.id;
  c.profileId = profile?.id ?? null;
  run('UPDATE call_sessions SET scenario_id = ?, profile_id = ? WHERE id = ?', [sc.id, c.profileId, s.id]);
  // Start the verified customer from a clean fixture so an earlier tester's actions don't leak in.
  refreshDemoFixtures(cid!, s.id);
  tl(s, { type: 'demo.persona', stage: 'verify', title: `Identified as ${sc.customer.name} from the card number`, detail: 'The card number is what identified this caller. No customer was chosen on the page.', status: 'ok', source: 'identity check' });
}

const vctx = (s: Session) => ({ sessionId: s.id, correlationId: s.correlationId, scenarioId: s.scenarioId, actor: s.actor });

/* ------------------------------------------------------------------------- verification */

/**
 * Card digits being collected, per call. Held in memory only: never written to the database, logs, audit
 * or model prompts. `confirming` means all 16 digits were heard and the caller was asked "is that correct?".
 */
interface CardCapture { digits: string; confirming: boolean; nudges?: number }
const captures = new Map<string, CardCapture>();
const group4 = (d: string) => d.replace(/(.{4})(?=.)/g, '$1 ');
const spoken = (d: string) => group4(d).split(' ').map((g) => [...g].join(' ')).join(', ');

/** What Lily has heard so far, shown to the caller on screen so they can see whether it was captured correctly. */
export function cardCaptureFor(sessionId: string): { digits: string; count: number; confirming: boolean } | null {
  const c = captures.get(sessionId);
  return c ? { digits: group4(c.digits), count: c.digits.length, confirming: c.confirming } : null;
}

/**
 * Card collection, like a careful agent: digits are kept across turns, so a number read in groups of
 * four is assembled rather than lost. Every turn says what was heard. Once all 16 are heard the last
 * four are read back and the caller confirms or corrects. Returns the digits to verify once confirmed,
 * otherwise answers the caller and returns null.
 */
function collectCard(s: Session, text: string): string | null {
  const cap = captures.get(s.id);
  // One or two stray digits inside an ordinary sentence ("alert(1)", "option 2") are not part of a card number.
  const rawDigits = text.replace(/\D/g, '');
  const digits = rawDigits.length < 4 && text.replace(/[^a-z]/gi, '').length >= 8 ? '' : rawDigits;
  const yn = parseYesNo(text, { answeringPrompt: true });
  const note = (title: string, detail: string) => tl(s, { type: 'verification.readback', stage: 'verify', title, detail, status: 'info', source: 'identity verification' });
  const readback = (d: string, updated: boolean) => {
    captures.set(s.id, { digits: d, confirming: true });
    s.ctx.unclearCount = 0;
    note(updated ? 'Card number corrected — read back for confirmation' : 'All 16 digits heard — read back for confirmation', 'Only the last four digits are repeated aloud. The number is held in memory until confirmed and is never stored.');
    say(s, M.cardReadback(d.slice(-4), updated));
    return null;
  };

  if (digits.length === 0) {
    if (cap?.confirming) {
      if (yn === 'yes') { captures.delete(s.id); return cap.digits; }
      if (yn === 'no') { captures.delete(s.id); say(s, M.CARD_REASK); return null; }
      say(s, [M.CARD_YESNO, M.CARD_YESNO_AGAIN, M.CARD_YESNO_LAST][(cap.nudges ?? 0) % 3]);
      cap.nudges = (cap.nudges ?? 0) + 1;
      return null;
    }
    if (cap) {
      if (/\b(start over|again|restart|clear|wrong|mistake|reset)\b/i.test(text)) { captures.delete(s.id); say(s, M.CARD_REASK); return null; }
      // All 16 were heard already (read out between tool calls, or given earlier in the call): read back.
      if (cap.digits.length === 16) return readback(cap.digits, false);
      say(s, M.cardProgress(cap.digits, spoken(cap.digits))); return null;
    }
    // "Try again" after the check was unavailable reuses the number the caller already confirmed.
    const saved = unavailableCards.get(s.id);
    if (saved && (yn === 'yes' || /\b(try|check)\b.*\bagain\b|\bretry\b/i.test(text))) return saved;
    // Nothing usable was said: the verifier asks again without using an attempt.
    return text;
  }

  // A short correction of a number already read back: "the last four are 4827".
  if (cap?.confirming && digits.length === 4) return readback(cap.digits.slice(0, 12) + digits, true);
  if (cap?.confirming && digits.length === 16) return readback(digits, true);

  // A full 16 digits in one go wins. Otherwise digits are added to what was heard so far.
  const base = cap?.confirming ? '' : cap?.digits ?? '';
  let next = digits.length === 16 ? digits : base + digits;
  if (next.length > 16) next = digits; // the caller probably started again
  if (next.length > 16) {
    captures.delete(s.id);
    s.ctx.unclearCount++;
    note(`Too many digits heard (${next.length}) — asked again, no attempt used`, 'Nothing was checked.');
    if (s.ctx.unclearCount >= 3) { void handoff(s, 'communication_breakdown', 'could not capture the card number', "I'm having trouble capturing that. Let me connect you with an agent who can help verify you."); return null; }
    say(s, M.CARD_TOO_MANY(next.length));
    return null;
  }
  if (next.length < 16) {
    captures.set(s.id, { digits: next, confirming: false });
    note(`Heard ${next.length} of 16 digits — keeping them and asking for the rest`, 'No attempt used. The digits are kept in memory for this call only.');
    say(s, M.cardProgress(next, spoken(next)));
    return null;
  }
  return readback(next, false);
}

const MONEY_MENTION = /\$\s?\d[\d,]*(?:\.\d{1,2})?|\b\d[\d,]*(?:\.\d{1,2})?\s*(?:dollars?|usd|bucks)\b/gi;

/**
 * The caller cannot give what was asked for: the card is gone, or the phone that would receive the
 * passcode is. Asking again would not help them, so the call moves to the next approved route, and
 * to a person when none is left. No check is skipped or softened to get past this.
 */
/**
 * The card number is still the quickest way to be sure who is calling, and plenty of people have it
 * saved in the app or on a statement even when the card itself is gone. So it is asked for once.
 * When the card has been reported lost, the question says plainly how to get past it, so nobody has
 * to guess or repeat themselves.
 */
function askCardFor(c: CallContext): string {
  return c.flags.includes('lost_card') ? M.ASK_CARD_LOST : M.ASK_CARD;
}

async function onCredentialUnavailable(s: Session, step: 'card' | 'otp' | 'dob' | 'identify', text: string): Promise<void> {
  const c = s.ctx;
  const u = readUnavailable(text);
  c.cannotSupply = { ...c.cannotSupply, [step === 'identify' ? 'card' : step]: true };
  if (u.lostPhone) c.cannotSupply.phone = true;
  if (u.lostPhone && !c.flags.includes('lost_phone')) c.flags.push('lost_phone');
  if (u.lostCard && !c.flags.includes('lost_card')) c.flags.push('lost_card');
  setFact(c.facts ??= {}, 'identity', `Could not supply the ${step === 'otp' ? 'passcode' : step === 'dob' ? 'date of birth' : step === 'identify' ? 'customer number' : 'card number'}${c.cannotSupply.phone ? '; no access to the registered phone' : ''}`, 'needs_clarification', 'verification');
  event(s, 'credential_unavailable', { step, lostPhone: !!c.cannotSupply.phone });

  // A passcode cannot reach a phone the caller no longer has, and there is no third route here.
  const phoneGone = !!c.cannotSupply.phone;
  const noRouteLeft = step === 'otp' || step === 'dob' || phoneGone || c.altOffered;
  if (noRouteLeft) {
    tl(s, {
      type: 'verification.alternative_exhausted',
      stage: 'verify',
      title: 'Caller cannot complete any approved check on this line — passing to a person',
      detail: phoneGone
        ? 'The card cannot be read and the registered phone is gone, so neither approved check can run. Nothing was weakened and no account data was read.'
        : 'Both approved checks were offered and neither could be completed. Nothing was weakened and no account data was read.',
      status: 'warn',
      source: 'identity verification',
    });
    return handoff(
      s,
      'credential_unavailable',
      phoneGone && c.flags.includes('lost_card') ? 'card and registered phone both lost — no approved check can run' : `caller cannot supply the ${step === 'otp' ? 'passcode' : step === 'identify' ? 'customer number' : step}`,
      phoneGone && c.flags.includes('lost_card') ? M.LOST_CARD_AND_PHONE : M.ALT_NOT_POSSIBLE,
      { priority: c.flags.includes('lost_card') ? 'urgent' : 'normal', missing: ['Identity not confirmed — verify another way before discussing or changing the account'] },
    );
  }

  // The second approved route: customer number, date of birth, then a passcode to the registered phone.
  c.altOffered = true;
  c.unclearCount = 0;
  c.cardUnparsed = 0;
  captures.delete(s.id);
  c.verificationMode = 'dob_otp';
  tl(s, { type: 'verification.alternative_offered', stage: 'verify', title: 'Card number unavailable — offered the second approved check', detail: 'Date of birth plus a one-time passcode to the registered phone. The requirement is not reduced: it is a different approved way to prove identity.', status: 'pending', source: 'identity verification' });
  const ev = await startVerification(vctx(s), c.verification, null, 'dob_otp');
  c.stage = ev.type === 'need_dob' ? 'awaiting_dob' : 'identifying';
  return say(s, ev.type === 'need_dob' ? `That's all right — you don't need the card in front of you. I can check it's you another way. ${M.ASK_DOB}` : M.OFFER_ALT_CHECK);
}

async function onVerificationAnswer(s: Session, text: string): Promise<void> {
  const c = s.ctx;
  // "I don't have it", "I lost it", "I don't know the number": a credential that cannot be supplied.
  // This is not a wrong answer and never counts as a failed attempt.
  if (saysCredentialUnavailable(text)) {
    const step = c.stage === 'awaiting_otp' ? 'otp' : c.stage === 'awaiting_dob' ? 'dob' : c.stage === 'identifying' ? 'identify' : 'card';
    return onCredentialUnavailable(s, step, text);
  }
  // A general question in the middle of the check ("what are your hours?") is answered, then the check carries on.
  // It never counts as a failed answer and never touches the card digits held so far.
  if (c.stage === 'awaiting_card' && text.replace(/\D/g, '').length < 3 && parseYesNo(text) === null && (isGeneralHowTo(text) || (QUESTION_START.test(text.trim()) && !/\b(my|mine)\b/i.test(text)))) {
    const f = answerFromInfo(text);
    if (f) {
      event(s, 'bank_info_answered', { topic: f.entry.id, during: 'verification' });
      tl(s, { type: 'kb.info', stage: 'explain', title: `Answered from bank information: ${f.entry.topic}`, detail: 'Answered in the middle of the security check. The check was not affected.', status: 'ok', source: 'bank information (demo)' });
      say(s, `${f.reply} Whenever you are ready, we can carry on with the check.`);
      return;
    }
  }
  if (c.stage === 'awaiting_card' && c.verificationMode === 'card_number') {
    // An amount mentioned during the card step ("actually it was $249") is a detail of the issue, not card digits.
    const detail = text.match(MONEY_MENTION);
    if (detail) {
      c.facts ??= {};
      factsFromCustomerText(c.facts, extractSlots(text), { correction: true });
      if (c.issue) c.issue.slots = mergeSlots(c.issue.slots, extractSlots(text));
      text = text.replace(MONEY_MENTION, ' ');
      if (!/\d/.test(text) && parseYesNo(text) === null) {
        const cap = captures.get(s.id);
        return say(s, `Thanks, I've noted that. ${cap && !cap.confirming && cap.digits.length < 16 ? M.cardProgress(cap.digits, spoken(cap.digits)) : M.ASK_CARD}`);
      }
    }
    // Typed number words ("four nine nine nine ...") are read the same way as spoken ones.
    text = normaliseSpoken(text);
    const confirmed = collectCard(s, text);
    if (confirmed === null) return;
    // Only a confirmed 16-digit number is acknowledged and checked; anything else goes to the verifier to ask again.
    if (/^\d{16}$/.test(confirmed)) say(s, M.CARD_ACK);
    return runVerification(s, confirmed);
  }
  return runVerification(s, text);
}

/** Confirmed numbers whose check could not run; kept in memory so "try again" works without re-reading 16 digits. */
const unavailableCards = new Map<string, string>();

async function runVerification(s: Session, answer: string): Promise<void> {
  const c = s.ctx;
  const t0 = Date.now();
  const ev = await submitVerificationAnswer(vctx(s), c.verification, answer);
  if (ev.type === 'unavailable') unavailableCards.set(s.id, answer); else unavailableCards.delete(s.id);
  captures.delete(s.id);
  if (c.verificationMode === 'card_number' && ev.type !== 'in_progress') tl(s, { type: 'verification.timing', stage: 'verify', title: `Card check finished in ${Date.now() - t0} ms`, detail: `Outcome: ${ev.type === 'verified' ? 'verified' : ev.type === 'unavailable' ? 'temporarily_unavailable' : ev.type === 'retry' && ev.unparsed ? 'invalid_input' : 'not_verified'}`, status: ev.type === 'unavailable' ? 'warn' : 'info', source: 'identity verification', data: { latencyMs: Date.now() - t0 } });
  switch (ev.type) {
    case 'in_progress':
      return;
    case 'unavailable':
      tl(s, { type: 'verification.unavailable', stage: 'verify', title: 'Card check could not run — nothing decided, no attempt used', detail: `The check did not answer within the time limit (${ev.latencyMs} ms across one retry). The conversation state is kept.`, status: 'warn', source: 'identity verification' });
      return say(s, M.CARD_UNAVAILABLE);
    case 'need_card':
      c.stage = 'awaiting_card';
      return say(s, M.ASK_CARD);
    case 'need_dob':
      c.stage = 'awaiting_dob';
      return say(s, `Thank you. ${M.ASK_DOB}`);
    case 'otp_sent':
      c.stage = 'awaiting_otp';
      tl(s, { type: 'verification.factor_passed', stage: 'verify', title: 'Date of birth matched', detail: `One-time passcode sent to the registered phone (${ev.deliveredTo}).`, status: 'ok', source: 'identity verification' });
      return say(s, M.otpSent(ev.deliveredTo));
    case 'retry':
      if (ev.unparsed) {
        c.unclearCount++;
        // The same credential is asked for once more and no further: a second answer that is not
        // the thing we asked for means the caller does not have it, whatever words they used.
        c.unparsed = c.unparsed?.step === ev.step ? { step: ev.step, n: c.unparsed.n + 1 } : { step: ev.step, n: 1 };
        if (c.unparsed.n >= 2 && ev.step !== 'card') return onCredentialUnavailable(s, ev.step === 'identify' ? 'identify' : ev.step === 'dob' ? 'dob' : 'otp', answer);
        if (c.unclearCount >= 3) return handoff(s, 'communication_breakdown', `could not capture ${ev.step} answer`, "I'm having trouble capturing that. Let me connect you with an agent who can help verify you.");
      } else c.unparsed = null;
      if (!ev.unparsed) tl(s, { type: 'verification.retry', stage: 'verify', title: ev.step === 'card' ? `Card number check failed — no match (${ev.remaining} attempt${ev.remaining === 1 ? '' : 's'} left)` : `Verification answer did not match (${ev.remaining} attempt${ev.remaining === 1 ? '' : 's'} left)`, detail: ev.step === 'card' ? 'The number given did not match the active customer’s record. The expected number is never revealed and the call carries on.' : 'Generic message given — the caller is not told which detail was wrong.', status: 'warn', source: 'identity verification', data: { attemptResult: 'failed', attemptsRemaining: ev.remaining } });
      else if (ev.step === 'card') tl(s, { type: 'verification.unclear', stage: 'verify', title: 'Card number not captured clearly — asked again (no attempt used)', status: 'info', source: 'identity verification' });
      c.cardUnparsed = ev.unparsed && ev.step === 'card' ? (c.cardUnparsed ?? 0) + 1 : 0;
      return say(s, M.retryVerification(ev.step, ev.remaining, ev.unparsed, c.cardUnparsed ?? 1));
    case 'locked':
      setFact(c.facts ??= {}, 'identity', `Not verified: ${ev.step === 'card' ? 'card number' : 'answers'} did not match after the maximum attempts`, 'needs_clarification', 'verification');
      event(s, 'verification_failed', { step: ev.step });
      run("UPDATE call_sessions SET outcome = 'verification_failed' WHERE id = ?", [s.id]);
      c.caseId = ensureCase({ sessionId: s.id, customerId: null, issueType: c.issue?.issueType ?? null, verificationOutcome: 'failed', customerReported: c.issue?.statement ?? null, actor: s.actor, correlationId: s.correlationId });
      addRiskFlag(c.caseId, 'verification_failed');
      tl(s, { type: 'verification.failed', stage: 'verify', title: ev.step === 'card' ? 'Card number check failed 3 times — preparing handover to a person' : 'Identity verification failed — locked after 3 attempts', detail: 'No account data was read or disclosed and no action is possible. Routing to an agent to verify another way.', status: 'failed', source: 'identity verification', ref: c.caseId });
      refreshTags(s, 'verify');
      return handoff(s, 'verification_failed', `locked at ${ev.step}`, M.LOCKED);
    case 'verified':
      c.unclearCount = 0;
      event(s, 'verified');
      bindIdentifiedCustomer(s);
      recordVerifiedFacts(s);
      tl(s, { type: 'verification.passed', stage: 'verify', title: c.verificationMode === 'card_number' ? 'Card number matched — identity verified' : 'Identity verified (two factors)', detail: c.verificationMode === 'card_number' ? 'The card number matched the active demo customer’s record on the server. Protected reads are now allowed.' : 'Date of birth and one-time passcode both passed. Protected reads are now allowed.', status: 'ok', source: 'identity verification', data: { attemptResult: 'passed' } });
      refreshTags(s, 'verify');
      return onVerified(s);
    default:
      return;
  }
}

/** Identity passed: record it, and check the card the customer mentioned against the verified one. */
function recordVerifiedFacts(s: Session): void {
  const c = s.ctx;
  c.facts ??= {};
  setFact(c.facts, 'identity', c.verificationMode === 'card_number' ? 'Verified by full card number' : 'Verified by date of birth and one-time passcode', 'verified', 'verification');
  if (c.verificationMode !== 'card_number') return;
  const card = get<{ last4: string }>('SELECT last4 FROM bank_cards WHERE customer_id = ? ORDER BY id LIMIT 1', [c.verification.identifiedCustomerId]);
  if (!card) return;
  const prev = c.facts.card_reference;
  const value = `card ending ${card.last4}`;
  const differs = prev && prev.source === 'customer' && !prev.value.endsWith(card.last4);
  c.facts.card_reference = {
    value,
    status: 'verified',
    source: 'verification',
    at: nowIso(),
    ...(differs ? { customerValue: prev!.value } : {}),
    ...(prev ? { history: [...(prev.history ?? []), { value: prev.value, status: prev.status, source: prev.source, at: prev.at, why: 'replaced by the verified card' }] } : {}),
  };
}

async function onVerified(s: Session): Promise<void> {
  const c = s.ctx;
  const customerId = c.verification.identifiedCustomerId!;
  const issueType = c.issue!.issueType!;
  const cardFact = c.facts?.card_reference;
  say(s, M.VERIFIED);
  if (cardFact?.status === 'verified' && cardFact.customerValue) {
    say(s, `One thing to check: earlier you mentioned the ${cardFact.customerValue}, but the card you just verified is the ${cardFact.value}. I'll use the verified card. If you meant a different card, just tell me.`);
  }
  c.caseId = ensureCase({ sessionId: s.id, customerId, issueType, verificationOutcome: 'verified', customerReported: c.issue!.statement, actor: s.actor, correlationId: s.correlationId });
  tl(s, { type: 'case.created', stage: 'record', title: `Case ${c.caseId} opened during the call`, detail: 'The case is updated live as facts and actions are recorded.', status: 'ok', source: 'case management', ref: c.caseId });

  const snap = await retrieveFacts({ sessionId: s.id, correlationId: s.correlationId, scenarioId: s.scenarioId, customerId, issueType });
  c.snapshotId = snap.id;
  updateCase(c.caseId, { sources_checked: Object.values(snap.sources).map((r) => ({ source: r!.source, status: r!.status, stale: r!.stale, latencyMs: r!.latencyMs, asOf: r!.asOf })) });
  caseEvent(c.caseId, 'sources_checked', { snapshotId: snap.id, wallMs: snap.wallMs, conflicts: snap.conflicts.length });
  const profile = sourceData(snap, 'customer_profile');
  c.firstName = profile?.firstName ?? null;
  if ((sourceData(snap, 'fraud_alerts') ?? []).some((a) => a.status === 'open')) {
    c.flags.push('fraud_alert');
    addRiskFlag(c.caseId, 'fraud_alert');
  }
  c.wf = { name: issueType, step: 'start', clarifications: 0 };

  // Account-takeover / social-engineering risk signals block automated actions.
  const recentContactChange = profile?.contactChangedAt && nowMs() - Date.parse(profile.contactChangedAt) < 14 * 86_400_000;
  const atoAlert = (sourceData(snap, 'fraud_alerts') ?? []).some((a) => a.status === 'open' && a.alertType === 'account_takeover_risk');
  if (recentContactChange || atoAlert) {
    addRiskFlag(c.caseId, 'account_takeover_risk');
    tl(s, { type: 'safety.blocked', stage: 'investigate', title: 'Account-takeover risk signal — automated actions blocked', detail: recentContactChange ? 'Contact details changed in the last 14 days.' : 'Open account-takeover alert.', status: 'blocked', source: recentContactChange ? 'customer profile' : 'fraud alerts' });
    recordFindings(c.caseId, [{ kind: 'confirmed', text: recentContactChange ? 'Contact details were changed in the last 14 days.' : 'Open account-takeover risk alert.', source: recentContactChange ? 'customer_profile' : 'fraud_alerts' }]);
    return handoff(s, 'account_takeover_suspected', recentContactChange ? 'recent contact-detail change' : 'open ATO alert', "For your security, I need to pass this call to a specialist before any changes can be made on your account. I've saved everything you've told me.");
  }

  // Repeat caller: open with known context; flag recurring unresolved issues.
  const prior = (sourceData(snap, 'prior_cases') ?? []).filter((p) => p.status !== 'closed' && p.status !== 'resolved' && nowMs() - Date.parse(p.createdAt) <= 30 * 86_400_000);
  if (prior.length) {
    const same = prior.filter((p) => p.issueType === issueType);
    run('UPDATE call_sessions SET repeat_contact = 1 WHERE id = ?', [s.id]);
    updateCase(c.caseId, { previous_case_ids: prior.map((p) => p.caseId), recurring_issue: same.length > 0 });
    if (same.length) {
      c.wf.recurring = true;
      c.wf.priorCaseIds = same.map((p) => p.caseId);
      addRiskFlag(c.caseId, 'recurring_unresolved');
      event(s, 'repeat_contact_recognised', { priorCases: same.map((p) => p.caseId) });
      tl(s, { type: 'context.repeat_caller', stage: 'investigate', title: `Repeat caller: open case ${same[0].caseId} about the same issue`, detail: 'Context carried over so the customer does not repeat themselves; flagged as a recurring unresolved issue.', status: 'warn', source: 'previous cases', ref: same[0].caseId });
      say(s, `I can see you contacted us on ${formatDate(same[0].createdAt)} about ${ISSUE_LABELS[issueType].toLowerCase()} (case ${same[0].caseId}), and it's still open. I have the details from that call, so you don't need to explain it again.`);
    } else {
      say(s, `I can also see an open case from ${formatDate(prior[0].createdAt)} about ${(ISSUE_LABELS[String(prior[0].issueType)] ?? 'another matter').toLowerCase()} (case ${prior[0].caseId}).`);
    }
  }
  c.stage = 'workflow';
  refreshTags(s, 'investigate');
  const r = WORKFLOWS[issueType].start(wfCtx(s, snap));
  await retrieveGuidance(s, 'explain', [], { supportsNextStep: r.kind === 'propose', agentReview: r.kind === 'handoff' });
  await applyResult(s, r);
}

/**
 * A further banking topic raised after the first one was handled. Identity is already verified,
 * so no second verification is asked; the new topic gets its own fresh lookups and the same
 * consent/policy rules. The PRIMARY intent (and KPI attribution) stays the first topic.
 */
async function startSecondaryTopic(s: Session, cls: Classification, text: string): Promise<void> {
  const c = s.ctx;
  const issueType = cls.issueType!;
  const customerId = c.verification.identifiedCustomerId!;
  c.secondary = [...(c.secondary ?? []), { issueType, at: nowIso() }];
  c.issue = { ...cls, statement: redactText(text), slots: cls.slots, clarifications: 0 };
  c.pending = null;
  c.unclearCount = 0;
  event(s, 'secondary_topic', { issueType });
  tl(s, { type: 'intent.secondary', stage: 'understand', title: `New topic in the same call: ${ISSUE_LABELS[issueType]}`, detail: `Already verified, so no second identity check. The primary intent stays “${ISSUE_LABELS[get<{ issue_type: string }>('SELECT issue_type FROM call_sessions WHERE id = ?', [s.id])?.issue_type ?? issueType] ?? ISSUE_LABELS[issueType]}”.`, status: 'ok', source: `intent model: ${cls.model}` });
  say(s, M.ackIssue(issueType, true));
  c.stage = 'workflow';
  refreshTags(s, 'investigate');
  const snap = await retrieveFacts({ sessionId: s.id, correlationId: s.correlationId, scenarioId: s.scenarioId, customerId, issueType });
  c.snapshotId = snap.id;
  if (c.caseId) caseEvent(c.caseId, 'secondary_topic', { issueType, snapshotId: snap.id });
  c.wf = { name: issueType, step: 'start', clarifications: 0 };
  const r = WORKFLOWS[issueType].start(wfCtx(s, snap));
  await retrieveGuidance(s, 'explain', [], { supportsNextStep: r.kind === 'propose', agentReview: r.kind === 'handoff' });
  await applyResult(s, r);
}

function wfCtx(s: Session, snap?: Snapshot | null): WorkflowCtx {
  const c = s.ctx;
  const sn = snap ?? loadSnapshot(c.snapshotId!)!;
  return { snap: sn, slots: c.issue!.slots, statement: c.issue!.statement, wf: c.wf!, sessionId: s.id, customerId: c.verification.identifiedCustomerId!, firstName: c.firstName ?? '', assurance: c.assurance ?? 'basic', readoutOk: !!c.readoutOk };
}

/* ------------------------------------------------------------------------- workflow I/O */

async function onWorkflowText(s: Session, text: string): Promise<void> {
  const c = s.ctx;
  const p = c.pending;
  if (!isVerified(c.verification) || !c.wf) return say(s, "Sorry, I can't help with that until you're verified.");
  const wf = WORKFLOWS[c.wf.name];

  // The customer may change topic at any time. A clearly different banking topic is handled as a
  // new one (already verified, so no second check) instead of being forced into the current flow.
  // Not while an answer is expected to a choice or a free-text question of the current workflow.
  const choicePicked = p?.kind === 'choice' && (parseOrdinalChoice(text, p.options.length) != null || !!matchChoiceByText(p.options, text) || /\b(none|neither|not (any|one) of (these|them)|no)\b/i.test(text));
  const answeringSomething = choicePicked || p?.kind === 'free_text' || (p?.kind === 'consent' && parseYesNo(text)) || (p?.kind === 'yes_no' && parseYesNo(text));
  if (!answeringSomething && text.length > 12 && tryGeneralFirst(s, text)) return;
  if (!answeringSomething && text.length > 12) {
    const cls = await classify(s, redactText(text));
    if (cls.issueType && cls.issueType !== c.issue?.issueType && cls.confidence >= Math.max(0.7, policy().conversation.minIntentConfidence)) return startSecondaryTopic(s, cls, text);
  }

  if (p?.kind === 'consent') {
    if (isCorrection(text) || hasNewDetails(c, text)) return onCorrection(s, text);
    const yn = parseYesNo(text);
    if (yn) return onConsent(s, p.proposalId, yn === 'yes' ? 'accept' : 'decline', 'utterance');
    if (answerAside(s, text)) return;
    return unclear(s, M.CONSENT_NUDGE[Math.min(s.ctx.unclearCount, M.CONSENT_NUDGE.length - 1)]);
  }
  if (p?.kind === 'yes_no') {
    if (/\b(check|status|did it work|worked|go through|went through)\b/i.test(text) && p.purpose === 'reconcile') return onReconcile(s);
    // "Right" answers a question Lily just asked, but never stands in for agreeing to be transferred.
    const yn = parseYesNo(text, { answeringPrompt: p.purpose !== 'offer_agent' });
    if (yn && p.purpose === 'offer_agent' && WEAK_YES.test(text.trim())) return say(s, 'Just to be sure, would you like me to connect you with a person? Please say yes or no.');
    if (!yn) { if (answerAside(s, text)) return; return unclear(s, 'Sorry — was that a yes or a no?'); }
    return onYesNoAnswer(s, p, yn === 'yes');
  }
  if (p?.kind === 'choice') {
    const idx = parseOrdinalChoice(text, p.options.length);
    const byLabel = matchChoiceByText(p.options, text);
    const pick = idx != null ? p.options[idx] : byLabel;
    if (pick) return onChoice(s, pick.id);
    if (/\b(none|neither|not (any|one) of (these|them)|no)\b/i.test(text) && p.options.some((o) => o.id === 'none')) return onChoice(s, 'none');
    if (hasNewDetails(c, text)) {
      c.issue!.slots = mergeSlots(c.issue!.slots, extractSlots(text));
      c.issue!.statement = `${c.issue!.statement} ${redactText(text)}`;
      c.pending = null;
      return applyResult(s, wf.onFreeText ? wf.onFreeText(wfCtx(s), p.purpose, text) : wf.start(wfCtx(s)));
    }
    if (answerAside(s, text)) return;
    return unclear(s, ['Sorry, which one did you mean? You can say "the first one", or tap an option.', 'Tap one of the options on screen, or say the first, second or third one.', 'If none of these is right, say none of them.'][Math.min(c.unclearCount, 2)]);
  }
  if (p?.kind === 'free_text') {
    c.issue!.slots = mergeSlots(c.issue!.slots, extractSlots(text));
    c.issue!.statement = `${c.issue!.statement} ${redactText(text)}`;
    c.pending = null;
    return applyResult(s, wf.onFreeText ? wf.onFreeText(wfCtx(s), p.purpose, text) : wf.start(wfCtx(s)));
  }
  if (/\b(check|status)\b/i.test(text) && opsForSession(s.id).some((o) => o.status === 'unknown' || o.status === 'submitted')) return onReconcile(s);
  return unclear(s, "I'm here — is there anything else about this I can help with? You can also ask for an agent.");
}

function hasNewDetails(c: CallContext, text: string): boolean {
  const n = extractSlots(text);
  const o = c.issue?.slots;
  return (n.amountMinor != null && n.amountMinor !== o?.amountMinor) || (n.merchantHint != null && n.merchantHint !== o?.merchantHint) || (n.cardLast4 != null && n.cardLast4 !== o?.cardLast4);
}

function matchChoiceByText(options: Choice[], text: string): Choice | null {
  const t = normaliseMerchant(text);
  const hits = options.filter((o) => {
    if (o.id === 'none' || o.id === 'other') return false;
    const words = o.label.split(/[\s·,()]+/).map(normaliseMerchant).filter((w) => w.length >= 4 && !/^\d+$/.test(w));
    const digits = o.label.match(/\b\d{4}\b/g) ?? [];
    return words.some((w) => t.includes(w)) || digits.some((d) => text.includes(d));
  });
  return hits.length === 1 ? hits[0] : null;
}

async function unclear(s: Session, reprompt: string): Promise<void> {
  const c = s.ctx;
  c.unclearCount++;
  event(s, 'unclear_input', { count: c.unclearCount });
  if (c.unclearCount >= 3) {
    // Not getting an answer is not a reason to transfer by itself. Offer a person and keep the open question.
    const resume = c.pending ?? undefined;
    const resumePrompt = c.lastPrompt;
    c.unclearCount = 0;
    c.pending = { kind: 'yes_no', purpose: 'offer_agent', agentReason: 'communication_breakdown', resume, resumePrompt };
    event(s, 'agent_offered', { reason: 'communication_breakdown' });
    return say(s, "I'm sorry, I'm not getting this right. Would you like me to connect you with a person? Say yes for a person, or no and we will carry on.");
  }
  say(s, reprompt);
}

async function onCorrection(s: Session, text: string): Promise<void> {
  const c = s.ctx;
  const p = c.pending;
  if (p?.kind === 'consent') {
    run("UPDATE proposals SET status = 'superseded', decided_at = ? WHERE id = ? AND status = 'proposed'", [nowIso(), p.proposalId]);
    for (const op of opsForProposal(p.proposalId)) declineAction(op.id, s.actor, s.correlationId);
    event(s, 'proposal_superseded', { proposalId: p.proposalId, reason: 'caller_correction' });
  }
  c.issue!.slots = mergeSlots(c.issue!.slots, extractSlots(text));
  c.issue!.statement = `${c.issue!.statement} ${redactText(text)}`;
  c.wf!.selectedTxnId = null;
  c.wf!.selectedFeeId = null;
  c.pending = null;
  say(s, 'Thanks for correcting me — let me check that again.');
  return applyResult(s, WORKFLOWS[c.wf!.name].start(wfCtx(s)));
}

async function onChoice(s: Session, optionId: string): Promise<void> {
  const c = s.ctx;
  const p = c.pending;
  if (!p || p.kind !== 'choice' || !p.options.some((o) => o.id === optionId)) return say(s, "Sorry, that option isn't available right now.");
  c.pending = null;
  if (p.scope === 'issue') {
    if (optionId === 'other') return handoff(s, 'out_of_policy', 'customer selected "something else"', "Thanks. That's something an agent can help with — I'll transfer you now and pass on what you've told me.");
    return setIssue(s, optionId as IssueType, 1.0);
  }
  if (!isVerified(c.verification)) return say(s, "Sorry, I can't do that until you're verified.");
  return applyResult(s, WORKFLOWS[c.wf!.name].onChoice(wfCtx(s), p.purpose, optionId));
}

async function onYesNoAnswer(s: Session, p: Extract<Pending, { kind: 'yes_no' }>, yes: boolean): Promise<void> {
  const c = s.ctx;
  c.pending = null;
  if (p.purpose === 'offer_agent') {
    if (yes) return handoff(s, p.agentReason ?? 'customer_accepted_offer', 'customer accepted offer of an agent', "I'll transfer you now. The agent will see everything we've covered.");
    if (p.agentReason === 'communication_breakdown') {
      c.pending = p.resume ?? null;
      say(s, p.resumePrompt ? `No problem, let's carry on. ${p.resumePrompt}` : "No problem, let's carry on.");
      return;
    }
    if (p.agentReason === 'ai_uncertain') {
      // Declined a person after an unclear request: go back to listening instead of ending the call.
      c.issue = null; c.stage = 'awaiting_issue';
      say(s, "No problem. Go ahead and tell me what you need, in your own words.");
      return;
    }
    return wrapUp(s);
  }
  if (p.purpose === 'reconcile') {
    if (yes) return onReconcile(s);
    return handoff(s, 'action_failed', 'customer declined status check; outcome unknown', "Okay. Because I can't confirm the outcome, I'll transfer you to an agent who can check it directly.");
  }
  if (p.purpose === 'readout:confirm') return onReadoutAnswer(s, yes);
  if (p.purpose.startsWith('wf:')) return applyResult(s, WORKFLOWS[c.wf!.name].onYesNo(wfCtx(s), p.purpose.slice(3), yes));
}

/* ------------------------------------------------------------------------- results → dialogue */

/** The transaction the workflow settled on is a bank fact; compare it with what the customer said. */
function recordTransactionFacts(s: Session): string | null {
  const c = s.ctx;
  const id = c.wf?.selectedTxnId;
  if (!id || !c.snapshotId) return null;
  const snap = loadSnapshot(c.snapshotId);
  const t = snap ? (sourceData(snap, 'transactions') ?? []).find((x) => x.transactionId === id) : undefined;
  if (!t) return null;
  const f = (c.facts ??= {});
  const already = f.transaction?.status === 'confirmed' && f.transaction.value.startsWith(formatMoney(t.amountMinor, t.currency)) && f.transaction.value.includes(t.merchant ?? '');
  if (already) return null;
  setFact(f, 'transaction', `${formatMoney(t.amountMinor, t.currency)} at ${t.merchant ?? 'unknown merchant'} on ${formatDate(t.transactedAt)} (${t.status})`, 'confirmed', 'bank_system');
  const notes: string[] = [];
  if (setFact(f, 'amount', formatMoney(t.amountMinor, t.currency), 'confirmed', 'bank_system') === 'conflict') notes.push(`you mentioned ${f.amount!.customerValue}, and the charge on record is ${formatMoney(t.amountMinor, t.currency)}`);
  if (t.merchant) {
    const said = f.merchant?.source === 'customer' ? f.merchant.value : null;
    const loose = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (said && (loose(t.merchant).includes(loose(said)) || loose(said).includes(loose(t.merchant)))) {
      f.merchant = { value: t.merchant, status: 'confirmed', source: 'bank_system', at: nowIso(), history: [{ value: said, status: 'provided', source: 'customer', at: f.merchant!.at, why: 'matched the bank record' }] };
    } else if (setFact(f, 'merchant', t.merchant, 'confirmed', 'bank_system') === 'conflict') notes.push(`you mentioned ${f.merchant!.customerValue}, and the merchant on record is ${t.merchant}`);
  }
  if (notes.length) tl(s, { type: 'facts.conflict', stage: 'explain', title: 'Customer’s details differ from the bank record', detail: notes.join('; '), status: 'warn', source: 'call facts' });
  return notes.length ? `Just to flag: ${notes.join(', and ')}. I'm going by the bank's record, so tell me if that's not the right charge.` : null;
}

async function applyResult(s: Session, r: WorkflowResult, prefixIn = ''): Promise<void> {
  const c = s.ctx;
  const caseId = c.caseId!;
  const prefix = [prefixIn, recordTransactionFacts(s)].filter(Boolean).join('\n\n');
  if (r.kind === 'inform') setFact(c.facts ??= {}, 'resolution', r.nextSteps || r.resolution.replace(/_/g, ' '), r.resolution === 'resolved' || r.resolution === 'informational' ? 'confirmed' : 'needs_clarification', 'workflow');
  if ('findings' in r && r.findings?.length) {
    recordFindings(caseId, r.findings);
    const conf = r.findings.filter((f) => f.kind === 'confirmed');
    const un = r.findings.filter((f) => f.kind === 'unavailable');
    if (conf.length) tl(s, { type: 'facts.confirmed', stage: 'explain', title: `${conf.length} fact${conf.length === 1 ? '' : 's'} confirmed by bank systems`, detail: conf.map((f) => f.text).join(' '), status: 'ok', source: [...new Set(conf.map((f) => f.source))].join(', '), data: { facts: conf } });
    if (un.length) tl(s, { type: 'facts.unavailable', stage: 'explain', title: `${un.length} item${un.length === 1 ? '' : 's'} could not be confirmed`, detail: un.map((f) => f.text).join(' '), status: 'warn', source: [...new Set(un.map((f) => f.source))].join(', ') });
  }
  if ('transactionRefs' in r && r.transactionRefs?.length) updateCase(caseId, { transaction_refs: r.transactionRefs });
  if ('eligibility' in r && r.eligibility) {
    updateCase(caseId, { eligibility: r.eligibility });
    const e = r.eligibility;
    tl(s, {
      type: 'eligibility.evaluated',
      stage: 'explain',
      title: e.eligible ? `Eligible under rule ${e.ruleCode}` : `Not eligible${e.ruleCode ? ` under rule ${e.ruleCode}` : ''}`,
      detail: e.eligible ? `All ${e.checks.length} deterministic checks passed (${e.checks.map((c) => c.check).join(', ')}).` : e.reasons.join(' '),
      status: e.eligible ? 'ok' : 'blocked',
      source: 'policy engine',
      data: { checks: e.checks, ruleVersion: e.ruleVersion },
    });
  }
  const pre = prefix ? `${prefix}\n\n` : '';

  switch (r.kind) {
    case 'clarify':
      c.pending = r.choices ? { kind: 'choice', purpose: r.purpose, options: r.choices, scope: 'workflow' } : { kind: 'free_text', purpose: r.purpose };
      say(s, pre + r.message);
      return;
    case 'ask_yes_no':
      c.pending = { kind: 'yes_no', purpose: `wf:${r.purpose}` };
      say(s, pre + r.message);
      return;
    case 'handoff':
      if (pre) say(s, prefix);
      return handoff(s, r.reason, r.detail, r.message, { missing: r.missing, priority: r.priority });
    case 'inform': {
      tl(s, { type: 'explained', stage: 'explain', title: r.resolution === 'resolved' || r.resolution === 'informational' ? 'Outcome explained to the customer' : 'Explained why this can’t be completed automatically', detail: r.nextSteps, status: r.resolution === 'resolved' || r.resolution === 'informational' ? 'ok' : 'warn', source: 'conversation' });
      run('UPDATE call_sessions SET resolution_status = ? WHERE id = ?', [r.resolution, s.id]);
      updateCase(caseId, { resolution_status: r.resolution, next_steps: r.nextSteps, status: r.resolution === 'resolved' || r.resolution === 'informational' ? 'resolved' : 'pending' });
      regenerateSummary(caseId);
      if (r.offerAgent) {
        c.pending = { kind: 'yes_no', purpose: 'offer_agent', agentReason: r.offerAgent.reason };
        // Recorded, not just held in the live context: if the caller hangs up instead of answering,
        // the records should still show that a person was offered rather than withheld.
        event(s, 'agent_offered', { reason: r.offerAgent.reason });
        tl(s, { type: 'handoff.offered', stage: 'resolve', title: 'A person was offered', detail: `This could not be completed automatically, so the customer was asked whether they would like an agent. ${HANDOFF_REASON_LABELS[r.offerAgent.reason] ?? r.offerAgent.reason}.`, status: 'pending', source: 'conversation' });
        say(s, `${pre}${r.message} ${r.offerAgent.question}`.trim());
        return;
      }
      if (pre || r.message) say(s, (pre + r.message).trim());
      return wrapUp(s);
    }
    case 'propose':
      return propose(s, r, pre);
  }
}

async function propose(s: Session, r: Extract<WorkflowResult, { kind: 'propose' }>, pre: string): Promise<void> {
  const c = s.ctx;
  // Actions are paused. The customer is not offered something that would then be refused: the
  // work found so far goes to a person, with what the assistant would have proposed written down.
  if (!assistantMayAct()) {
    const wanted = r.actions.map((a) => a.type).join(', ');
    tl(s, {
      type: 'safety.switch',
      stage: 'resolve',
      title: 'Actions are paused — this goes to a person instead',
      detail: `The assistant would have offered: ${wanted}. ${safetyState().reason ?? 'A safety switch is set.'} Nothing was changed on the account.`,
      status: 'warn',
      source: 'safety switch',
    });
    if (c.caseId) caseEvent(c.caseId, 'actions_paused', { wouldHaveProposed: r.actions.map((a) => ({ type: a.type, target: a.targetRef })) });
    return handoff(s, 'out_of_policy', `${PAUSED_DETAIL} (${wanted})`, 'I can see what needs doing here, but I’m not able to make changes to accounts at the moment, so I’ll put you through to one of our team who can. I’ve written down everything we’ve covered so you won’t have to repeat it.');
  }
  const snap = loadSnapshot(c.snapshotId!)!;
  const customerId = c.verification.identifiedCustomerId!;
  const actions: ProposedAction[] = [...r.actions];

  // Build and validate the structured dispute BEFORE asking for consent.
  if (r.dispute) {
    const txn = (sourceData(snap, 'transactions') ?? []).find((t) => t.transactionId === r.dispute!.txnId)!;
    const card = (sourceData(snap, 'card_status') ?? []).find((k) => k.cardRef === txn.cardRef) ?? null;
    const rule = (sourceData(snap, 'dispute_rules') ?? []).find((x) => x.reason === r.dispute!.reason)!;
    const draft = createDisputeDraft({
      caseId: c.caseId!, sessionId: s.id, customerId, txn, card, rule, customerExplanation: c.issue!.statement, evidence: r.dispute.evidence, priorCaseRefs: c.wf?.priorCaseIds ?? [],
    });
    const da = actions.find((a) => a.type === 'submit_dispute');
    if (da) da.params = { disputeId: draft.id };
    if (draft.missing.length) {
      caseEvent(c.caseId!, 'dispute_validation_failed', { disputeId: draft.id, missing: draft.missing });
      return handoff(s, 'out_of_policy', `dispute missing fields: ${draft.missing.join(', ')}`, 'I don’t have everything needed to file this dispute correctly, so I’ll pass it to an agent to complete with you.', { missing: draft.missing });
    }
  }

  const proposalId = newId('PRP');
  run(
    `INSERT INTO proposals (id, session_id, case_id, snapshot_id, actions_json, explanation, rule_refs_json, status, created_at) VALUES (?,?,?,?,?,?,?, 'proposed', ?)`,
    [proposalId, s.id, c.caseId, snap.id, JSON.stringify(actions), redactText(r.message), JSON.stringify(r.ruleRefs), nowIso()],
  );
  run('UPDATE call_sessions SET proposal_at = COALESCE(proposal_at, ?) WHERE id = ?', [nowIso(), s.id]);
  caseEvent(c.caseId!, 'actions_proposed', { proposalId, actions: actions.map((a) => ({ type: a.type, target: a.targetRef })), ruleRefs: r.ruleRefs });

  // Each proposed action becomes an operation awaiting confirmation (lifecycle requested → validated → awaiting_confirmation).
  for (const a of actions) {
    const { op } = prepareAction({
      type: a.type, sessionId: s.id, caseId: c.caseId, customerId, targetRef: a.targetRef, params: a.params, snapshotId: snap.id,
      actor: { type: 'customer_session', id: s.id }, idempotencyKey: `${proposalId}:${a.type}:${a.targetRef}`, correlationId: s.correlationId, scenarioId: s.scenarioId,
    });
    if (op.status === 'rejected') {
      run("UPDATE proposals SET status = 'superseded', decided_at = ? WHERE id = ?", [nowIso(), proposalId]);
      for (const o of opsForProposal(proposalId)) declineAction(o.id, s.actor, s.correlationId);
      const reason = op.error_code === 'SOURCE_DATA_UNSAFE' ? 'system_unavailable' : 'out_of_policy';
      return handoff(s, reason, `pre-validation rejected ${a.type}: ${op.error_code}`, 'I’m not able to safely set that up from here, so nothing has been changed. I’ll transfer you to an agent who can help.');
    }
  }
  c.pending = { kind: 'consent', proposalId };
  setFact(c.facts ??= {}, 'consent', `Asked: ${actions.map((a) => a.label).join('; ')}`, 'needs_clarification', 'workflow');
  tl(s, { type: 'actions.proposed', stage: 'confirm', title: `Proposed ${actions.length} action${actions.length === 1 ? '' : 's'} — waiting for the customer’s confirmation`, detail: actions.map((a, i) => `${i + 1}) ${a.label}`).join(' '), status: 'pending', source: 'policy engine', ref: proposalId, data: { actions: actions.map((a) => ({ type: a.type, label: a.label })), ruleRefs: r.ruleRefs } });
  say(s, pre + r.message);
}

function opsForProposal(proposalId: string): Operation[] {
  return opsForSession(get<{ session_id: string }>('SELECT session_id FROM proposals WHERE id = ?', [proposalId])?.session_id ?? '').filter((o) => o.idempotency_key.startsWith(`${proposalId}:`));
}

/* ------------------------------------------------------------------------- consent & execution */

async function onConsent(s: Session, proposalId: string, decision: 'accept' | 'decline', via: 'button' | 'utterance'): Promise<void> {
  const c = s.ctx;
  const prop = get<{ status: string; session_id: string; actions_json: string }>('SELECT status, session_id, actions_json FROM proposals WHERE id = ?', [proposalId]);
  if (!prop || prop.session_id !== s.id) return say(s, "Sorry, I couldn't find that request.");
  if (prop.status !== 'proposed' || c.pending?.kind !== 'consent' || c.pending.proposalId !== proposalId) {
    // Duplicate or stale confirmation: never re-execute.
    event(s, 'duplicate_consent_ignored', { proposalId, proposalStatus: prop.status });
    audit({ actor: s.actor, event: 'consent.duplicate_ignored', status: 'info', resourceType: 'proposal', resourceId: proposalId, sessionId: s.id, correlationId: s.correlationId });
    return;
  }
  const consentId = newId('CNS');
  const ok = tx(() => {
    const upd = run('UPDATE proposals SET status = ?, decided_at = ? WHERE id = ? AND status = ?', [decision === 'accept' ? 'accepted' : 'declined', nowIso(), proposalId, 'proposed']);
    if (upd.changes !== 1) return false;
    run('INSERT INTO consents (id, proposal_id, session_id, decision, captured_via, expires_at, created_at) VALUES (?,?,?,?,?,?,?)', [
      consentId, proposalId, s.id, decision === 'accept' ? 'accepted' : 'declined', via, new Date(nowMs() + policy().consent.ttlSeconds * 1000).toISOString(), nowIso(),
    ]);
    return true;
  });
  if (!ok) return;
  c.pending = null;
  setFact(c.facts ??= {}, 'consent', decision === 'accept' ? `Customer said yes (${via === 'button' ? 'on screen' : 'in their own words'})` : 'Customer said no; nothing was changed', 'confirmed', 'customer');
  audit({ actor: s.actor, event: `consent.${decision === 'accept' ? 'accepted' : 'declined'}`, status: 'ok', resourceType: 'proposal', resourceId: proposalId, sessionId: s.id, correlationId: s.correlationId, metadata: { consentId, via } });
  caseEvent(c.caseId!, decision === 'accept' ? 'consent_accepted' : 'consent_declined', { proposalId, consentId });
  tl(s, { type: decision === 'accept' ? 'consent.given' : 'consent.declined', stage: 'confirm', title: decision === 'accept' ? 'Customer confirmed the proposed actions' : 'Customer declined — nothing will be changed', detail: `Consent ${consentId} is linked to proposal ${proposalId} and covers only those actions; it expires in ${Math.round(policy().consent.ttlSeconds / 60)} minutes.`, status: decision === 'accept' ? 'ok' : 'info', source: `customer (${via})`, ref: consentId });

  if (decision === 'decline') {
    for (const op of opsForProposal(proposalId)) declineAction(op.id, s.actor, s.correlationId);
    return applyResult(s, WORKFLOWS[c.wf!.name].onDeclined(wfCtx(s)));
  }
  run('UPDATE call_sessions SET consent_at = COALESCE(consent_at, ?) WHERE id = ?', [nowIso(), s.id]);
  return executeProposal(s, proposalId, consentId);
}

async function executeProposal(s: Session, proposalId: string, consentId: string): Promise<void> {
  const c = s.ctx;
  const actions = parseJson<ProposedAction[]>(get<{ actions_json: string }>('SELECT actions_json FROM proposals WHERE id = ?', [proposalId])?.actions_json, []);
  const ops = opsForProposal(proposalId);
  const byType = (t: string) => ops.find((o) => o.action_type === t);
  const results: Operation[] = [];
  const executedNow = new Set<string>();
  let halted = false;

  for (const a of actions) {
    const op = byType(a.type);
    if (!op) continue;
    let cur = getOp(op.id)!;
    if (cur.status === 'awaiting_confirmation' || cur.status === 'validated') {
      const dep = a.requires ? getOp(byType(a.requires)?.id ?? '') : null;
      if (dep && dep.status !== 'succeeded') {
        if (dep.status === 'unknown' || dep.status === 'submitted') {
          halted = true; // wait for reconciliation, then resume
          continue;
        }
        cur = declineActionWith(cur, 'DEPENDENCY_FAILED', `Not attempted because "${a.requires}" did not succeed.`);
      } else {
        cur = await confirmAndExecute(op.id, consentId, s.actor, s.correlationId);
        executedNow.add(cur.id);
      }
    }
    results.push(cur);
  }
  run('UPDATE call_sessions SET execution_completed_at = ? WHERE id = ?', [nowIso(), s.id]);
  regenerateSummary(c.caseId!);
  tl(s, { type: 'summary.generated', stage: 'record', title: 'Case summary updated from recorded outcomes', detail: 'Built only from persisted facts and confirmed action results — not from generated text.', status: 'ok', source: 'case management', ref: c.caseId });
  refreshTags(s, 'act');
  const lines = results.filter((o) => executedNow.has(o.id)).map((o) => M.describeOutcome(o));
  const skipped = results.filter((o) => o.error_code === 'DEPENDENCY_FAILED');
  if (skipped.length) lines.push(`I haven't done the remaining step${skipped.length > 1 ? 's' : ''} because the earlier one didn't go through.`);
  const outcomeText = lines.join('\n');

  const unknown = results.find((o) => o.status === 'unknown');
  if (unknown || halted) {
    c.resume = { proposalId, consentId };
    c.pending = { kind: 'yes_no', purpose: 'reconcile' };
    say(s, `${outcomeText}\n\nWould you like me to check the status now?`);
    return;
  }
  const approval = results.find((o) => o.status === 'awaiting_approval');
  if (approval) {
    say(s, outcomeText);
    return handoff(s, 'approval_required', `${approval.action_type} held for human approval`, 'An agent will review and approve it with you — I’m transferring you now.');
  }
  c.resume = null;
  const next = WORKFLOWS[c.wf!.name].afterActions(wfCtx(s), results);
  return applyResult(s, next, outcomeText);
}

function declineActionWith(op: Operation, code: string, msg: string): Operation {
  run("UPDATE action_operations SET status = 'rejected', error_code = ?, error_message = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status IN ('awaiting_confirmation','validated')", [code, msg, nowIso(), nowIso(), op.id]);
  run('INSERT INTO action_status_history (operation_id, from_status, to_status, note, created_at) VALUES (?,?,?,?,?)', [op.id, op.status, 'rejected', code, nowIso()]);
  return getOp(op.id)!;
}

async function onReconcile(s: Session): Promise<void> {
  const c = s.ctx;
  const open = opsForSession(s.id).filter((o) => o.status === 'unknown' || o.status === 'submitted');
  if (!open.length) return say(s, 'There are no pending actions to check.');
  c.pending = null;
  const lines: string[] = [];
  for (const o of open) {
    let r = await reconcile(o.id, s.actor, s.correlationId);
    event(s, 'operation_reconciled', { operationId: o.id, status: r.status });
    if (r.status === 'failed' && r.error_code === 'NOT_RECEIVED') {
      lines.push('The system had no record of the request, so it is safe to send it again. Resending now.');
      r = await retryAction(r.id, s.actor, s.correlationId);
    }
    lines.push(`Checked: ${M.describeOutcome(r)}`);
  }
  regenerateSummary(c.caseId!);
  const stillOpen = opsForSession(s.id).filter((o) => o.status === 'unknown');
  if (stillOpen.length) {
    say(s, lines.join('\n'));
    return handoff(s, 'action_failed', 'operation outcome still unknown after reconciliation', "I still can't confirm the outcome, so I won't guess. I'm transferring you to an agent who can check directly.", { priority: 'urgent' });
  }
  if (c.resume) {
    const { proposalId, consentId } = c.resume;
    c.resume = null;
    say(s, lines.join('\n'));
    return executeProposal(s, proposalId, consentId);
  }
  const pendingDispute = open.find((o) => o.action_type === 'submit_dispute');
  say(s, lines.join('\n'));
  if (pendingDispute) return wrapUp(s);
}

/* ------------------------------------------------------------------------- handoff, fallback, end */

async function handoff(s: Session, reason: string, detail: string, message: string, opts: { missing?: string[]; priority?: 'normal' | 'urgent' } = {}): Promise<void> {
  const c = s.ctx;
  if (c.stage === 'handoff') return;
  c.caseId = ensureCase({
    sessionId: s.id,
    customerId: isVerified(c.verification) ? c.verification.identifiedCustomerId : null,
    issueType: c.issue?.issueType ?? null,
    verificationOutcome: c.verification.status === 'verified' ? 'verified' : c.verification.status === 'failed' ? 'failed' : 'not_verified',
    customerReported: c.issue?.statement ?? lastCustomerText(s.id),
    actor: s.actor,
    correlationId: s.correlationId,
  });
  c.pending = null;
  setFact(c.facts ??= {}, 'resolution', `Passed to a person: ${detail}`, 'needs_clarification', 'workflow');
  event(s, 'handoff_requested', { reason });
  if (reason === 'verification_failed') await retrieveGuidance(s, 'handoff', ['verification', 'handoff'], { agentReview: true });
  else if (reason === 'social_engineering_suspected' || reason === 'account_takeover_suspected') await retrieveGuidance(s, 'handoff', ['security', 'handoff'], { agentReview: true });
  else await retrieveGuidance(s, 'handoff', ['handoff'], { agentReview: true });
  const r = await requestHandoff({ sessionId: s.id, caseId: c.caseId, reason, reasonDetail: detail, actor: s.actor, correlationId: s.correlationId, missing: opts.missing, priority: opts.priority });
  // The case gets a ticket automatically, so the team that picks it up has one record to work from.
  // Its number is also the one reference the caller is given, said out loud and shown on screen:
  // two different numbers for one escalation is worse than none.
  let ticketRef: string | null = null;
  try {
    ticketRef = createTicket(c.caseId, ASSISTANT, { type: reason === 'complaint' ? 'complaint' : 'escalation', reason: `${HANDOFF_REASON_LABELS[reason] ?? reason}: ${detail}`.slice(0, 300), requestKey: `handoff:${r.handoffId}` }).ticket.id;
  } catch (e) {
    log.warn('ticket creation failed', { sessionId: s.id, error: (e as Error).message });
  }
  c.escalationRef = ticketRef ?? c.caseId;
  tl(s, { type: 'handoff.prepared', stage: 'handoff', title: 'Agent brief prepared from the recorded call', detail: `Reason: ${detail}. The brief carries the customer’s words, verification status, facts, actions and next step.`, status: 'ok', source: 'handoff', ref: r.handoffId });
  refreshTags(s, 'handoff');
  if (r.status === 'queued') {
    tl(s, { type: 'handoff.queued', stage: 'handoff', title: `Waiting for an agent (position ${r.queuePosition ?? 1})`, detail: 'The transfer is not complete until an agent accepts it.', status: 'pending', source: 'agent desk', ref: r.handoffId });
    c.stage = 'handoff';
    run("UPDATE call_sessions SET outcome = 'handed_off' WHERE id = ?", [s.id]);
    // One message per handoff: the reason line and the queue facts together, never two separate texts.
    say(s, message ? `${message} You are number ${r.queuePosition ?? 1} in the queue. Your reference number is ${sayRef(c.escalationRef)} — the agent will have it in front of them.` : `${M.TRANSFER_INTRO('this')} Thank you for your patience. You are number ${r.queuePosition ?? 1} in the queue. Your reference number is ${sayRef(c.escalationRef)}.`, message ? undefined : 'system');
  } else {
    say(
      s,
      `I'm sorry — no agents are available right now, so I can't transfer you. I've saved everything under reference ${sayRef(c.escalationRef)} and requested a callback to your registered phone number. Nothing further has been changed on your account.`,
      'system',
    );
    event(s, 'handoff_fallback_callback', { handoffId: r.handoffId });
    tl(s, { type: 'handoff.no_agent', stage: 'handoff', title: 'No agent available — callback requested instead', detail: 'Nothing is described as transferred. The case holds everything for the callback.', status: 'failed', source: 'agent desk', ref: r.handoffId });
    return endCall(s, 'ended_unresolved');
  }
}

/**
 * The agent on the call asked for a passcode. The digits the caller types answer that check and
 * nothing else: they are never stored, and the call's own verification state is left alone.
 */
async function answerAgentCheck(s: Session, text: string): Promise<boolean> {
  const c = s.ctx;
  const check = readCheck(s.id);
  if (check?.status !== 'awaiting') return false;
  const code = text.replace(/\D/g, '');
  if (code.length < 4) return false;
  const r = await submitAgentCheck(s.id, code);
  if (!r) return false;
  // Keep the result on the context this turn is holding: the turn's own save happens after this
  // and would otherwise write back the state the turn started with.
  c.agentCheck = r.check;
  if (r.outcome === 'passed') say(s, 'Thank you — that passcode matched, and the agent can see the check passed.', 'system');
  else if (r.outcome === 'locked') say(s, "That passcode didn't match, and we've run out of attempts. The agent will take it from here.", 'system');
  else say(s, "That passcode didn't match. Please check the message and type it again.", 'system');
  return true;
}

async function onWhileInHandoff(s: Session): Promise<void> {
  const h = get<{ status: string }>("SELECT status FROM handoffs WHERE session_id = ? ORDER BY requested_at DESC LIMIT 1", [s.id]);
  if (h?.status === 'connected') return; // the agent is talking to the caller now
  const now = nowMs();
  const last = get<{ created_at: string }>("SELECT created_at FROM conversation_turns WHERE session_id = ? AND speaker = 'system' ORDER BY seq DESC LIMIT 1", [s.id]);
  if (!last || now - Date.parse(last.created_at) > 5000) say(s, "You're still in the queue. An agent will join shortly — I've noted your message on the case so they can see it.", 'system');
}

async function enterFallback(s: Session, err: Error): Promise<void> {
  const c = s.ctx;
  const unavailable = err instanceof AssistantUnavailableError;
  log.error('orchestrator.fallback', { sessionId: s.id, err: err.message });
  event(s, unavailable ? 'assistant_unavailable' : 'orchestrator_error', { error: err.message.slice(0, 200) });
  audit({ actor: ASSISTANT, event: unavailable ? 'assistant.unavailable' : 'assistant.error', status: 'error', sessionId: s.id, correlationId: s.correlationId, metadata: { stage: c.stage } });
  run("UPDATE call_sessions SET outcome = 'fallback' WHERE id = ?", [s.id]);
  tl(s, { type: 'assistant.unavailable', stage: 'handoff', title: unavailable ? 'Assistant engine unavailable — controlled fallback' : 'Unexpected error — controlled fallback', detail: 'Session and case state were kept; the call is routed to the agent queue. No action was taken.', status: 'failed', source: 'conversation engine' });
  c.stage = 'fallback';
  c.pending = null;
  say(s, "I'm sorry — our automated assistant is temporarily unavailable. I've safely saved what you've told me, and I'm routing your call to the card services team. Nothing has been changed on your account.", 'system');
  try {
    c.caseId = ensureCase({
      sessionId: s.id,
      customerId: isVerified(c.verification) ? c.verification.identifiedCustomerId : null,
      issueType: c.issue?.issueType ?? null,
      verificationOutcome: c.verification.status === 'verified' ? 'verified' : 'not_verified',
      customerReported: c.issue?.statement ?? lastCustomerText(s.id),
      actor: ASSISTANT,
      correlationId: s.correlationId,
    });
    const r = await requestHandoff({ sessionId: s.id, caseId: c.caseId, reason: 'assistant_unavailable', reasonDetail: err.message.slice(0, 120), actor: ASSISTANT, correlationId: s.correlationId });
    if (r.status === 'queued') {
      c.stage = 'handoff';
      run("UPDATE call_sessions SET outcome = 'fallback' WHERE id = ?", [s.id]);
      say(s, `You're in the queue for the next available agent. Your reference is ${c.caseId}.`, 'system');
    } else {
      say(s, `No agents are available right now. A callback has been requested on case ${c.caseId}.`, 'system');
      await endCall(s, 'fallback');
    }
  } catch (e2) {
    log.error('orchestrator.fallback_failed', { sessionId: s.id, err: (e2 as Error).message });
  }
}

function lastCustomerText(sessionId: string): string | null {
  return get<{ text: string }>("SELECT text FROM conversation_turns WHERE session_id = ? AND speaker = 'customer' AND sensitive_redacted = 0 ORDER BY seq DESC LIMIT 1", [sessionId])?.text ?? null;
}

async function onSilence(s: Session): Promise<void> {
  const c = s.ctx;
  c.silenceCount++;
  event(s, 'silence', { count: c.silenceCount, stage: c.stage });
  if (c.stage === 'handoff') return;
  if (c.silenceCount > policy().conversation.maxSilenceReprompts) {
    say(s, `I haven't heard anything for a while, so I'll end the call now.${c.caseId ? ` Everything is saved on case ${c.caseId}.` : ''} Please call back any time.`);
    return endCall(s, c.issue || get("SELECT 1 FROM kb_references WHERE session_id = ? AND article_id LIKE 'INFO-%'", [s.id]) ? undefined : 'abandoned');
  }
  say(s, `Are you still there? ${c.lastPrompt}`);
}


/* ------------------------------------------------------------------------- sensitive requests */

/** A short, bounded pause while the back end checks something, so the customer hears it is being thought through. */
async function hold(s: Session, title: string, detail: string): Promise<void> {
  const ms = env().NODE_ENV === 'test' ? 0 : 1200;
  const at = nowMs();
  say(s, M.HOLD_LINES[Math.min(s.ctx.unclearCount + (s.ctx.contact?.tries ?? 0), M.HOLD_LINES.length - 1)]);
  tl(s, { type: 'call.hold', stage: 'investigate', title, detail, status: 'running', source: 'assistant' });
  if (ms) await new Promise((r) => setTimeout(r, ms));
  tl(s, { type: 'call.hold_ended', stage: 'investigate', title: `${title} — done`, detail: `Held for ${nowMs() - at} ms (limit 3000 ms).`, status: 'ok', source: 'assistant' });
}

function reasoning(s: Session, title: string, detail: string, status: 'ok' | 'warn' | 'blocked' = 'ok'): void {
  event(s, 'reasoning', { title });
  tl(s, { type: 'reasoning', stage: 'investigate', title: `Reasoning: ${title}`, detail, status, source: 'policy' });
}

function askStepUp(s: Session, then: 'contact' | 'readout'): void {
  const c = s.ctx;
  c.stepUp = { then, returnTo: c.stage === 'stepup' ? 'workflow' : c.stage, attempts: 0, unparsed: 0 };
  c.stage = 'stepup';
  c.pending = null;
  reasoning(s, 'second-level check needed', then === 'contact' ? 'Changing how the bank contacts the customer needs a stronger check than the one used to open the call.' : 'Reading account activity aloud needs a stronger check than the one used to open the call.', 'warn');
  say(s, then === 'contact' ? M.STEP_UP_CONTACT : M.STEP_UP_READOUT);
}

async function onStepUpAnswer(s: Session, text: string): Promise<void> {
  const c = s.ctx;
  const su = c.stepUp;
  if (!su || !isVerified(c.verification)) { c.stage = 'workflow'; return; }
  const back = () => { c.stage = su.returnTo; c.stepUp = null; c.contact = null; c.pending = null; };
  if (/\b(don'?t|do not|can'?t|cannot|no)\b.{0,20}\b(have|know|remember|want|give)\b|\b(skip|cancel|never ?mind|forget it|not now)\b/i.test(text)) {
    back();
    event(s, 'stepup_declined', {});
    return say(s, M.STEP_UP_DECLINED);
  }
  const digits = parseNationalIdLast4(text);
  if (!digits) {
    su.unparsed++;
    if (su.unparsed >= 3) { back(); return say(s, M.STEP_UP_DECLINED); }
    return say(s, M.STEP_UP_RETRY_UNCLEAR);
  }
  su.attempts++;
  const ok = checkNationalId(c.verification.identifiedCustomerId, digits);
  event(s, 'stepup_attempt', { ok, attempt: su.attempts });
  if (ok) {
    c.assurance = 'strong';
    tl(s, { type: 'verification.stepup', stage: 'verify', title: 'Second-level check passed', detail: 'National ID digits matched the bank record. The digits are not stored.', status: 'ok', source: 'identity check' });
    const then = su.then;
    c.stage = su.returnTo; c.stepUp = null;
    say(s, M.STEP_UP_OK);
    return then === 'contact' ? askContactValue(s) : askReadoutConfirm(s);
  }
  tl(s, { type: 'verification.stepup', stage: 'verify', title: `Second-level check did not match (attempt ${su.attempts} of ${STEP_UP_MAX_ATTEMPTS})`, detail: 'The customer is not told which part was wrong.', status: 'warn', source: 'identity check' });
  if (su.attempts >= STEP_UP_MAX_ATTEMPTS) {
    c.stepUp = null; c.contact = null; c.stage = 'workflow';
    addRiskFlag(c.caseId!, 'second_level_check_failed');
    return handoff(s, 'social_engineering_suspected', `second-level check failed ${su.attempts} times after the normal check passed`, M.STEP_UP_LOCKED);
  }
  return say(s, M.STEP_UP_RETRY(STEP_UP_MAX_ATTEMPTS - su.attempts));
}

/* ---- reading account activity aloud: only on request, after the second check, after a spoken confirmation */

async function startReadout(s: Session): Promise<void> {
  const c = s.ctx;
  reasoning(s, 'customer asked me to read account activity aloud', 'Default is to check a detail the customer describes, not to read records out. Reading them out needs the second-level check and a spoken confirmation that it is safe to say them.');
  if (c.assurance !== 'strong') return askStepUp(s, 'readout');
  return askReadoutConfirm(s);
}

function askReadoutConfirm(s: Session): void {
  s.ctx.pending = { kind: 'yes_no', purpose: 'readout:confirm' };
  say(s, M.READOUT_CONFIRM);
}

async function onReadoutAnswer(s: Session, yes: boolean): Promise<void> {
  const c = s.ctx;
  if (!yes) { reasoning(s, 'customer did not confirm', 'Nothing was read out.'); return say(s, M.READOUT_DECLINED); }
  reasoning(s, 'double confirmation received', 'Second-level check passed and the customer confirmed it is safe. Reading the most recent purchases once.');
  c.readoutOk = true;
  try {
    await applyResult(s, WORKFLOWS[c.wf!.name].start(wfCtx(s)));
  } finally {
    c.readoutOk = false;
  }
}

/* ---- contact-detail change: collected and double-confirmed here, applied only by a person */

async function startContactChange(s: Session, kind: ContactKind): Promise<void> {
  const c = s.ctx;
  c.pending = null;
  const risk = assessContactRisk(s.id, c.caseId, c.flags);
  c.contact = { kind, step: 'value', risk, tries: 0 };
  event(s, 'contact_change_requested', { kind, risk: risk.level });
  await hold(s, `Checking the account before a ${kind} change`, 'Looking at what has happened in this call and on the account.');
  reasoning(
    s,
    `${kind} change requested`,
    risk.signals.length
      ? `Risk is HIGH: ${risk.signals.join('; ')}. A change of ${kind} right after that is a known takeover pattern. The assistant will not apply it; a specialist reviews it. The second-level check is still required.`
      : `No risk signals in this call. The second-level check is required and the request goes to staff for review; the assistant never applies a ${kind} change itself.`,
    risk.level === 'high' ? 'warn' : 'ok',
  );
  if (c.caseId) caseEvent(c.caseId, 'contact_change_requested', { kind, risk: risk.level, signals: risk.signals });
  if (c.assurance !== 'strong') return askStepUp(s, 'contact');
  return askContactValue(s);
}

function askContactValue(s: Session): void {
  const c = s.ctx;
  c.contact!.step = 'value';
  c.pending = { kind: 'free_text', purpose: 'contact:value' };
  say(s, M.CONTACT_ASK_VALUE(c.contact!.kind));
}

async function thirdParty(s: Session): Promise<void> {
  const c = s.ctx;
  c.assurance = undefined;
  c.readoutOk = false;
  c.contact = null;
  c.pending = null;
  reasoning(s, 'caller says they are not the account holder', 'The identity check was passed by whoever is on the line, but the caller now says the account is someone else\'s. Nothing will be disclosed or changed. A specialist decides what to do.', 'blocked');
  if (c.caseId) addRiskFlag(c.caseId, 'third_party_caller');
  return handoff(s, 'social_engineering_suspected', 'caller said they are acting for the account holder', M.THIRD_PARTY);
}

function validContact(kind: ContactKind, v: string): boolean {
  if (kind === 'phone') return v.replace(/\D/g, '').length >= 8;
  if (kind === 'email') return /\S+@\S+\.\S+/.test(v);
  return v.length >= 12 && /\d/.test(v) && v.split(/\s+/).length >= 3;
}

async function onContactText(s: Session, text: string): Promise<void> {
  const c = s.ctx;
  const ct = c.contact!;
  const yn = parseYesNo(text);
  if (/\b(cancel|never ?mind|forget it|stop|don'?t (change|need)|leave it)\b/i.test(text) && ct.step !== 'value') { c.contact = null; c.pending = null; event(s, 'contact_change_cancelled', {}); return say(s, M.CONTACT_CANCELLED); }
  if (ct.step === 'value') {
    if (/\b(cancel|never ?mind|forget it|leave it)\b/i.test(text)) { c.contact = null; c.pending = null; return say(s, M.CONTACT_CANCELLED); }
    let value = text.replace(/^\s*(it'?s|it is|my new \w+ is|the new \w+ is|new \w+:?)\s*/i, '').trim().slice(0, 200);
    // Spoken email: "name dot test at example dot com".
    if (ct.kind === 'email' && !value.includes('@')) value = value.replace(/\s+at\s+/i, '@').replace(/\s+dot\s+/gi, '.').replace(/\s+/g, '');
    if (!validContact(ct.kind, value)) {
      ct.tries++;
      if (ct.tries >= 3) { c.contact = null; c.pending = null; return say(s, M.CONTACT_GAVE_UP); }
      return say(s, M.CONTACT_RETRY_VALUE(ct.kind));
    }
    if (ct.kind === 'email') value = value.replace('@', ' at ').replace(/\./g, ' dot ').replace(/\s+/g, ' ').trim();
    ct.value = value; ct.step = 'confirm1';
    c.pending = { kind: 'yes_no', purpose: 'contact:confirm' };
    return say(s, M.CONTACT_READBACK(ct.kind, value));
  }
  if (yn === null) return say(s, M.CONTACT_YES_OR_NO);
  if (ct.step === 'confirm1') {
    if (yn === 'no') { ct.value = undefined; return askContactValue(s); }
    ct.step = 'confirm2';
    c.pending = { kind: 'yes_no', purpose: 'contact:confirm' };
    return say(s, M.CONTACT_SECOND_CONFIRM(ct.kind, ct.value!, ct.risk.level === 'high'));
  }
  // confirm2
  if (yn === 'no') { c.contact = null; c.pending = null; return say(s, M.CONTACT_CANCELLED); }
  return submitContactChange(s);
}

async function submitContactChange(s: Session): Promise<void> {
  const c = s.ctx;
  const ct = c.contact!;
  c.pending = null;
  await hold(s, `Preparing the ${ct.kind} change for review`, 'Writing the request and the reasons to the case.');
  const label = `${ct.kind} change`;
  const high = ct.risk.level === 'high';
  let ref = '';
  try {
    const r = createTicket(c.caseId!, ASSISTANT, {
      type: 'escalation',
      reason: `Customer asked to change their ${ct.kind} after passing the second-level check. New ${ct.kind}: ${ct.value}. ${high ? `HIGH RISK: ${ct.risk.signals.join('; ')}.` : 'No risk signals in the call.'} Not applied; needs staff review.`.slice(0, 300),
      team: 'Fraud and security',
      priority: high ? 'urgent' : 'normal',
      requestKey: `contact:${c.caseId}:${ct.kind}:${s.id}`.slice(0, 80),
    });
    ref = r.ticket.id as string;
  } catch (e) {
    log.warn('contact-change ticket failed', { sessionId: s.id, error: (e as Error).message });
  }
  if (c.caseId) caseEvent(c.caseId, 'contact_change_submitted', { kind: ct.kind, risk: ct.risk.level, signals: ct.risk.signals, ticket: ref || null });
  tl(s, { type: 'contact.change_submitted', stage: 'act', title: `${label} sent for review, not applied`, detail: high ? `Escalated to a specialist. ${ct.risk.signals.join('; ')}.` : 'Queued for staff review. The assistant cannot change contact details.', status: high ? 'warn' : 'ok', source: 'policy', ref: ref || undefined });
  c.contact = null;
  if (high) {
    reasoning(s, 'handing over to a specialist', `Because ${ct.risk.signals[0]}, a person must decide. Handing over now with the request attached.`, 'warn');
    return handoff(s, 'account_takeover_suspected', `${label} requested while ${ct.risk.signals.join('; ')}`, M.CONTACT_HANDOFF(ct.kind, ct.risk.signals[0]));
  }
  say(s, M.CONTACT_SUBMITTED(ct.kind));
  return wrapUp(s);
}

function wrapUp(s: Session): void {
  s.ctx.stage = 'wrap_up';
  s.ctx.pending = { kind: 'yes_no', purpose: 'anything_else' };
  say(s, M.ANYTHING_ELSE);
}

function goSurvey(s: Session): void {
  s.ctx.stage = 'awaiting_survey';
  s.ctx.pending = null;
  say(s, M.SURVEY);
}

async function onSurvey(s: Session, score: number | null): Promise<void> {
  if (score && score >= 1 && score <= 5) {
    run('UPDATE call_sessions SET csat = ? WHERE id = ?', [Math.round(score), s.id]);
    event(s, 'survey_answered', { score, simulated: true });
  }
  say(s, M.GOODBYE);
  return endCall(s);
}

/** A short, factual summary for calls that never opened a case (general questions): what was asked and how it ended. */
function writeCallSummary(s: Session): void {
  const asked = all<{ text: string }>("SELECT text FROM conversation_turns WHERE session_id = ? AND speaker = 'customer' AND sensitive_redacted = 0 ORDER BY seq", [s.id]).map((r) => r.text).filter((x) => x.trim().length > 3).slice(0, 6);
  const topics = [...new Set(all<{ article_id: string }>("SELECT article_id FROM kb_references WHERE session_id = ? AND article_id LIKE 'INFO-%'", [s.id]).map((r) => r.article_id.replace('INFO-', '')))];
  tl(s, { type: 'summary.generated', stage: 'record', title: 'Call summary', detail: `${asked.length ? `The caller asked: ${asked.map((a) => `"${a.slice(0, 90)}"`).join('; ')}. ` : 'No questions were captured. '}${topics.length ? `Answered from bank information: ${topics.join(', ')}.` : 'No bank information was needed.'} No case was opened.`, status: 'ok', source: 'assistant' });
}

export async function endCall(s: Session, forced?: 'abandoned' | 'ended_unresolved' | 'fallback'): Promise<void> {
  const c = s.ctx;
  // Ending is idempotent: a repeated click or event must not create a second record or re-run post-call work.
  if (c.stage === 'ended') return;
  const row = get<{ outcome: string | null; resolution_status: string | null; verification_status: string }>('SELECT outcome, resolution_status, verification_status FROM call_sessions WHERE id = ?', [s.id])!;
  const handedOff = !!get("SELECT 1 FROM handoffs WHERE session_id = ? AND status IN ('queued','connected','completed')", [s.id]);
  let outcome: string | null = forced ?? null;
  if (!outcome) {
    if (row.outcome === 'fallback') outcome = 'fallback';
    else if (handedOff) outcome = 'handed_off';
    else if (row.verification_status === 'failed') outcome = 'verification_failed';
    else if (row.resolution_status === 'resolved' || row.resolution_status === 'informational') outcome = 'resolved';
    else if (!c.issue?.issueType) outcome = get("SELECT 1 FROM kb_references WHERE session_id = ? AND article_id LIKE 'INFO-%'", [s.id]) ? 'resolved' : 'abandoned';
    else outcome = 'ended_unresolved';
  }
  // An unresolved operation means the call cannot count as resolved.
  if (outcome === 'resolved' && opsForSession(s.id).some((o) => o.status === 'unknown')) outcome = 'ended_unresolved';
  c.stage = 'ended';
  c.pending = null;
  run('UPDATE call_sessions SET outcome = ?, ended_at = COALESCE(ended_at, ?), updated_at = ? WHERE id = ?', [outcome, nowIso(), nowIso(), s.id]);
  run('UPDATE hold_intervals SET ended_at = ? WHERE session_id = ? AND ended_at IS NULL', [nowIso(), s.id]);
  run("UPDATE handoffs SET status = 'cancelled', updated_at = ? WHERE session_id = ? AND status IN ('requested','queued')", [nowIso(), s.id]);
  if (c.caseId) {
    if (outcome === 'resolved') updateCase(c.caseId, { status: 'resolved' });
    regenerateSummary(c.caseId);
  }
  event(s, 'call_ended', { outcome });
  if (!c.caseId) writeCallSummary(s);
  if (c.caseId) tl(s, { type: 'summary.generated', stage: 'record', title: 'Final case summary generated', detail: 'Separates what the customer reported, what systems confirmed, and what actions actually completed.', status: 'ok', source: 'case management', ref: c.caseId });
  refreshTags(s, 'resolve');
  tl(s, { type: 'call.closed', stage: outcome === 'handed_off' || outcome === 'fallback' ? 'handoff' : 'resolve', title: `Call closed — ${String(outcome).replace(/_/g, ' ')}`, status: outcome === 'resolved' ? 'ok' : outcome === 'abandoned' ? 'info' : 'warn', source: 'conversation', ref: c.caseId ?? s.correlationId });
  audit({ actor: s.actor, event: 'call.ended', status: 'ok', resourceType: 'session', resourceId: s.id, sessionId: s.id, correlationId: s.correlationId, metadata: { outcome } });
  // Post-call analysis has its own status. If it fails the call stays saved and the analysis can be retried.
  const status = analyseCall(s.id, s.actor);
  tl(s, { type: 'analysis.' + status, stage: 'record', title: status === 'ready' ? 'Post-call summary, reason and tags saved' : 'Post-call analysis failed — transcript and call record are kept; it can be retried', status: status === 'ready' ? 'ok' : 'failed', source: 'post-call analysis' });
}

/** Staff-side hangup / end (used by the simulator "End call" and tests). */
export async function hangup(sessionId: string): Promise<void> {
  await handleInput(sessionId, { kind: 'hangup' });
}

export function getContext(sessionId: string): CallContext {
  return load(sessionId).ctx;
}

/** Remember which virtual agent has the call, so a reconnect or a new browser tab resumes with the same one. */
export function setAgentLang(sessionId: string, lang: string): void {
  const s = load(sessionId);
  s.ctx.agentLang = lang;
  save(s);
}
