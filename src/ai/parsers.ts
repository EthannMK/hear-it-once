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

export function parseCustomerNumber(text: string): string | null {
  const m = text.replace(/(?<=\d)[\s-](?=\d)/g, '').match(/(?<!\d)(\d{8})(?!\d)/);
  return m ? m[1] : null;
}

export function parseLast4(text: string): string | null {
  const m = text.match(/\b(?:ending(?:\s+in)?|ends\s+in|last\s+(?:four|4)(?:\s+digits)?(?:\s+(?:are|is))?)\s*:?\s*(\d{4})\b/i);
  return m ? m[1] : null;
}

export type YesNo = 'yes' | 'no' | null;
export function parseYesNo(text: string): YesNo {
  const t = text.trim().toLowerCase().replace(/[.!]+$/, '');
  if (/^(no|nope|nah|don'?t|do not|not now|not yet|cancel|stop|never ?mind|i decline|decline|no thanks|no thank you)\b/.test(t)) return 'no';
  if (/^(yes|yeah|yep|yup|sure|ok|okay|please do|please|go ahead|do it|correct|that'?s right|that is right|confirm(ed)?|absolutely|y|i agree|agreed|i consent|block it|sounds good)\b/.test(t)) return 'yes';
  return null;
}

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
