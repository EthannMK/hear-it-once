/**
 * SIDE TALK: the things callers say that are not an answer to the current question. Each one gets
 * a short, human reply that keeps the call on track instead of a blank "I didn't understand", and
 * none of them is ever acted on as a banking request. Pure functions, no database access.
 */
import { LET_ME_TALK } from '../ai/parsers.ts';
import type { Facts } from './facts.ts';

export type SideKind = 'injection' | 'secret' | 'repeat' | 'recall' | 'hello' | 'abuse' | 'offtopic' | 'general';
export interface Side {
  kind: SideKind;
  /** The reply is said first and the message is then processed as normal (nothing in it is dropped). */
  alsoProcess?: boolean;
  reply: string;
  /** Counts toward the "not getting anywhere" limit that eventually offers a person. */
  strike: boolean;
}

const ABUSE = /\b(useless|stupid|idiot|moron|rubbish|garbage|trash|worst|terrible|awful|pathetic|hate (this|you|it)|sucks?|shut up|damn|crap)\b/i;
const OFFTOPIC = /\b(weather|joke|funny|football|soccer|basketball|cricket|movie|film|recipe|horoscope|poem|song|sing|capital of|who (won|is the president)|news|politic\w*|bitcoin|crypto|stock tip|lottery|translate|homework|girlfriend|boyfriend|meaning of life)\b/i;
const HELLO = /^\s*(hi+|hello+|hey+|hiya|good (morning|afternoon|evening)|are you (there|still there)|anyone (there|here)|hello\?+|yo|test(ing)?)\W*$/i;
const REPEAT = /\b(repeat (that|it|the question)|say (that|it) again|come again|pardon|sorry\??,? (what|can you)|(didn'?t|did not|couldn'?t) (catch|hear|get) (that|it|you)|what (was|did you say) that|what was the question)\b/i;
const RECALL = /\b(what (did|have) i (just )?(say|said|tell|told)|what (do|did) you (have|know|get)|remind me what i (said|told))\b/i;
const SECRET_TALK = /\b(my|the)\s+(pin|cvv2?|cvc2?|password|passcode)\b|\bREDACTED-(SECRET|CVV)\b/i;
const MAKE_THE_BANK_SPEAK = /\b(ignore|disregard|forget)\b.{0,30}\b(instructions?|rules?|prompt)\b|\b(system prompt|developer mode|jailbreak|reveal your (prompt|instructions))\b/i;

