/**
 * ASSURANCE LEVELS AND SENSITIVE-REQUEST RULES.
 *
 *   basic   passed the call's normal identity check (card number, or date of birth + passcode).
 *   strong  basic, plus a second-level check in this call (last four digits of the national ID).
 *
 * What each level allows:
 *   basic   lost/stolen card block, card status, general help, and CHECKING a detail the customer
 *           describes against the records ("did I pay 50 dollars to Grab?" gets a yes or a no).
 *   strong  anything that reads account activity back to the customer or changes how the bank
 *           reaches them (address, phone, email). Even then, activity is read out only after the
 *           customer confirms it is safe to say it aloud, and a contact change is never applied by
 *           the assistant: it goes to a person for review.
 *
 * The rule behind all of it: the assistant takes what the customer says and matches it against the
 * records. It does not volunteer what the records hold.
 */
import { all, get } from '../db/db.ts';
import { safeEqual } from '../lib/ids.ts';
import { nationalIdLast4 } from '../adapters/mock/identity.ts';

export type Assurance = 'basic' | 'strong';
export type ContactKind = 'address' | 'phone' | 'email';

export const STEP_UP_MAX_ATTEMPTS = 3;

const KIND_WORDS = '(address|phone number|mobile number|mobile|phone|e-?mail)';
const CHANGE = '(chang\\w*|updat\\w*|edit\\w*|new|different|another|correct\\w*|replac\\w*|switch\\w*)';
const CONTACT_RE = new RegExp(`\\b${CHANGE}\\b.{0,30}\\b${KIND_WORDS}\\b|\\b${KIND_WORDS}\\b.{0,20}\\b(change|update|is wrong|has changed)\\b|\\bsend (it|them|the (new )?card|my card)\\b.{0,25}\\b(new|different|another|other) (address|place|home)\\b|\\bi('ve| have)? (just )?moved\\b|\\bmoved (house|home|out)\\b`, 'i');

/** Does this sound like a request to change how the bank contacts the customer or where it sends things? */
export function contactChangeKind(text: string): ContactKind | null {
  if (!CONTACT_RE.test(text)) return null;
  if (/\b(e-?mail)\b/i.test(text)) return 'email';
  if (/\b(phone|mobile)\b/i.test(text)) return 'phone';
  return 'address';
}

/** Asks the assistant to say account activity aloud rather than to check a detail the customer gave. */
export const READ_ALOUD = /\b(read|say|list|tell|give)\b.{0,20}\b(out|aloud|them|those|these|transactions?|purchases?|charges?|activity)\b|\bout loud\b|\baloud\b/i;

export const WANTS_READ_OUT = /\b(read|tell|list|give|show|say)\b.{0,25}\b(my |the |last |latest |recent |all )*(\w+ )?(transactions?|purchases?|charges?|activity|spending|statement|history)\b|\bwhat (were|are) my (last|latest|recent)\b|\bwhat (did|have) i (buy|bought|spend|spent|pay|paid)\b|\bwhat('s| is| was) (my )?(last|latest|recent)\b/i;

/** The last four digits of a national ID as spoken or typed. Longer digit runs use their final four. */
export function parseNationalIdLast4(text: string): string | null {
  const digits = text.replace(/\D/g, '');
  if (digits.length < 4 || digits.length > 14) return null;
  return digits.slice(-4);
}

export function checkNationalId(customerId: string, last4: string): boolean {
  return safeEqual(nationalIdLast4(customerId), last4);
}

export interface Risk {
  level: 'normal' | 'high';
  signals: string[];
}

/**
 * Reasoning for a contact-detail change. High risk means a person must look at it before anything
 * changes. These are the same patterns an account-takeover fraudster produces: report fraud or a
 * lost card, get the card blocked, then redirect the replacement to a new address.
 */
export function assessContactRisk(sessionId: string, caseId: string | null, flags: string[]): Risk {
  const signals: string[] = [];
  if (flags.includes('fraud_alert')) signals.push('an open fraud alert on the account');
  const issue = caseId ? get<{ issue_type: string | null }>('SELECT issue_type FROM cases WHERE id = ?', [caseId])?.issue_type : null;
  if (issue === 'unrecognised_transaction' || issue === 'lost_stolen_card') signals.push(issue === 'lost_stolen_card' ? 'a lost or stolen card was reported in this call' : 'an unrecognised charge was reported in this call');
  const ops = all<{ action_type: string; status: string }>("SELECT action_type, status FROM action_operations WHERE session_id = ? AND action_type IN ('block_card','order_replacement') AND status IN ('succeeded','submitted','unknown','pending')", [sessionId]);
  if (ops.some((o) => o.action_type === 'block_card')) signals.push('the card was blocked in this call');
  if (ops.some((o) => o.action_type === 'order_replacement')) signals.push('a replacement card was ordered in this call');
  return { level: signals.length ? 'high' : 'normal', signals };
}

/** The caller says they are calling for, or are related to, the account holder. */
export const THIRD_PARTY = /\b(i'?m|i am|this is)\b.{0,20}\b(his|her|their)\b.{0,14}\b(wife|husband|partner|son|daughter|mother|father|mum|mom|dad|assistant|friend|colleague|boss|brother|sister|accountant|lawyer)\b|\b(he|she|they) (asked|told|wants) me to\b|\bon behalf of\b|\bcalling (for|about) my (wife|husband|mother|father|friend|boss)\b/i;
