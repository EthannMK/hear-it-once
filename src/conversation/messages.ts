/** Customer-facing message templates. Plain language; every claim is filled from persisted data. */
import type { Operation } from '../actions/action-service.ts';
import { formatDateTime, formatMoney, ISSUE_LABELS } from './format.ts';
import { get } from '../db/db.ts';

export const GREETING_NOTICE =
  'This call may be recorded and transcribed for quality, security and training. Your information is handled under our privacy notice.';

export const GREETING =
  "Thanks for calling Northstar Bank. I'm Lily, an AI assistant. You can ask for a person at any time. How can I help today?";

export const CLARIFY_ISSUE = "I want to be sure I help with the right thing. Is it a lost or stolen card, a charge you don't recognise, a duplicate or wrong charge, a payment that isn't showing, a fee, or a declined card?";
export const CLARIFY_AGAIN = 'I still want to get this right. In a few words, what happened with your card or account?';

export const ISSUE_CHOICES = [
  { id: 'unrecognised_transaction', label: "A charge I don't recognise" },
  { id: 'lost_stolen_card', label: 'My card is lost or stolen' },
  { id: 'wrong_or_duplicate_charge', label: 'A duplicate or wrong charge' },
  { id: 'payment_not_showing', label: "A payment that isn't showing" },
  { id: 'fee_query', label: 'A fee on my account' },
  { id: 'card_declined', label: 'My card was declined' },
  { id: 'other', label: 'Something else' },
];

const ISSUE_PHRASES: Record<string, string> = {
  unrecognised_transaction: "a charge you don't recognise",
  lost_stolen_card: 'a lost or stolen card',
  wrong_or_duplicate_charge: 'a duplicate or wrong charge',
  payment_not_showing: "a payment that isn't showing",
  fee_query: 'a fee on your account',
  card_declined: 'a declined card payment',
  account_inquiry: 'your account information',
};

export function ackIssue(issueType: string, alreadyVerified = false): string {
  if (issueType === 'lost_stolen_card') return alreadyVerified ? "I'm sorry, that's stressful. Let's get the card blocked quickly." : "I'm sorry, that's stressful. Let's get the card blocked quickly. First I just need to check it's you.";
  const what = ISSUE_PHRASES[issueType] ?? ISSUE_LABELS[issueType].toLowerCase();
  return alreadyVerified ? `Sure, I can help with ${what}.` : `I can help with ${what}. I've got the details you gave me. First, a quick security check.`;
}

export const ASK_DOB = 'Please tell me your date of birth.';
export const ASK_CARD = 'Could you read me your 16-digit card number? A few digits at a time is fine.';
/** The customer already said which card (last four) — use it, and ask only for what is still needed. */
export const askCardKnowing = (last4: string) => `Thanks, I've noted it's the card ending ${[...last4].join(' ')}. To confirm it's you, could you read me the full 16-digit card number? A few digits at a time is fine.`;
/** The customer gave the full number before the security step: confirm it rather than asking again. */
export const cardReadbackEarlier = (last4: string) => `You gave me your card number a moment ago, the one ending in ${[...last4].join(' ')}. Shall I use that one?`;
export const ASK_CUSTOMER_NUMBER = "I couldn't match the number you're calling from to an account. Please tell me your 8-digit customer number.";
export const otpSent = (to: string) => `Thank you. I've sent a 6-digit passcode by text message to your registered phone (${to}). Please read me the code when it arrives.`;
export const VERIFIED = "Thanks, you're verified. Let me take a look.";
export const LOCKED =
  "I'm sorry, I couldn't confirm it's you, so I can't look at or change anything on the account. I'll pass you to a colleague who can verify you another way.";

export function retryVerification(step: 'identify' | 'dob' | 'otp' | 'card', remaining: number, unparsed: boolean, tries = 1): string {
  if (step === 'card') {
    return unparsed
      ? tries <= 1 ? "I didn't catch the whole number. Could you read all 16 digits again, slowly?"
        : tries === 2 ? "Let's do it in small groups. Read me the first four digits and I'll tell you what I heard."
        : "That's okay. You can type the number instead of saying it, or I can bring in a colleague. Which would you prefer?"
      : `That number doesn't match the card we have on file. Could you check the card and read it again? You have ${remaining} attempt${remaining === 1 ? '' : 's'} left.`;
  }
  if (unparsed) {
    if (step === 'dob') return 'Please tell me your date of birth, including the year — for example "April 12, 1986".';
    if (step === 'otp') return 'Please read me the 6-digit code from the text message.';
    return 'Please tell me your 8-digit customer number.';
  }
  return `Sorry, that doesn't match our records. Please try again (${remaining} attempt${remaining === 1 ? '' : 's'} left).`;
}

function cardLast4(cardRef: string): string {
  return get<{ last4: string }>('SELECT last4 FROM bank_cards WHERE id = ?', [cardRef])?.last4 ?? '????';
}

