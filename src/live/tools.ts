/**
 * LILY'S TOOLS. Each tool is validated here, on the server, before anything runs. The model may
 * request a tool; it never gets to bypass verification, consent or policy, because the real
 * work is done by the existing orchestrator, policy engine and action service, and protected
 * reads are gated on the persisted verification status of THIS call.
 */
import { all, get } from '../db/db.ts';
import { AppError } from '../lib/errors.ts';
import { redactText } from '../lib/redact.ts';
import { audit, ASSISTANT } from '../audit/audit.ts';
import { emitTimeline } from '../events/timeline.ts';
import { knowledgeBase, recordKbReference } from '../kb/kb.ts';
import { handleInput, getContext } from '../conversation/orchestrator.ts';
import { policy } from '../config/policy.ts';
import { TOOL } from './lily.ts';

export interface ToolContext {
  sessionId: string;
  /** The caller's own transcribed words for the current turn (already spoken-number normalised). */
  customerText: string;
  turnId: string;
  /** Marks this turn's words as consumed so a second tool call cannot reuse them as fresh consent. */
  consumeCustomerText(): void;
}

interface Turn {
  seq: number;
  speaker: string;
  text: string;
}

const turnsAfter = (sessionId: string, seq: number) =>
  all<Turn>("SELECT seq, speaker, text FROM conversation_turns WHERE session_id = ? AND seq > ? AND speaker IN ('assistant','system','agent') ORDER BY seq", [sessionId, seq]);
const maxSeq = (sessionId: string) => get<{ m: number | null }>('SELECT MAX(seq) m FROM conversation_turns WHERE session_id = ?', [sessionId])?.m ?? 0;

/** Low-confidence markers a recogniser may emit; the orchestrator then asks the caller to repeat. */
export function estimateAsrConfidence(text: string): number | undefined {
  if (/\[(?:inaudible|unclear|noise|unintelligible)[^\]]*\]|<noise>|<unk>/i.test(text) || text.replace(/[^a-z0-9]/gi, '').length < 2) return 0.2;
  return undefined;
}

function stateSummary(sessionId: string) {
  const s = get<{ verification_status: string; state: string }>('SELECT verification_status, state FROM call_sessions WHERE id = ?', [sessionId])!;
  const ctx = getContext(sessionId);
  const h = get<{ status: string }>("SELECT status FROM handoffs WHERE session_id = ? AND status != 'cancelled' ORDER BY requested_at DESC LIMIT 1", [sessionId]);
  const pending = ctx.pending;
  return {
    identity: s.verification_status === 'verified' ? 'verified' : s.verification_status === 'failed' ? 'locked_after_failed_attempts' : 'not_yet_verified',
    awaiting: pending?.kind === 'consent' ? 'customer_yes_or_no_to_the_proposed_action' : pending?.kind === 'choice' ? 'customer_to_choose_one_option' : pending?.kind === 'yes_no' ? 'customer_yes_or_no' : ctx.stage === 'awaiting_card' ? 'full_16_digit_card_number' : ctx.stage === 'awaiting_dob' ? 'date_of_birth' : ctx.stage === 'awaiting_otp' ? 'one_time_passcode' : ctx.stage === 'identifying' ? 'customer_number' : 'nothing_specific',
    options: pending?.kind === 'choice' ? pending.options.map((o) => o.label) : [],
    handoff: h ? { status: h.status === 'queued' || h.status === 'requested' ? 'waiting_for_an_agent_not_yet_accepted' : h.status === 'connected' ? 'accepted_by_an_agent' : h.status } : null,
    callEnded: ctx.stage === 'ended',
  };
}

const GUIDE = 'Say this to the customer in natural spoken words. Keep every fact and amount exactly as given. Do not add anything the back end did not say.';

export async function runTool(name: string, args: Record<string, unknown>, c: ToolContext): Promise<Record<string, unknown>> {
  const at = Date.now();
  emitTimeline(c.sessionId, { type: 'tool.requested', stage: 'understand', title: `Lily asked the back end to ${toolVerb(name)}`, status: 'running', source: 'voice agent', data: { tool: name } });
  audit({ actor: ASSISTANT, event: 'live.tool_requested', status: 'info', sessionId: c.sessionId, metadata: { tool: name } });
  try {
    const out = await dispatch(name, args, c);
    audit({ actor: ASSISTANT, event: 'live.tool_completed', status: out.ok === false ? 'denied' : 'ok', sessionId: c.sessionId, metadata: { tool: name, ms: Date.now() - at } });
    return out;
  } catch (e) {
    const msg = e instanceof AppError ? e.message : 'The back end could not complete that.';
    emitTimeline(c.sessionId, { type: 'tool.failed', stage: 'investigate', title: `${toolVerb(name)} did not complete`, detail: msg, status: 'failed', source: 'voice agent' });
    audit({ actor: ASSISTANT, event: 'live.tool_failed', status: 'failed', sessionId: c.sessionId, metadata: { tool: name } });
    return { ok: false, error: 'tool_failed', message: `${msg} Tell the customer you could not complete that and offer a person. Do not guess a result.` };
  }
}

