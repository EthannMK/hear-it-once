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
import { initialVerification, isVerified, startVerification, submitVerificationAnswer, type VerificationState } from '../verification/verification.ts';
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
import { profileById } from '../live/profiles.ts';
import { SCENARIOS, scenarioById } from '../db/scenarios.ts';
import { maskPhone } from '../lib/redact.ts';
import { ISSUE_LABELS, formatDate } from './format.ts';

export type Stage =
  | 'awaiting_issue'
  | 'clarifying_issue'
  | 'identifying'
  | 'awaiting_dob'
  | 'awaiting_otp'
  | 'awaiting_card'
  | 'workflow'
  | 'wrap_up'
  | 'awaiting_survey'
  | 'handoff'
  | 'ended'
  | 'fallback';

type Pending =
  | { kind: 'choice'; purpose: string; options: Choice[]; scope: 'issue' | 'workflow' }
  | { kind: 'consent'; proposalId: string }
  | { kind: 'yes_no'; purpose: string; agentReason?: string }
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
  lastUtterance: { hash: string; at: string } | null;
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
    tl(s, { type: 'kb.none', stage, title: 'No relevant knowledge article found', detail: `Query: ${query}. Continuing with configured rules only.`, status: 'warn', source: 'knowledge base (synthetic)' });
    return;
  }
  for (const r of results) {
    recordKbReference(s.id, r, query, { supportsNextStep: !!opts.supportsNextStep, agentReview: !!opts.agentReview });
    tl(s, { type: 'kb.retrieved', stage, title: `Guidance retrieved: ${r.article.id} ${r.article.title}`, detail: `Why: ${r.reason}. ${r.article.excerpt}`, status: 'ok', source: 'knowledge base (synthetic)', data: { articleId: r.article.id } });
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
  };
  const profile = input.profileId ? profileById(input.profileId) : undefined;
  if (input.profileId && !profile) throw new Error('Unknown demo profile.');
  if (profile) {
    input = { ...input, scenarioId: profile.scenarioId };
    ctx.verificationMode = 'card_number';
    ctx.profileId = profile.id;
    ctx.freeMode = false;
  }
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
  tl(s, { type: 'call.initiated', stage: 'understand', title: 'Call answered — no menu, no queue', detail: `Channel: ${input.channel === 'voice_browser' ? 'browser voice' : 'text simulator'}${profile ? `; active demo customer ${sc!.customer.name} (caller ID matched — identification only)` : sc ? `; demo scenario ${sc.id}` : ctx.freeMode ? '; free-talk demo' : ''}.`, status: 'ok', source: 'telephony (simulated)', ref: correlationId });
  say(s, M.GREETING_NOTICE, 'system');
  // On a live voice call Lily speaks her own greeting; the AI disclosure is recorded when she has
  // actually said it (see the voice bridge), not assumed here.
  if (input.channel !== 'voice_browser') {
    say(s, M.GREETING);
    tl(s, { type: 'disclosure.given', stage: 'understand', title: 'AI and recording disclosure given', detail: 'The caller was told they are speaking with an AI assistant and given the recording/privacy notice before any assistance.', status: 'ok', source: 'conversation', ref: correlationId });
  }
  event(s, 'call_answered', { channel: input.channel ?? 'text_simulator' });
  audit({ actor: s.actor, event: 'call.started', status: 'ok', resourceType: 'session', resourceId: id, sessionId: id, correlationId, metadata: { scenarioId: input.scenarioId ?? null, channel: input.channel } });
  save(s);
  return id;
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

/* ------------------------------------------------------------------------- dispatch */

const SENSITIVE_STAGES: Stage[] = ['identifying', 'awaiting_dob', 'awaiting_otp', 'awaiting_card'];

