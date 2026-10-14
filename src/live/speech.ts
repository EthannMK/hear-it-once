/**
 * Normalises SPOKEN forms of numbers and dates into the written forms the deterministic parsers
 * expect ("four eight two nine one three" → "482913", "April twelfth nineteen eighty six" →
 * "April 12 1986"). Speech recognisers usually already write digits; this is the safety net. It
 * only rewrites unambiguous patterns and never invents digits.
 */
const DIGITS: Record<string, string> = { zero: '0', oh: '0', o: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };
const TEENS: Record<string, number> = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const ONES: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const ORD: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14,
  fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30,
};
const MONTH = 'january|february|march|april|may|june|july|august|september|october|november|december';

function twoDigit(words: string[]): number | null {
  if (words.length === 1) {
    const w = words[0];
    if (w in TEENS) return TEENS[w];
    if (w in TENS) return TENS[w];
    if (w in ONES) return ONES[w];
    return null;
  }
  if (words.length === 2 && words[0] in TENS && words[1] in ONES) return TENS[words[0]] + ONES[words[1]];
  return null;
}

/** "nineteen eighty six" → 1986, "nineteen oh five" → 1905, "two thousand five" → 2005. */
function spokenYear(words: string[]): number | null {
  if (words[0] === 'two' && words[1] === 'thousand') {
    if (words.length === 2) return 2000;
    const rest = twoDigit(words.slice(2));
    return rest != null && rest < 100 ? 2000 + rest : null;
  }
  const hi = twoDigit(words.slice(0, 1));
  if (hi == null || hi < 19 || hi > 20) return null;
  const tail = words.slice(1);
  if (tail.length === 2 && (tail[0] === 'oh' || tail[0] === 'zero') && tail[1] in ONES) return hi * 100 + ONES[tail[1]];
  const lo = twoDigit(tail);
  return lo != null ? hi * 100 + lo : null;
}

export function normaliseSpoken(input: string): string {
  let t = input.replace(/\s+/g, ' ').trim();
  const low = t.toLowerCase();

  // Dates: "<month> <ordinal|cardinal day> <spoken year>"
  const re = new RegExp(`\\b(${MONTH})\\s+(?:the\\s+)?([a-z-]+(?:\\s[a-z]+)?)(?:\\s+of)?\\s+((?:nineteen|twenty|two thousand)(?:\\s[a-z-]+){0,3})\\b`, 'i');
  const m = low.match(re);
  if (m) {
    const dayWords = m[2].split(/[\s-]+/);
    let day: number | null = dayWords.length === 1 && dayWords[0] in ORD ? ORD[dayWords[0]] : null;
    if (day == null && dayWords.length === 2 && dayWords[0] in TENS && dayWords[1] in ORD) day = TENS[dayWords[0]] + ORD[dayWords[1]];
    if (day == null) day = twoDigit(dayWords);
    const year = spokenYear(m[3].split(/[\s-]+/));
    if (day != null && year != null) t = `${t.slice(0, m.index)}${m[1]} ${day} ${year}${t.slice((m.index ?? 0) + m[0].length)}`;
  }

  // Day first: "the twenty first of March two thousand five"
  const re2 = new RegExp(`\\b(?:the\\s+)?([a-z-]+(?:\\s[a-z]+)?)\\s+(?:of\\s+)?(${MONTH})\\s+((?:nineteen|twenty|two thousand)(?:\\s[a-z-]+){0,3})\\b`, 'i');
  const m2 = t.toLowerCase().match(re2);
  if (m2) {
    const dayWords = m2[1].split(/[\s-]+/);
    let day: number | null = dayWords.length === 1 && dayWords[0] in ORD ? ORD[dayWords[0]] : null;
    if (day == null && dayWords.length === 2 && dayWords[0] in TENS && dayWords[1] in ORD) day = TENS[dayWords[0]] + ORD[dayWords[1]];
    const year = spokenYear(m2[3].split(/[\s-]+/));
    if (day != null && year != null) t = `${t.slice(0, m2.index)}${m2[2]} ${day} ${year}${t.slice((m2.index ?? 0) + m2[0].length)}`;
  }

  // Runs of spoken digits (passcodes, customer numbers): only when 4 or more in a row.
  const words = t.split(' ');
  const out: string[] = [];
  for (let i = 0; i < words.length; ) {
    let j = i;
    let run = '';
    while (j < words.length) {
      const w = words[j].toLowerCase().replace(/[.,!?]/g, '');
      if (/^\d$/.test(w)) run += w;
      else if (w in DIGITS && w !== 'o') run += DIGITS[w];
      else break;
      j++;
    }
    if (j - i >= 4) {
      out.push(run);
      i = j;
    } else {
      out.push(words[i]);
      i++;
    }
  }
  return out.join(' ');
}
