/**
 * Deterministic parsers for caller utterances: amounts, dates, verification answers,
 * yes/no, choices and corrections. Caller text is UNTRUSTED data: it is parsed, never
 * executed or forwarded as instructions.
 */
import { nowMs } from '../lib/clock.ts';

export interface DateRange {
  from: string; // ISO date (YYYY-MM-DD) inclusive
  to: string;
  label: string;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(nowMs() - n * 86_400_000);

function validYmd(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return isoDate(dt);
}

/** Amount in minor units. Requires a currency cue ($, dollars, bucks, decimals) or "for N". */
export function parseAmount(text: string): number | null {
  const t = text.replace(/,(?=\d{3}\b)/g, '');
  const patterns = [
    /\$\s?(\d+(?:\.\d{1,2})?)/,
    /\b(\d+(?:\.\d{1,2})?)\s*(?:dollars|usd|bucks)\b/i,
    /\b(\d+\.\d{2})\b/,
    /\b(?:for|of|charged|paid)\s+(\d{1,6})(?!\s*(?:days?|weeks?|months?|years?|times?|th|st|nd|rd|:|\/|-|\d))\b/i,
  ];
  for (const p of patterns) {
    const m = t.match(p);
    if (m) {
      const v = Math.round(parseFloat(m[1]) * 100);
      if (v > 0 && v < 10_000_000) return v;
    }
  }
  return null;
}

/** Relative or absolute transaction dates → a search window. */
export function parseDateRange(text: string): DateRange | null {
  const t = text.toLowerCase();
  if (/\btoday\b/.test(t)) return { from: isoDate(daysAgo(0)), to: isoDate(daysAgo(0)), label: 'today' };
  if (/\byesterday\b/.test(t)) return { from: isoDate(daysAgo(1)), to: isoDate(daysAgo(1)), label: 'yesterday' };
  let m = t.match(/\b(\d{1,2}|a|one|two|three|four|five|six|seven)\s+days?\s+ago\b/);
  if (m) {
    const words: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
    const n = words[m[1]] ?? Number(m[1]);
    return { from: isoDate(daysAgo(n + 1)), to: isoDate(daysAgo(Math.max(0, n - 1))), label: `${n} days ago` };
  }
  if (/\b(last|this past) week\b/.test(t)) return { from: isoDate(daysAgo(10)), to: isoDate(daysAgo(0)), label: 'last week' };
  if (/\b(this|earlier this) week\b/.test(t)) return { from: isoDate(daysAgo(7)), to: isoDate(daysAgo(0)), label: 'this week' };
  if (/\blast month\b/.test(t)) return { from: isoDate(daysAgo(45)), to: isoDate(daysAgo(0)), label: 'last month' };
  const abs = parseCalendarDate(text, { assumeRecent: true });
  if (abs) return { from: abs, to: abs, label: abs };
  return null;
}

/**
 * Calendar date. Supports YYYY-MM-DD, MM/DD/YYYY (US convention), "April 12 1986",
 * "12 April 1986". With assumeRecent, a date without a year is the most recent past one.
 */
export function parseCalendarDate(text: string, opts: { assumeRecent?: boolean } = {}): string | null {
  let m = text.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) return validYmd(+m[1], +m[2], +m[3]);
  m = text.match(/\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/);
  if (m) return validYmd(+m[3], +m[1], +m[2]);
  const monthNames = Object.keys(MONTHS).join('|');
  m = text.match(new RegExp(`\\b(${monthNames})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,)?(?:\\s+(\\d{4}))?\\b`, 'i'));
  if (m) return withYear(m[3], MONTHS[m[1].toLowerCase()], +m[2], opts);
  m = text.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${monthNames})\\.?(?:,)?(?:\\s+(\\d{4}))?\\b`, 'i'));
  if (m) return withYear(m[3], MONTHS[m[2].toLowerCase()], +m[1], opts);
  if (opts.assumeRecent) {
    m = text.match(/\b(\d{1,2})\/(\d{1,2})\b(?!\/)/);
    if (m) return withYear(undefined, +m[1], +m[2], opts);
  }
  return null;
}

function withYear(y: string | undefined, month: number, day: number, opts: { assumeRecent?: boolean }): string | null {
  if (y) return validYmd(+y, month, day);
  if (!opts.assumeRecent) return null;
  const now = new Date(nowMs());
  let year = now.getUTCFullYear();
  const candidate = validYmd(year, month, day);
  if (candidate && candidate > isoDate(now)) year -= 1;
  return validYmd(year, month, day);
}

/** Date of birth for verification (must include a year). */
export function parseDob(text: string): string | null {
  return parseCalendarDate(text, { assumeRecent: false });
}

/** One-time passcode: exactly N digits, possibly spaced ("4 8 2 9 1 3"). */
export function parseOtp(text: string, length = 6): string | null {
  const compact = text.replace(/(?<=\d)[\s-](?=\d)/g, '');
  const m = compact.match(new RegExp(`(?<!\\d)(\\d{${length}})(?!\\d)`));
  return m ? m[1] : null;
}

/**
 * Card number as spoken or typed: digits possibly grouped by spaces or dashes. Returns the digits
 * when there are at least 10 of them (so a wrong or short number counts as an attempt), or null
 * when too little was captured to treat as an answer at all.
 */
export function parseCardNumber(text: string): string | null {
  const digits = text.replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 19 ? digits : null;
}

export function parseCustomerNumber(text: string): string | null {
  const m = text.replace(/(?<=\d)[\s-](?=\d)/g, '').match(/(?<!\d)(\d{8})(?!\d)/);
  return m ? m[1] : null;
}

export function parseLast4(text: string): string | null {
  const m = text.match(/\b(?:ending(?:\s+in)?|ends\s+in|last\s+(?:four|4)(?:\s+digits)?(?:\s+(?:are|is))?)\s*:?\s*(\d{4})\b/i);
  return m ? m[1] : null;
}

export type YesNo = 'yes' | 'no' | null;
/** The caller is saying they have not started yet, or asks for a moment to speak. Never a yes or a no. */
export const LET_ME_TALK = /\b(haven'?t|have not|hasn'?t|did ?n'?t|didn'?t)\s+(said|say|spoken|talked|started|told)\b|\blet me (start|talk|speak|say|explain|finish|tell)\b|\b(wait|hold on|one (moment|second|sec)|give me a (moment|second|sec|minute)|just a (moment|second|sec|minute)|i'?m (about|going) to)\b|\bi (was|am) (about|going) to\b|\bdon'?t (interrupt|cut me)\b|\bstop talking\b/i;

/**
 * Courtesy that carries no answer: "yes please", "none, thank you", "oo po". Stripped before the
 * answer is read, so the polite form of an answer is understood as readily as the bare word.
 */
const COURTESY = /[\s,]*\b(please|thanks|thank you|thank you so much|thanks a lot|po|na po|ho|sir|ma'?am|miss)\b[\s.,!]*$/i;
/** "That is everything", said in the many ways callers say it, is a no to "anything else?". */
const NOTHING_MORE = /^(none|nothing|nothing else|nothing more|that'?s (all|it|everything)|that is (all|it|everything)|i'?m (all )?(done|good|set)|we'?re (done|good|all set)|all (good|set|done)|no more|not (right now|at the moment|for now))\b/;
/** Clear affirmatives, including the ones callers use in Tagalog and Burmese on a mixed-language call. */
const AFFIRM = /^(yes|yeah|yep|yup|ya|sure|ok|okay|please do|please|go ahead|go on|carry on|continue|proceed|proceed please|do it|correct|that'?s (right|correct)|that is (right|correct)|right that'?s it|confirm(ed)?|confirm it|absolutely|definitely|of course|affirmative|y|i agree|agreed|i consent|block it|sounds good|oo|uu|oo po|opo|sige|tama|tama po|oo nga|ho?pe?ly)\b|^(ဟုတ်|ဟုတ်ကဲ့|ရပါတယ်|လုပ်ပါ)/;
/** Clear negatives, same idea. "Hindi" is Tagalog for no; it is only read that way on its own. */
const DENY = /^(no|nope|nah|don'?t|do not|not now|not yet|cancel|stop|never ?mind|i decline|decline|negative|no thanks|no thank you|hindi|hindi po|ayaw|wag|huwag)\b|^(မဟုတ်|မလုပ်ပါနဲ့|မလိုပါ)/;

/**
 * Read a caller's answer to a yes/no question. Politeness, a trailing courtesy word and the common
 * ways of saying "that is everything" are all understood; anything genuinely unclear returns null so
 * the caller is asked again rather than acted upon.
 */
/**
 * Words that mean yes only in answer to a question. On their own they are usually the caller
 * thinking aloud ("right..., so what happened was"), which is why they are not in AFFIRM. They
 * count where a yes/no question is on the table and the answer is not a consent to act.
 */
const SOFT_AFFIRM = /^(right|that'?s? right|alright|all right|aye|mm ?hmm|uh ?huh|exactly|indeed|spot on)\b/;

/**
 * Read a caller's answer to a yes/no question. `answeringPrompt` is set where the back end has just
 * asked one and the answer only confirms what was read back; it is never set for consent to an
 * action or for the offer of a person, where a deliberate yes is the point.
 */
export function parseYesNo(text: string, opts: { answeringPrompt?: boolean } = {}): YesNo {
  if (LET_ME_TALK.test(text)) return null;
  let t = text.trim().toLowerCase().replace(/[.!]+$/, '');
  for (let i = 0; i < 3 && COURTESY.test(t); i++) t = t.replace(COURTESY, '').trim();
  if (!t) return null;
  if (NOTHING_MORE.test(t) || DENY.test(t)) return 'no';
  if (AFFIRM.test(t)) return 'yes';
  if (opts.answeringPrompt && SOFT_AFFIRM.test(t)) return 'yes';
  return null;
}

/** The caller is closing the call ("that's all, bye", "goodbye", "salamat, bye"). */
/**
 * The customer saying they are finished and happy. Separate from FAREWELL because people end a call
 * by saying the problem is solved rather than by saying goodbye, and a call that is over should be
 * closed rather than kept open on "anything else?" until the unanswered-question count sends it to
 * a person. Deliberately narrow: it needs a complete statement, not the word "good" in passing.
 */
export const RESOLVED = /^(?:ok(?:ay)?|alright|right|yes|yeah|yep|great|perfect|lovely|cool|thanks?|thank you|cheers)?[\s,.!-]*\b(?:that (?:is|'?s) (?:all|it|everything|fine|great|perfect|sorted|lovely)|all (?:good|sorted|set|done)|we(?:'?re| are) (?:good|done|sorted)|i(?:'?m| am) (?:good|done|all set|happy|satisfied)|no(?:thing)? else|nothing more|that (?:is|'?s) (?:solved|resolved)|it'?s (?:solved|resolved|sorted|fixed)|problem solved|issue (?:is )?(?:solved|resolved|fixed)|you'?ve (?:solved|sorted|fixed) it|happy with that|that answers (?:it|my question))\b[\s.!,]*(?:thanks?|thank you|cheers)?[\s.!,]*$/i;

export const FAREWELL = /\b(good ?bye|bye bye|bye for now|bye now|bye|see you|talk to you later|have a (good|great|nice) (day|evening|night)|that'?s all for now)\b[\s.!,]*$/i;

export function isCorrection(text: string): boolean {
  return /^\s*(no,?\s+)?(actually|sorry|i meant|correction|wait|oops|my mistake|not \$?\d)/i.test(text);
}

export function parseOrdinalChoice(text: string, count: number): number | null {
  const t = text.toLowerCase();
  // Ordinals first ("the second one" must not match "one").
  const words: [RegExp, number][] = [
    [/\b(first|1st|number 1|#1)\b/, 0],
    [/\b(second|2nd|number 2|#2)\b/, 1],
    [/\b(third|3rd|number 3|#3)\b/, 2],
    [/\b(fourth|4th|number 4|#4)\b/, 3],
    [/^\s*(the )?one\s*$/, 0],
    [/^\s*(the )?two\s*$/, 1],
    [/^\s*(the )?three\s*$/, 2],
    [/^\s*(the )?four\s*$/, 3],
  ];
  const bare = t.trim().match(/^(\d)$/);
  if (bare) {
    const i = Number(bare[1]) - 1;
    return i >= 0 && i < count ? i : null;
  }
  for (const [re, i] of words) if (re.test(t) && i < count) return i;
  return null;
}

export const normaliseMerchant = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
