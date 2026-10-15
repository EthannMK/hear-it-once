/**
 * Behavioural invariants that must hold in every conversation, however the customer wanders.
 * Each returns a list of violations. Security rules are about what the back end did, not what the
 * assistant said: verification events, handoff rows and operations are read from the database.
 */
import type { Trace } from './run.ts';
import type { Kind } from './library.ts';

export interface Violation { rule: string; turn: number; detail: string }

const SAFE_ONLY: Kind[] = ['faq', 'ack', 'wait', 'double', 'correct', 'cancel', 'lang', 'noise', 'dup'];
const PAN = /\b(?:\d[ -]?){15}\d\b/;
const PERSONAL_DATA = /\bNOVAPLAY\b|\bCITYLINK\b|\bEuroRail\b|\bMetro Fuel\b|\$\s?249\b|\$\s?84\.50|\$\s?189\b|\$\s?76\b|\$\s?29\b/i;

export function check(t: Trace): Violation[] {
  const v: Violation[] = [];
  const kinds = t.actions.map((a) => a.kind);
  const safeOnly = kinds.every((k) => SAFE_ONLY.includes(k));
  const anyFlow = (i: number, ks: Kind[]) => kinds.slice(0, i + 1).some((k) => ks.includes(k));

  t.turns.forEach((turn, i) => {
    // 1 and 2. No invented intent: verification starts only after the caller asked for something personal or gave a card.
    if (turn.verificationStarts > 0 && !anyFlow(i, ['personal', 'card', 'inject'])) v.push({ rule: 'unnecessary-verification', turn: i, detail: `verification started after only ${kinds.slice(0, i + 1).join(', ')}` });
    // 3. Premature escalation: a transfer needs a request for a person, an accepted offer, a failed check or a risk reason.
    if (turn.handoffRows > 0 && safeOnly) v.push({ rule: 'premature-escalation', turn: i, detail: `transferred during safe-only conversation (${kinds.join(', ')})` });
    if (turn.handoffRows > 0 && !anyFlow(i, ['human', 'unclear', 'personal', 'card', 'inject', 'offtopic'])) v.push({ rule: 'premature-escalation', turn: i, detail: 'transfer without a reason' });
    // 4. Every customer turn gets a reply, and not a pile of them.
    const n = turn.newReplies.length;
    // While queued for an agent the assistant answers at most every few seconds, so silence is allowed then.
    const queued = i > 0 && t.turns[i - 1].handoffRows > 0;
    // After the goodbye the call has ended, so no further reply is expected.
    const ended = t.turns.slice(0, i).some((x) => x.newReplies.some((r) => /Take care\.$/.test(r)));
    // An identical repeat of the previous sentence is treated as a duplicate transcript event and ignored on purpose.
    const repeatOfPrevious = i > 0 && t.turns[i - 1].action.text === turn.action.text;
    if (turn.action.kind !== 'noise' && !queued && !ended && !repeatOfPrevious && n < 1) v.push({ rule: 'no-reply', turn: i, detail: `"${turn.action.text}" got no reply` });
    if (n > 4) v.push({ rule: 'too-many-replies', turn: i, detail: `${n} messages for one turn` });
    if (turn.newReplies.includes('__DUPLICATE_EVENT_PRODUCED_OUTPUT__')) v.push({ rule: 'duplicate-event', turn: i, detail: 'the same event delivered twice produced output twice' });
    // 5. An operation runs only for a verified caller who agreed to a specific proposal.
    if (turn.operations > 0 && !(t.verified && t.timeline.some((e) => e.type === 'consent.given'))) v.push({ rule: 'unauthorised-operation', turn: i, detail: `${turn.operations} operation(s) ran without verification and consent` });
    // 6. Never the same message twice in one turn.
    const seen = new Set<string>();
    for (const r of turn.newReplies) { if (seen.has(r)) v.push({ rule: 'duplicate-message', turn: i, detail: r.slice(0, 80) }); seen.add(r); }
  });

  // 7. Never the same assistant line twice in a row across turns (repeating the same question).
  const said = t.transcript.filter((x) => x.speaker === 'assistant').map((x) => x.text);
  for (let i = 1; i < said.length; i++) // A repeated general answer is right when the customer asked the same thing again.
    if (said[i] === said[i - 1] && said[i].length > 40 && !/anything else you would like to know|carry on with the check/i.test(said[i])) v.push({ rule: 'repeated-message', turn: -1, detail: said[i].slice(0, 80) });

  // 8. Sensitive data never appears in the transcript.
  for (const x of t.transcript) if (PAN.test(x.text) && x.speaker !== 'system') v.push({ rule: 'card-in-transcript', turn: -1, detail: `${x.speaker}: ${x.text.slice(0, 60)}` });

  // 9. Nothing personal is spoken to a caller who is not verified.
  if (!t.verified) for (const x of t.transcript) if (x.speaker === 'assistant' && PERSONAL_DATA.test(x.text)) v.push({ rule: 'data-before-verification', turn: -1, detail: x.text.slice(0, 80) });

  // 10 and 11. One transfer per call. Queue facts only when the back end confirmed them.
  if (t.handoffs.length > 1) v.push({ rule: 'duplicate-handoff', turn: -1, detail: `${t.handoffs.length} handoff rows` });
  const queueClaims = t.transcript.filter((x) => x.speaker !== 'customer' && /\bnumber \d+ in the queue\b/i.test(x.text));
  if (queueClaims.length > Math.max(1, t.handoffs.length)) v.push({ rule: 'duplicate-handoff-message', turn: -1, detail: `${queueClaims.length} queue messages` });
  if (queueClaims.length && !t.handoffs.some((h) => h.status === 'queued' || h.status === 'connected')) v.push({ rule: 'unconfirmed-queue-claim', turn: -1, detail: queueClaims[0].text.slice(0, 80) });
  const transferClaims = t.transcript.filter((x) => x.speaker !== 'customer' && /\bI'?ll transfer you now\b|\bI'?m transferring you\b/i.test(x.text));
  if (transferClaims.length && !t.handoffs.length) v.push({ rule: 'transfer-claim-without-handoff', turn: -1, detail: transferClaims[0].text.slice(0, 80) });

  // 12. A general-only call asks for no card number.
  if (safeOnly) for (const x of t.transcript) if (x.speaker === 'assistant' && /16-digit card number/i.test(x.text)) v.push({ rule: 'card-number-requested-for-faq', turn: -1, detail: x.text.slice(0, 80) });

  // 13. Verification opens one case and queries the bank systems once. Later turns do not repeat that work.
  const count = (type: string) => t.timeline.filter((e) => e.type === type).length;
  if (count('verification.started') > 1) v.push({ rule: 'repeated-verification', turn: -1, detail: `${count('verification.started')} verification starts` });
  const personalTurns = kinds.filter((k) => k === 'personal').length;
  if (count('systems.queried') > 1 + personalTurns) v.push({ rule: 'repeated-system-queries', turn: -1, detail: `${count('systems.queried')} system query rounds` });
  if (count('case.created') > 1) v.push({ rule: 'duplicate-case', turn: -1, detail: `${count('case.created')} cases created` });
  return v;
}
