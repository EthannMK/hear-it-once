/**
 * SIDE TALK: the things callers say that are not an answer to the current question. Each one gets
 * a short, human reply that keeps the call on track instead of a blank "I didn't understand", and
 * none of them is ever acted on as a banking request. Pure functions, no database access.
 */
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
  if (SECRET_TALK.test(t)) {
    return { kind: 'secret', strike: false, alsoProcess: true, reply: "Please don't share your PIN, CVV or password with me. I will never ask for them. I only need what I ask for, one step at a time." };
  }
  if (!o.inIssueStage) return null;
  if (HELLO.test(t)) return { kind: 'hello', strike: true, reply: pick(["I'm here. What can I help you with today? For example a lost card, a charge you don't recognise, a payment or a fee.", "Still here. Tell me what's going on with your card or account, in your own words."]) };
  if (ABUSE.test(t)) return { kind: 'abuse', strike: true, reply: pick(["I'm sorry this has been frustrating. I do want to sort it out. Tell me in a few words what happened with your card or account, or I can bring in a colleague.", "I can hear how annoyed you are, and I'm sorry. Would it help if I brought in a colleague, or shall we try once more with what happened?"]) };
  const general = generalAnswer(t);
  if (general) return { kind: 'general', strike: false, reply: `${general} Is there anything on your own card or account I can help with?` };
  if (OFFTOPIC.test(t)) return { kind: 'offtopic', strike: true, reply: pick(["That's outside what I can help with. I look after card and banking questions. Is there something on your card or account I can help with?", "I'll stay with card and banking questions, so I can't help with that one either. Is there anything about your card or account?"]) };
  return null;
}