async function dispatch(s: Session, input: CallInput): Promise<void> {
  const c = s.ctx;
  switch (input.kind) {
    case 'hangup':
      event(s, 'customer_hangup');
      return endCall(s, c.issue ? undefined : 'abandoned');
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
  const text = input.text.trim().slice(0, 1000);
  const sensitive = SENSITIVE_STAGES.includes(c.stage);
  // Verification answers are never written to the transcript.
  addTurn(s.id, 'customer', sensitive ? '[verification answer — not stored]' : text, { sensitive, clientMessageId: input.clientMessageId, asrConfidence: input.asrConfidence ?? null });
  c.silenceCount = 0;
  if (!text) return onSilence(s);

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
  if (c.stage !== 'awaiting_card' && c.lastUtterance && c.lastUtterance.hash === h && nowMs() - Date.parse(c.lastUtterance.at) < policy().conversation.duplicateUtteranceWindowMs) {
    event(s, 'duplicate_utterance_ignored');
    return;
  }
  c.lastUtterance = { hash: h, at: nowIso() };


  if (c.stage === 'handoff') return onWhileInHandoff(s);
  if (c.stage === 'awaiting_survey') {
    const n = Number(text.match(/[1-5]/)?.[0]);
    return onSurvey(s, Number.isFinite(n) ? n : null);
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
  if (sig.humanRequested) return handoff(s, 'customer_requested', 'customer asked for a person', 'Of course — I’ll connect you with a member of our team.');
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
      const yn = parseYesNo(text);
      // A new, supported banking topic in an already verified call is handled here, not handed off.
      if (yn === null && isVerified(c.verification) && text.length > 8) {
        const cls = await classify(s, redactText(text));
        if (cls.issueType && cls.confidence >= policy().conversation.minIntentConfidence) return startSecondaryTopic(s, cls, text);
      }
      if (yn === 'yes' || (yn === null && text.length > 12)) return handoff(s, 'customer_accepted_offer', 'additional request after resolution', "I'll connect you to an agent for that — they'll see everything from this call, so you won't need to repeat it.");
      return goSurvey(s);
    }
    case 'fallback':
      return say(s, 'Please hold — you are being routed to the card services team. Everything you told me is saved.', 'system');
    default:
      return;
  }
}

/* ------------------------------------------------------------------------- issue capture */

