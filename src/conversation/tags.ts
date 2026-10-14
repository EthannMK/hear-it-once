/**
 * LIVE CALL TAGS — deterministic classification shown to operations as the call evolves.
 * Urgency follows explicit demo rules. Sentiment is an INDICATIVE signal from the caller's own
 * words (keyword rules), never presented as a fact about the customer.
 */
import { get, parseJson } from '../db/db.ts';
import { ISSUE_LABELS } from './format.ts';

export interface CallTags {
  intent: string | null;
  intentLabel: string;
  intentConfidence: number | null;
  /** Further topics raised in the same call; the primary intent above never changes. */
  secondaryIntents: { intent: string; label: string }[];
  category: string;
  urgency: 'normal' | 'elevated';
  urgencyReason: string;
  identity: 'unverified' | 'in_progress' | 'verified' | 'failed';
  sentiment: 'neutral' | 'frustrated' | 'reassured';
  sentimentBasis: string;
  outcome: 'in_progress' | 'resolved' | 'handed_off' | 'ended';
  caseStatus: 'none' | 'created' | 'escalated' | 'resolved' | 'pending';
}

const CATEGORY: Record<string, string> = {
  unrecognised_transaction: 'Transaction dispute · suspected fraud',
  lost_stolen_card: 'Card security',
  wrong_or_duplicate_charge: 'Transaction dispute',
  payment_not_showing: 'Payments',
  fee_query: 'Fees and charges',
  card_declined: 'Card troubleshooting',
};

const FRUSTRATED = /\b(again|still|ridiculous|annoyed|annoying|frustrat\w*|angry|upset|useless|unacceptable|third time|second time|fed up|panick?\w*|scared|worried)\b/i;
const REASSURED = /\b(thank(s| you)|great|perfect|that'?s (good|great|helpful)|appreciate|brilliant|awesome)\b/i;

/** Update the indicative sentiment from a new caller utterance. */
export function sentimentFrom(text: string, prev: CallTags['sentiment'] | undefined): { sentiment: CallTags['sentiment']; basis: string } | null {
  if (FRUSTRATED.test(text)) return { sentiment: 'frustrated', basis: `caller said “${text.match(FRUSTRATED)![0]}”` };
  if (REASSURED.test(text)) return { sentiment: 'reassured', basis: `caller said “${text.match(REASSURED)![0]}”` };
  return prev ? null : { sentiment: 'neutral', basis: 'no strong cue in the caller’s words' };
}

export function computeTags(sessionId: string, ctx: { issue?: { issueType: string | null; confidence: number } | null; sentiment?: { sentiment: CallTags['sentiment']; basis: string } | null; flags?: string[]; secondary?: string[] }): CallTags {
  const s = get<{ verification_status: string; outcome: string | null; ended_at: string | null; issue_type: string | null }>(
    'SELECT verification_status, outcome, ended_at, issue_type FROM call_sessions WHERE id = ?',
    [sessionId],
  )!;
  const c = get<{ status: string; risk_flags_json: string }>('SELECT status, risk_flags_json FROM cases WHERE session_id = ?', [sessionId]);
  const flags = c ? parseJson<string[]>(c.risk_flags_json, []) : [];
  const handoff = get<{ status: string }>("SELECT status FROM handoffs WHERE session_id = ? AND status != 'cancelled' ORDER BY requested_at DESC LIMIT 1", [sessionId]);
  const blockFailed = !!get("SELECT 1 FROM action_operations WHERE session_id = ? AND action_type = 'block_card' AND status IN ('failed','unknown')", [sessionId]);
  const fraudAlert = flags.includes('fraud_alert') || ctx.flags?.includes('fraud_alert');
  // The first captured topic is the primary intent; later topics are listed as secondary.
  const issue = s.issue_type ?? ctx.issue?.issueType ?? null;
  const secondary = [...new Set(ctx.secondary ?? [])].filter((x) => x !== issue).map((x) => ({ intent: x, label: ISSUE_LABELS[x] }));

  let urgency: CallTags['urgency'] = 'normal';
  let urgencyReason = 'no elevated-urgency rule applies';
  if (issue === 'lost_stolen_card') [urgency, urgencyReason] = ['elevated', 'rule: lost or stolen card'];
  if (issue === 'unrecognised_transaction' && fraudAlert) [urgency, urgencyReason] = ['elevated', 'rule: open fraud alert on the transaction'];
  if (flags.includes('account_takeover_risk')) [urgency, urgencyReason] = ['elevated', 'rule: account-takeover risk signal'];
  if (blockFailed) [urgency, urgencyReason] = ['elevated', 'rule: card block not confirmed'];

  const identity: CallTags['identity'] =
    s.verification_status === 'verified' ? 'verified' : s.verification_status === 'failed' ? 'failed' : s.verification_status === 'not_started' ? 'unverified' : 'in_progress';

  const outcome: CallTags['outcome'] = handoff ? 'handed_off' : s.ended_at ? (s.outcome === 'resolved' ? 'resolved' : 'ended') : 'in_progress';
  const caseStatus: CallTags['caseStatus'] = !c ? 'none' : handoff || c.status === 'awaiting_agent' ? 'escalated' : c.status === 'resolved' || c.status === 'closed' ? 'resolved' : c.status === 'pending' ? 'pending' : 'created';

  return {
    intent: issue,
    intentLabel: issue ? ISSUE_LABELS[issue] : 'Not yet identified',
    intentConfidence: ctx.issue?.confidence ?? null,
    secondaryIntents: secondary,
    category: issue ? CATEGORY[issue] : '—',
    urgency,
    urgencyReason,
    identity,
    sentiment: ctx.sentiment?.sentiment ?? 'neutral',
    sentimentBasis: ctx.sentiment?.basis ?? 'no caller words yet',
    outcome,
    caseStatus,
  };
}

/** Field-level differences, used to record how the classification evolved. */
export function diffTags(a: CallTags | null | undefined, b: CallTags): string[] {
  if (!a) return [];
  const keys: (keyof CallTags)[] = ['intent', 'urgency', 'identity', 'sentiment', 'outcome', 'caseStatus'];
  const out = keys.filter((k) => a[k] !== b[k]).map((k) => `${k}: ${String(a[k])} → ${String(b[k])}`);
  const sa = (a.secondaryIntents ?? []).map((x) => x.label).join(', ');
  const sb = b.secondaryIntents.map((x) => x.label).join(', ');
  if (sa !== sb) out.push(`secondary topics: ${sa || 'none'} → ${sb}`);
  return out;
}