function toolVerb(name: string): string {
  return name === TOOL.banking ? 'handle that request' : name === TOOL.human ? 'start a human handover' : name === TOOL.kb ? 'search guidance' : name === TOOL.card ? 'check the card number' : name;
}

async function dispatch(name: string, args: Record<string, unknown>, c: ToolContext): Promise<Record<string, unknown>> {
  switch (name) {
    case TOOL.banking: {
      const text = c.customerText.trim();
      if (!text) return { ok: false, error: 'no_new_customer_speech', message: 'The customer has not said anything new. Do not act. Ask them what they would like to do or to repeat themselves.' };
      c.consumeCustomerText();
      const before = maxSeq(c.sessionId);
      await handleInput(c.sessionId, { kind: 'utterance', text, clientMessageId: `voice-${c.turnId}`, asrConfidence: estimateAsrConfidence(text) });
      return { ok: true, backend_said: turnsAfter(c.sessionId, before).map((t) => t.text), ...stateSummary(c.sessionId), instruction: GUIDE };
    }
    case TOOL.card: {
      const ctx0 = getContext(c.sessionId);
      if (ctx0.stage !== 'awaiting_card') return { ok: false, error: 'not_expecting_a_card_number', ...stateSummary(c.sessionId), message: 'The back end is not asking for a card number right now. Do not collect one. Use the banking tool for what the customer said.' };
      const text = c.customerText.trim();
      if (text.replace(/\D/g, '').length < 1) return { ok: false, error: 'no_card_number_heard', message: 'No card number was heard. Ask the customer to read the 16-digit number from the card shown on their screen.' };
      c.consumeCustomerText();
      const before = maxSeq(c.sessionId);
      // The server uses the customer's own transcribed digits, never digits supplied by the model.
      await handleInput(c.sessionId, { kind: 'utterance', text, clientMessageId: `voice-${c.turnId}-card`, asrConfidence: estimateAsrConfidence(text) });
      const after = getContext(c.sessionId);
      const ver = after.verification;
      const max = policy().verification.maxCardAttempts;
      return {
        ok: true,
        verified: ver.status === 'verified',
        card_number_matched: ver.status === 'verified',
        attempts_used: ver.cardAttempts ?? 0,
        attempts_remaining: ver.status === 'verified' ? max - (ver.cardAttempts ?? 0) : Math.max(0, max - (ver.cardAttempts ?? 0)),
        locked: ver.status === 'failed',
        backend_said: turnsAfter(c.sessionId, before).map((t) => t.text),
        ...stateSummary(c.sessionId),
        instruction: GUIDE + ' Never say or hint at the correct card number.',
      };
    }
    case TOOL.human: {
      const text = c.customerText.trim();
      if (text) c.consumeCustomerText();
      const before = maxSeq(c.sessionId);
      await handleInput(c.sessionId, { kind: 'request_human', spokenText: text || undefined, clientMessageId: `voice-${c.turnId}-human` });
      return {
        ok: true,
        backend_said: turnsAfter(c.sessionId, before).map((t) => t.text),
        ...stateSummary(c.sessionId),
        instruction: 'Tell the customer, briefly and warmly, that you are passing their case to the agent desk, that it carries what you have discussed so they will not need to repeat it, and that they are waiting until an agent accepts. Do NOT say an agent has joined. This is an in-app handover, not a phone transfer. If no agent is available say so and say a callback was requested.',
      };
    }
    case TOOL.kb: {
      const query = String(args.query ?? '').slice(0, 200);
      if (!query.trim()) return { ok: false, error: 'empty_query' };
      emitTimeline(c.sessionId, { type: 'kb.search', stage: 'investigate', title: `Searching guidance: “${redactText(query)}”`, status: 'running', source: 'knowledge base' });
      const ctx = getContext(c.sessionId);
      const results = await knowledgeBase().search({ issueType: ctx.issue?.issueType ?? null, text: query, context: [] });
      for (const r of results) recordKbReference(c.sessionId, r, query, { supportsNextStep: false, agentReview: false });
      emitTimeline(c.sessionId, { type: 'kb.result', stage: 'investigate', title: results.length ? `Found ${results.length} guidance article${results.length > 1 ? 's' : ''}` : 'No relevant guidance found', detail: results.map((r) => r.article.title).join('; ') || null, status: results.length ? 'ok' : 'warn', source: 'knowledge base' });
      if (!results.length) return { ok: true, found: false, instruction: 'There is no guidance on this. Say so plainly, do not guess, and offer a person.' };
      return { ok: true, found: true, articles: results.map((r) => ({ title: r.article.title, summary: r.article.excerpt, steps: r.article.steps })), instruction: 'This is general guidance, not a decision about the customer\'s account and not permission to act. Explain it simply.' };
    }
    default:
      throw new AppError('VALIDATION_FAILED', 'Unknown tool.');
  }
}