async function onIssueText(s: Session, text: string, distressed: boolean): Promise<void> {
  const c = s.ctx;
  const combined = c.issue && c.stage === 'clarifying_issue' ? `${c.issue.statement} ${redactText(text)}` : redactText(text);
  const cls = await classify(s, combined);
  const min = policy().conversation.minIntentConfidence;
  const clarifications = c.issue?.clarifications ?? 0;
  c.issue = { ...cls, statement: combined, slots: mergeSlots(c.issue?.slots, cls.slots), clarifications };
  run('UPDATE call_sessions SET issue_statement = ?, updated_at = ? WHERE id = ?', [combined, nowIso(), s.id]);
  event(s, 'intent_classified', { issueType: cls.issueType, confidence: cls.confidence, model: cls.model });
  tl(s, {
    type: 'intent.identified',
    stage: 'understand',
    title: cls.issueType ? `Intent identified: ${ISSUE_LABELS[cls.issueType]}` : cls.unsupportedTopic ? `Request outside supported scope (${cls.unsupportedTopic.replace(/_/g, ' ')})` : 'Intent not clear yet',
    detail: `Confidence ${cls.confidence.toFixed(2)} (${cls.model}); threshold ${min}. ${slotSummary(c.issue.slots)}`,
    status: cls.issueType && cls.confidence >= min ? 'ok' : 'warn',
    source: `intent model: ${cls.model}`,
  });

  if (cls.unsupportedTopic && !cls.issueType) {
    return handoff(s, 'out_of_policy', `unsupported topic: ${cls.unsupportedTopic}`, `I'm not able to help with that here — I can help with lost or stolen cards, unrecognised or duplicate charges, payments and fees. I'll transfer you to an agent who can help.`);
  }
  if (cls.issueType && cls.confidence >= min) return setIssue(s, cls.issueType, cls.confidence, distressed);

  if (clarifications >= policy().conversation.maxIssueClarifications) {
    return handoff(s, 'ai_uncertain', `intent confidence ${cls.confidence.toFixed(2)} after ${clarifications} clarification(s)`, "I'm not completely sure I've understood, and I don't want to guess with your account. I'm transferring you to an agent, and I'll pass on what you've told me so you won't need to start again.");
  }
  c.issue.clarifications++;
  c.stage = 'clarifying_issue';
  c.pending = { kind: 'choice', purpose: 'issue_type', options: M.ISSUE_CHOICES, scope: 'issue' };
  event(s, 'issue_clarification_requested', { confidence: cls.confidence });
  tl(s, { type: 'clarification.requested', stage: 'understand', title: 'Asked one clarifying question', detail: 'Below the confidence threshold — offered the five supported issue types rather than guessing.', status: 'pending', source: 'conversation' });
  say(s, M.CLARIFY_ISSUE);
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
  if (c.freeMode && !c.verification.identifiedCustomerId) await bindFreeTalkPersona(s, issueType);
  say(s, (distressed ? 'I understand — and if at any point you’d prefer a person, just say so. ' : '') + M.ackIssue(issueType));
  tl(s, { type: 'verification.started', stage: 'verify', title: issueType === 'lost_stolen_card' ? 'Identity verification started — card block will follow immediately' : 'Identity verification started', detail: c.verificationMode === 'card_number' ? 'Demo check: the full card number is compared on the server with the active demo customer’s record. Nothing about the account is read until it matches. (Synthetic demo verification, not production identity checking.)' : 'Two factors required: date of birth, then a one-time passcode to the registered phone. Nothing about the account is read until both pass.', status: 'running', source: 'identity verification (simulated)' });
  // Verification begins immediately (lost/stolen fast path uses the same flow, nothing else first).
  const ev = await startVerification(vctx(s), c.verification, null, c.verificationMode ?? 'dob_otp');
  if (c.verification.identifiedCustomerId && c.verification.identifiedBy === 'ani' && ev.type === 'need_identifier') {
    c.verification.status = 'awaiting_dob';
    run("UPDATE call_sessions SET verification_status = 'identified' WHERE id = ?", [s.id]);
    run("INSERT INTO verification_attempts (session_id, customer_id, step, method, outcome, created_at) VALUES (?,?, 'identify', 'ani', 'passed', ?)", [s.id, c.verification.identifiedCustomerId, nowIso()]);
  }
  if (c.verificationMode === 'card_number' && c.verification.identifiedCustomerId) {
    // Active demo customer is known from caller ID (identification only). Ask for the card number.
    c.verification.status = 'awaiting_card';
    run("UPDATE call_sessions SET verification_status = 'identified' WHERE id = ?", [s.id]);
    c.stage = 'awaiting_card';
    say(s, M.ASK_CARD);
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
  tl(s, { type: 'demo.persona', stage: 'verify', title: `Demo: you are calling as ${sc.customer.name} (synthetic customer)`, detail: `Chosen because the request is about ${ISSUE_LABELS[issueType].toLowerCase()}. Caller ID matched a synthetic profile — identification only, not proof of identity.`, status: 'info', source: 'demo environment' });
}

const vctx = (s: Session) => ({ sessionId: s.id, correlationId: s.correlationId, scenarioId: s.scenarioId, actor: s.actor });

/* ------------------------------------------------------------------------- verification */

async function onVerificationAnswer(s: Session, text: string): Promise<void> {
  const c = s.ctx;
  const ev = await submitVerificationAnswer(vctx(s), c.verification, text);
  switch (ev.type) {
    case 'need_card':
      c.stage = 'awaiting_card';
      return say(s, M.ASK_CARD);
    case 'need_dob':
      c.stage = 'awaiting_dob';
      return say(s, `Thank you. ${M.ASK_DOB}`);
    case 'otp_sent':
      c.stage = 'awaiting_otp';
      tl(s, { type: 'verification.factor_passed', stage: 'verify', title: 'Date of birth matched', detail: `One-time passcode sent to the registered phone (${ev.deliveredTo}).`, status: 'ok', source: 'identity verification (simulated)' });
      return say(s, M.otpSent(ev.deliveredTo));
    case 'retry':
      if (ev.unparsed) {
        c.unclearCount++;
        if (c.unclearCount >= 3) return handoff(s, 'communication_breakdown', `could not capture ${ev.step} answer`, "I'm having trouble capturing that. Let me connect you with an agent who can help verify you.");
      }
      if (!ev.unparsed) tl(s, { type: 'verification.retry', stage: 'verify', title: ev.step === 'card' ? `Card number check failed — no match (${ev.remaining} attempt${ev.remaining === 1 ? '' : 's'} left)` : `Verification answer did not match (${ev.remaining} attempt${ev.remaining === 1 ? '' : 's'} left)`, detail: ev.step === 'card' ? 'The number given did not match the active customer’s record. The expected number is never revealed and the call carries on.' : 'Generic message given — the caller is not told which detail was wrong.', status: 'warn', source: 'identity verification (simulated)', data: { attemptResult: 'failed', attemptsRemaining: ev.remaining } });
      else if (ev.step === 'card') tl(s, { type: 'verification.unclear', stage: 'verify', title: 'Card number not captured clearly — asked again (no attempt used)', status: 'info', source: 'identity verification (simulated)' });
      return say(s, M.retryVerification(ev.step, ev.remaining, ev.unparsed));
    case 'locked':
      event(s, 'verification_failed', { step: ev.step });
      run("UPDATE call_sessions SET outcome = 'verification_failed' WHERE id = ?", [s.id]);
      c.caseId = ensureCase({ sessionId: s.id, customerId: null, issueType: c.issue?.issueType ?? null, verificationOutcome: 'failed', customerReported: c.issue?.statement ?? null, actor: s.actor, correlationId: s.correlationId });
      addRiskFlag(c.caseId, 'verification_failed');
      tl(s, { type: 'verification.failed', stage: 'verify', title: ev.step === 'card' ? 'Card number check failed 3 times — preparing handover to a person' : 'Identity verification failed — locked after 3 attempts', detail: 'No account data was read or disclosed and no action is possible. Routing to an agent to verify another way.', status: 'failed', source: 'identity verification (simulated)', ref: c.caseId });
      refreshTags(s, 'verify');
      return handoff(s, 'verification_failed', `locked at ${ev.step}`, M.LOCKED);
    case 'verified':
      c.unclearCount = 0;
      event(s, 'verified');
      tl(s, { type: 'verification.passed', stage: 'verify', title: c.verificationMode === 'card_number' ? 'Card number matched — identity verified (demo check)' : 'Identity verified (two factors)', detail: c.verificationMode === 'card_number' ? 'The card number matched the active demo customer’s record on the server. Protected reads are now allowed. Synthetic demo verification only.' : 'Date of birth and one-time passcode both passed. Protected reads are now allowed.', status: 'ok', source: 'identity verification (simulated)', data: { attemptResult: 'passed' } });
      refreshTags(s, 'verify');
      return onVerified(s);
    default:
      return;
  }
}

async function onVerified(s: Session): Promise<void> {
  const c = s.ctx;
  const customerId = c.verification.identifiedCustomerId!;
  const issueType = c.issue!.issueType!;
  say(s, M.VERIFIED);
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
  say(s, M.ackIssue(issueType));
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
  return { snap: sn, slots: c.issue!.slots, statement: c.issue!.statement, wf: c.wf!, sessionId: s.id, customerId: c.verification.identifiedCustomerId!, firstName: c.firstName ?? '' };
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
  if (!answeringSomething && text.length > 12) {
    const cls = await classify(s, redactText(text));
    if (cls.issueType && cls.issueType !== c.issue?.issueType && cls.confidence >= Math.max(0.7, policy().conversation.minIntentConfidence)) return startSecondaryTopic(s, cls, text);
  }

  if (p?.kind === 'consent') {
    if (isCorrection(text) || hasNewDetails(c, text)) return onCorrection(s, text);
    const yn = parseYesNo(text);
    if (yn) return onConsent(s, p.proposalId, yn === 'yes' ? 'accept' : 'decline', 'utterance');
    return unclear(s, 'Sorry — should I go ahead? Please say yes or no, or ask for an agent.');
  }
  if (p?.kind === 'yes_no') {
    if (/\b(check|status|did it work|worked|go through|went through)\b/i.test(text) && p.purpose === 'reconcile') return onReconcile(s);
    const yn = parseYesNo(text);
    if (!yn) return unclear(s, 'Sorry — was that a yes or a no?');
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
    return unclear(s, 'Sorry, which one did you mean? You can say "the first one", or tap an option.');
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
  s.ctx.unclearCount++;
  event(s, 'unclear_input', { count: s.ctx.unclearCount });
  if (s.ctx.unclearCount >= 3) return handoff(s, 'communication_breakdown', 'repeated unclear input', "I'm sorry I'm not getting this right. I'll connect you with a person — they'll see everything we've covered.");
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
    return wrapUp(s);
  }
  if (p.purpose === 'reconcile') {
    if (yes) return onReconcile(s);
    return handoff(s, 'action_failed', 'customer declined status check; outcome unknown', "Okay. Because I can't confirm the outcome, I'll transfer you to an agent who can check it directly.");
  }
  if (p.purpose.startsWith('wf:')) return applyResult(s, WORKFLOWS[c.wf!.name].onYesNo(wfCtx(s), p.purpose.slice(3), yes));
}

/* ------------------------------------------------------------------------- results → dialogue */

async function applyResult(s: Session, r: WorkflowResult, prefix = ''): Promise<void> {
  const c = s.ctx;
  const caseId = c.caseId!;
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
  if (message) say(s, message);
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
  event(s, 'handoff_requested', { reason });
  if (reason === 'verification_failed') await retrieveGuidance(s, 'handoff', ['verification', 'handoff'], { agentReview: true });
  else if (reason === 'social_engineering_suspected' || reason === 'account_takeover_suspected') await retrieveGuidance(s, 'handoff', ['security', 'handoff'], { agentReview: true });
  else await retrieveGuidance(s, 'handoff', ['handoff'], { agentReview: true });
  const r = await requestHandoff({ sessionId: s.id, caseId: c.caseId, reason, reasonDetail: detail, actor: s.actor, correlationId: s.correlationId, missing: opts.missing, priority: opts.priority });
  tl(s, { type: 'handoff.prepared', stage: 'handoff', title: 'Agent brief prepared from the recorded call', detail: `Reason: ${detail}. The brief carries the customer’s words, verification status, facts, actions and next step.`, status: 'ok', source: 'handoff', ref: r.handoffId });
  refreshTags(s, 'handoff');
  if (r.status === 'queued') {
    tl(s, { type: 'handoff.queued', stage: 'handoff', title: `Waiting for an agent (position ${r.queuePosition ?? 1}) — simulated desk`, detail: 'The transfer is not complete until an agent accepts it.', status: 'pending', source: 'agent desk (simulated)', ref: r.handoffId });
    c.stage = 'handoff';
    run("UPDATE call_sessions SET outcome = 'handed_off' WHERE id = ?", [s.id]);
    say(s, `Your call is in the queue for the next available agent (position ${r.queuePosition ?? 1}). Please hold — the agent will see your case ${c.caseId} and everything we've discussed. [Simulated agent desk: a demo agent must accept this in the Agent Console.]`, 'system');
  } else {
    say(
      s,
      `I'm sorry — no agents are available right now, so I can't transfer you. I've saved everything on case ${c.caseId} and requested a callback to your registered phone number. Nothing further has been changed on your account.`,
      'system',
    );
    event(s, 'handoff_fallback_callback', { handoffId: r.handoffId });
    tl(s, { type: 'handoff.no_agent', stage: 'handoff', title: 'No agent available — callback requested instead', detail: 'Nothing is described as transferred. The case holds everything for the callback.', status: 'failed', source: 'agent desk (simulated)', ref: r.handoffId });
    return endCall(s, 'ended_unresolved');
  }
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
      say(s, `You're in the queue for the next available agent. Your reference is ${c.caseId}. [Simulated agent desk]`, 'system');
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
    return endCall(s, c.issue ? undefined : 'abandoned');
  }
  say(s, `Are you still there? ${c.lastPrompt}`);
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

export async function endCall(s: Session, forced?: 'abandoned' | 'ended_unresolved' | 'fallback'): Promise<void> {
  const c = s.ctx;
  const row = get<{ outcome: string | null; resolution_status: string | null; verification_status: string }>('SELECT outcome, resolution_status, verification_status FROM call_sessions WHERE id = ?', [s.id])!;
  const handedOff = !!get("SELECT 1 FROM handoffs WHERE session_id = ? AND status IN ('queued','connected','completed')", [s.id]);
  let outcome: string | null = forced ?? null;
  if (!outcome) {
    if (row.outcome === 'fallback') outcome = 'fallback';
    else if (handedOff) outcome = 'handed_off';
    else if (row.verification_status === 'failed') outcome = 'verification_failed';
    else if (row.resolution_status === 'resolved' || row.resolution_status === 'informational') outcome = 'resolved';
    else if (!c.issue?.issueType) outcome = 'abandoned';
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
  if (c.caseId) tl(s, { type: 'summary.generated', stage: 'record', title: 'Final case summary generated', detail: 'Separates what the customer reported, what systems confirmed, and what actions actually completed.', status: 'ok', source: 'case management', ref: c.caseId });
  refreshTags(s, 'resolve');
  tl(s, { type: 'call.closed', stage: outcome === 'handed_off' || outcome === 'fallback' ? 'handoff' : 'resolve', title: `Call closed — ${String(outcome).replace(/_/g, ' ')}`, status: outcome === 'resolved' ? 'ok' : outcome === 'abandoned' ? 'info' : 'warn', source: 'conversation', ref: c.caseId ?? s.correlationId });
  audit({ actor: s.actor, event: 'call.ended', status: 'ok', resourceType: 'session', resourceId: s.id, sessionId: s.id, correlationId: s.correlationId, metadata: { outcome } });
}

/** Staff-side hangup / end (used by the simulator "End call" and tests). */
export async function hangup(sessionId: string): Promise<void> {
  await handleInput(sessionId, { kind: 'hangup' });
}

export function getContext(sessionId: string): CallContext {
  return load(sessionId).ctx;
}