const LANGUAGE_ASK = /\b(speak|talk|reply|answer|switch|change|continue)\b.{0,24}\b(english|burmese|tagalog|filipino|myanmar)\b|\b(english|burmese|tagalog) (please|only)\b/i;
/** A bare acknowledgement ("OK", "right", "mm-hmm") carries no request, so it must never start a workflow. */
const ACK = /^\s*(ok(ay)?|alright|all right|right|sure|yes|yeah|yep|yup|mm+(-| )?hm+|uh[- ]?huh|hmm+|um+|uh+|well|so|good|fine|thanks|thank you|cool|got it)[\s.,!?]*$/i;
const CONFUSED = /\b(what does (it|that|this) mean|what do you mean|i (don'?t|do not) (understand|get it)|not sure what you mean|confused)\b/i;
/** A lost item that is not a card: ask whether the card is affected before touching anything. */
const LOST_OTHER = /\b(lost|stolen|missing|misplaced|forgot)\b.{0,25}\b(phone|mobile|wallet|laptop|bag|passport|keys)\b|\b(phone|mobile|wallet|laptop|bag|passport|keys)\b.{0,25}\b(lost|stolen|missing|misplaced)\b/i;

/** Short, general explanations. They never describe Northstar's own terms or this customer's account. */
const GENERAL: { re: RegExp; answer: string }[] = [
  { re: /\b(apr|annual percentage rate)\b/i, answer: "In general, APR is the yearly cost of borrowing on a card, shown as a percentage. Northstar's own rates and terms can differ, so I can't quote them here. A colleague can go through your exact rate." },
  { re: /\bchargebacks?\b/i, answer: "In general, a chargeback is when a card issuer takes a payment back from a merchant after the cardholder disputes it. It usually follows a dispute and a review. I can help you start a dispute once I have verified you." },
  { re: /\b(spot|avoid|recogni[sz]e|prevent|protect.{0,15}from)\b.{0,20}\b(scams?|fraud|phishing)\b|\b(scams?|phishing)\b/i, answer: "In general, be careful with anyone who rushes you, asks for your PIN, full card number or a code sent to you, or asks you to move money to a safe account. A real bank will never ask for those. If you are unsure, hang up and call the number on the back of your card." },
  { re: /\b(how|what).{0,20}\b(dispute|disputes)\b/i, answer: "In general, a dispute is a request to review a charge you believe is wrong or not yours. The bank checks the details with the merchant and can give a temporary credit while it looks into it. I can help you start one after I verify you." },
  { re: /\b(minimum payment|credit limit|credit score|interest)\b/i, answer: "That depends on your own account terms, which I can't quote in general terms. A colleague can go through them with you." },
];

export function generalAnswer(text: string): string | null {
  if (!/\b(what|how|why|explain|tell me|difference|mean|means)\b/i.test(text) && !/\?$/.test(text.trim())) return null;
  return GENERAL.find((g) => g.re.test(text))?.answer ?? null;
}

interface Opts {
  /** Which stage the call is in; small talk and insults are only handled while the issue is still being found. */
  inIssueStage: boolean;
  /** The caller is giving a security answer (card digits, code, date of birth): never treat that as side talk. */
  sensitive: boolean;
  lastPrompt: string;
  facts: Facts | undefined;
  /** How many unhelpful turns so far; picks a different wording each time. */
  strikes: number;
  /** A yes or no is being waited for (for example the offer of a person), so "yes" is an answer and not an acknowledgement. */
  awaitingYesNo?: boolean;
}

export function sideTalk(text: string, o: Opts): Side | null {
  const t = text.trim();
  if (!t) return null;
  const pick = (a: string[]) => a[Math.min(o.strikes, a.length - 1)];
  if (MAKE_THE_BANK_SPEAK.test(t)) {
    return { kind: 'injection', strike: false, alsoProcess: true, reply: "I can't do that, and I can't share how I work or any account details. I can help with lost or stolen cards, charges you don't recognise, payments and fees. What's happening with your card?" };
  }
  if (REPEAT.test(t) && o.lastPrompt) return { kind: 'repeat', strike: false, reply: `Of course. ${o.lastPrompt}` };
  if (RECALL.test(t)) {
    const bits: string[] = [];
    const f = o.facts ?? {};
    if (f.issue?.value) bits.push(`you told me ${f.issue.value.replace(/^["“]|["”]$/g, '').slice(0, 140)}`);
    if (f.amount?.value) bits.push(`the amount was ${f.amount.value}`);
    if (f.merchant?.value) bits.push(`the merchant was ${f.merchant.value}`);
    if (f.date?.value) bits.push(`the date was ${f.date.value}`);
    const said = bits.length ? `So far ${bits.join(', ')}.` : "We've only just started, so I don't have details yet.";
    return { kind: 'recall', strike: false, reply: `${said} ${o.lastPrompt}`.trim() };
  }
  if (o.sensitive) return null;
  // Sharing a secret is different from asking how to reset one. Only warn when a value seems to be given.
  const asksHow = /^(how|what|where|can i|can you|do i|is there)\b/i.test(t) && !/\d{3,}|REDACTED/i.test(t);
  if (SECRET_TALK.test(t) && !asksHow) {
    return { kind: 'secret', strike: false, alsoProcess: true, reply: "Please don't share your PIN, CVV or password with me. I will never ask for them. I only need what I ask for, one step at a time." };
  }
  if (!o.inIssueStage) return null;
  // Never say the same invitation twice in a row.
  const fresh = (a: string[]) => a.find((x) => x !== o.lastPrompt) ?? a[a.length - 1];
  if (LANGUAGE_ASK.test(t)) return { kind: 'general', strike: false, reply: /english/i.test(t) ? 'Of course, we can carry on in English. What can I help you with?' : fresh(["I'm Lily and I speak English. If you'd like to speak Burmese or Tagalog, say so and I'll bring in Hnin or Maya. What can I help you with?", 'Hnin speaks Burmese and Maya speaks Tagalog. Just start speaking in that language and I will bring them in. What can I help you with?']) };
  if (CONFUSED.test(t)) return { kind: 'general', strike: false, reply: 'Sorry, let me say it more simply. Tell me what happened in your own words, for example "I lost my card", "there is a charge I don\'t know", "I want to make a deposit" or "where is your nearest branch".' };
  if (LOST_OTHER.test(t) && !/\bcard\b/i.test(t)) return { kind: 'general', strike: false, reply: "I'm sorry to hear that. Is your Northstar card affected too? If so, say \"my card is lost\" and I'll block it right away. If it was only the phone or something else, tell me what you need from the bank." };
  // Nothing but punctuation or symbols: the words were not captured. Say so politely instead of guessing an intent.
  if (!/[\p{L}\p{N}]/u.test(t) || /^[\p{P}\p{S}\s]+$/u.test(t)) return { kind: 'general', strike: false, reply: fresh(["I didn't catch that. Could you say it again?", "I'm still here. Take your time, I'm listening."]) };
  if (/^\s*(never ?mind|forget it|actually,? forget it|cancel( that)?|scratch that|ignore that)[\s.,!?]*$/i.test(t) && !o.awaitingYesNo) return { kind: 'general', strike: false, reply: fresh(["No problem. I'm here whenever you need something.", 'Okay, nothing to do for now. Tell me if you think of anything.']) };
  if (LET_ME_TALK.test(t)) return { kind: 'general', strike: false, reply: fresh(["Of course, go ahead. I'm listening.", 'Take your time. I am here whenever you are ready.', 'No rush. Tell me in your own words when you are ready.']) };
  if (ACK.test(t) && !o.awaitingYesNo) return { kind: 'general', strike: false, reply: fresh(['Take your time. What can I help you with today?', 'I am here whenever you are ready. Just tell me what you need.', 'Go ahead, I am listening.']) };
  if (HELLO.test(t)) return { kind: 'hello', strike: true, reply: pick(["I'm here. What can I help you with today? For example a lost card, a charge you don't recognise, a payment or a fee.", "Still here. Tell me what's going on with your card or account, in your own words."]) };
  if (ABUSE.test(t)) return { kind: 'abuse', strike: true, reply: pick(["I'm sorry this has been frustrating. I do want to sort it out. Tell me in a few words what happened with your card or account, or I can bring in a colleague.", "I can hear how annoyed you are, and I'm sorry. Would it help if I brought in a colleague, or shall we try once more with what happened?"]) };
  const general = generalAnswer(t);
  if (general) return { kind: 'general', strike: false, reply: `${general} Is there anything on your own card or account I can help with?` };
  if (OFFTOPIC.test(t)) return { kind: 'offtopic', strike: true, reply: pick(["That's outside what I can help with. I look after card and banking questions. Is there something on your card or account I can help with?", "I'll stay with card and banking questions, so I can't help with that one either. Is there anything about your card or account?"]) };
  return null;
}