/** Describe an operation's REAL persisted outcome. Never claims success without confirmation. */
export function describeOutcome(op: Operation): string {
  const ref = op.external_ref ? ` (reference ${op.external_ref})` : '';
  const at = op.completed_at ? ` at ${formatDateTime(op.completed_at)}` : '';
  switch (op.action_type) {
    case 'block_card': {
      const l4 = cardLast4(op.target_ref);
      if (op.status === 'succeeded') return `✓ Your card ending ${l4} is now blocked — confirmed by the card system${ref}${at}.`;
      if (op.status === 'failed') return `✗ I couldn't block your card ending ${l4} — the card system ${op.error_code === 'DOWNSTREAM_UNAVAILABLE' ? 'was unavailable' : 'rejected the request'}. Your card is NOT blocked.`;
      if (op.status === 'unknown') return `? I sent the request to block your card ending ${l4}, but I didn't get confirmation back in time, so I can't confirm it is blocked yet. I won't resend it until I've checked what happened.`;
      break;
    }
    case 'order_replacement':
      if (op.status === 'succeeded') return `✓ A replacement card has been ordered to your address on file${ref}.`;
      if (op.status === 'failed') return `✗ I couldn't order the replacement card (${op.error_code}).`;
      if (op.status === 'unknown') return `? I couldn't confirm whether the replacement card order went through.`;
      break;
    case 'submit_dispute':
      if (op.status === 'succeeded') return `✓ Your dispute has been submitted to the disputes team${ref}. This means it has been received for review — it is not a final decision.`;
      if (op.status === 'submitted') return `… I sent the dispute, but the disputes system hasn't acknowledged it yet, so it is pending — not yet filed. It's recorded on your case and will be followed up.`;
      if (op.status === 'failed') return `✗ The dispute could not be submitted (${op.error_code}). It has NOT been filed.`;
      if (op.status === 'unknown') return `? I couldn't confirm whether the dispute was received. It is not confirmed as filed.`;
      break;
    case 'reverse_fee': {
      const fee = get<{ amount_minor: number }>('SELECT amount_minor FROM bank_fees WHERE id = ?', [op.target_ref]);
      const amt = fee ? formatMoney(fee.amount_minor) : 'the';
      if (op.status === 'succeeded') return `✓ The ${amt} fee has been reversed — confirmed by the fee system${ref}.`;
      if (op.status === 'failed') return `✗ I couldn't reverse the fee (${op.error_code}). No credit has been applied.`;
      if (op.status === 'unknown') return `? I couldn't confirm whether the fee reversal went through.`;
      break;
    }
  }
  if (op.status === 'awaiting_approval') return `… This needs approval from a member of our team before it can be processed. It has not been done yet.`;
  if (op.status === 'rejected') return `✗ I couldn't proceed with this: ${op.error_message ?? 'it was not authorised.'}`;
  if (op.status === 'awaiting_confirmation') return `… Not yet started.`;
  return `… Status: ${op.status}.`;
}

/** Closing script: recap the outcome first, then offer more help, then the survey, then the goodbye. */
export const ANYTHING_ELSE = 'Is there anything else I can help you with today?';
/** Hold protocol: ask first, say why and for how long, and thank the caller afterwards. */
export const HOLD_ASK = (why: string) => `May I place you on a brief hold while ${why}? It should take less than a minute.`;
export const HOLD_BACK = 'Thank you for holding.';
export const HOLD_CHECKIN = 'Thank you for your patience. I am still working on this. Would you like to keep holding, or shall I arrange a callback?';
export const TRANSFER_INTRO = (reason: string) => `I'm going to connect you with a specialist who can help with ${reason}. I've passed on everything we discussed, so you won't need to repeat it. May I place you on a brief hold while they pick up?`;
export const SURVEY = 'Before you go, on a scale of 1 to 5, how was this call?';
export const GOODBYE = 'Thanks for calling Northstar Bank. Take care.';

/** Nudges when the caller has not said yes or no to a proposed change. Different each time, never pushy. */
export const CONSENT_NUDGE = [
  'Sorry, I need a yes or no before I do that. Should I go ahead?',
  "No rush. I'll only do it if you say yes. Would you like me to go ahead, or leave it for now?",
];
export const CARD_ACK = 'Thanks. One moment while I check that.';
export const CARD_TOO_MANY = (n: number) => `I heard ${n} digits, which is more than 16. Let's start again. Could you read the card number slowly, a few digits at a time?`;
export const cardProgress = (digits: string, said: string) => {
  const left = 16 - digits.length;
  return `Got it, ${said}. That's ${digits.length} of 16. Go ahead with the last ${left}.`;
};
export const cardReadback = (last4: string, updated: boolean) => `${updated ? "Updated. " : 'Thanks. '}That's a card ending in ${[...last4].join(' ')}. Is that right?`;
export const CARD_REASK = 'No problem. Could you read the 16-digit number again?';
export const CARD_YESNO = 'Sorry, was that number right? A yes or no is fine, or read it again.';
export const CARD_UNAVAILABLE = "Our security check is taking longer than usual, so I can't confirm that yet. I've kept what you told me. Say \"try again\" and I'll check once more, or I can bring in a person.";
