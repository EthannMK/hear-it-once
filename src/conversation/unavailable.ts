/**
 * "I DON'T HAVE IT" — recognising a credential the caller cannot supply.
 *
 * Someone who has lost their card cannot read its number, and someone who has lost their phone
 * cannot receive a passcode. Asking again does not help them and is a poor experience, so the call
 * takes a different approved route instead: another check the bank allows, or a person.
 *
 * Nothing here weakens a check. It only decides that a particular credential is unavailable, so the
 * conversation can stop asking for it. Which alternative is allowed, and whether it is enough, is
 * decided by the verification policy and the verification service, not here.
 */

/** The caller says they cannot supply what was asked for. */
const UNAVAILABLE = [
  /\b(?:i )?(?:don'?t|do not|dont) have (?:it|the card|my card|them|that|the number|it on me|it with me|my phone|the phone)\b/i,
  /\b(?:i )?(?:don'?t|do not|dont) (?:know|remember|recall) (?:it|the number|my card number|that|the card number)\b/i,
  /\bi (?:can'?t|cannot|can not) (?:find|remember|read|see|access|get) (?:it|them|the card|my card|the number)\b/i,
  /\b(?:i )?(?:lost|misplaced|threw away) (?:it|the card|my card|my wallet|my phone|everything)\b/i,
  /\bit'?s? (?:gone|lost|stolen|missing|not here|with the card)\b/i,
  /\b(?:i )?(?:haven'?t|have not|don'?t have) (?:got|it) (?:it|the card|my card)? ?(?:on me|with me|here)\b/i,
  /\b(?:no|not) (?:idea|clue)\b/i,
  /\bi forgot (?:it|the number|my card number)\b/i,
  /\bi told you i lost\b/i,
  /\b(?:card|phone|wallet) (?:is|was|'s) (?:gone|lost|stolen|missing)\b/i,
  /\bi (?:don'?t|do not) have (?:access to )?(?:it|my phone|the phone)\b/i,
];

/** A bare "I don't know" / "no idea" answer, which is the same thing in fewer words. */
const BARE_UNKNOWN = /^(?:i |sorry,? ?i )?(?:don'?t|do not|dont) (?:know|remember|have (?:it|them))[\s.!]*$/i;

/** Losing the phone matters on its own: a passcode cannot reach a phone the caller no longer has. */
const LOST_PHONE = [
  /\bi (?:have )?(?:just )?lost (?:my|the) phone\b/i,
  /\bmy phone (?:is|was|has been|'s|got) (?:lost|stolen|gone|missing|taken)\b/i,
  /\b(?:lost|stolen) (?:my )?(?:phone|mobile|handset)\b/i,
  /\bphone (?:and|&) (?:my )?card\b/i,
  /\bcard (?:and|&) (?:my )?phone\b/i,
  /\bi (?:can'?t|cannot) (?:receive|get|access) (?:the |an |a )?(?:otp|code|passcode|text|sms|message)\b/i,
  /\b(?:no|not|don'?t have) (?:access to )?(?:my )?phone\b/i,
  /\b(?:don'?t|do not|didn'?t|did not) (?:have|get|receive) (?:the |a |an )?(?:otp|code|passcode|text)\b/i,
  /\bnew (?:phone )?number\b/i,
  /\bchanged my (?:phone )?number\b/i,
];

/** Losing the card, said as something that has happened (not "how do I replace a lost card"). */
const LOST_CARD = [
  /\bi (?:have )?(?:just )?lost (?:my|the) (?:card|wallet|purse)\b/i,
  /\bmy (?:card|wallet) (?:is|was|has been|'s|got) (?:lost|stolen|gone|missing|taken)\b/i,
  /\b(?:lost|stolen) (?:my )?(?:card|wallet)\b/i,
  /\bcard (?:was|got) (?:stolen|taken)\b/i,
  // "I lost my phone and card" names both in one breath; each is recorded.
  /\b(?:lost|stolen|missing)\b[\w\s,]{0,24}\b(?:phone|mobile)\b\s*(?:and|&|\+)\s*(?:my )?(?:card|wallet)\b/i,
  /\b(?:lost|stolen|missing)\b[\w\s,]{0,24}\b(?:card|wallet)\b\s*(?:and|&|\+)\s*(?:my )?(?:phone|mobile)\b/i,
];

export interface Unavailable {
  /** The caller said they cannot supply what was asked for. */
  credential: boolean;
  /** They no longer have the phone, so a passcode cannot reach them. */
  lostPhone: boolean;
  /** They no longer have the card, so its number cannot be read out. */
  lostCard: boolean;
}

/** Transcripts use curly apostrophes as often as straight ones; the patterns read either. */
const plain = (text: string) => text.replace(/[\u2018\u2019\u02bc\u2032]/g, "'").trim();

export function readUnavailable(text: string): Unavailable {
  const t = plain(text);
  return {
    credential: BARE_UNKNOWN.test(t) || UNAVAILABLE.some((re) => re.test(t)),
    lostPhone: LOST_PHONE.some((re) => re.test(t)),
    lostCard: LOST_CARD.some((re) => re.test(t)),
  };
}

/** True when the words are only about not having something, with no digits to work with. */
export function saysCredentialUnavailable(text: string): boolean {
  const u = readUnavailable(plain(text));
  if (!u.credential && !u.lostCard && !u.lostPhone) return false;
  // "It's 4999 0100…" with an apology attached is still an answer; digits win.
  return text.replace(/\D/g, '').length < 4;
}
