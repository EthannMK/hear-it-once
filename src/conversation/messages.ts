/** Customer-facing message templates. Plain language; every claim is filled from persisted data. */
import type { Operation } from '../actions/action-service.ts';
import { formatDateTime, formatMoney, ISSUE_LABELS } from './format.ts';
import { get } from '../db/db.ts';

export const GREETING_NOTICE =
  'Notice: this call may be recorded and transcribed for quality, security and training. Your information is handled under our privacy notice. ' +
  '[DEMO: this is a simulation with synthetic data — nothing is actually recorded and no real account, card or payment is affected.]';

export const GREETING =
  "Thank you for calling Northstar Bank. My name is Lily, and I'm an AI assistant, not a person. You can ask for a person at any time. How may I help you today?";

export const CLARIFY_ISSUE = 'Just so I get this right — which of these is closest to what you need help with?';

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

export function ackIssue(issueType: string): string {
  if (issueType === 'lost_stolen_card') return "I'm sorry to hear that. Let's get the card blocked as quickly as possible — first I need to quickly verify it's you.";
  return `Thanks — I understand this is about ${ISSUE_PHRASES[issueType] ?? ISSUE_LABELS[issueType].toLowerCase()}. I've noted what you said, so you won't need to repeat it. First, I need to verify your identity.`;
}

export const ASK_DOB = 'Please tell me your date of birth.';
export const ASK_CARD = 'To verify it\'s you, please read me the 16-digit card number on your Northstar card. [Demo only: use the demo card number shown on screen — it is fictional.]';
export const ASK_CUSTOMER_NUMBER = "I couldn't match the number you're calling from to an account. Please tell me your 8-digit customer number.";
export const otpSent = (to: string) => `Thank you. I've sent a 6-digit passcode by text message to your registered phone (${to}). Please read me the code when it arrives.`;
export const VERIFIED = "Thank you — you're verified. I'm checking our systems now.";
export const LOCKED =
  "I'm sorry, I wasn't able to verify your identity, so I can't access or change anything on the account. For your security, I'm transferring you to an agent who can verify you another way.";

export function retryVerification(step: 'identify' | 'dob' | 'otp' | 'card', remaining: number, unparsed: boolean): string {
  if (step === 'card') {
    return unparsed
      ? "I didn't catch the whole card number. Could you read all 16 digits again, slowly?"
      : `I'm sorry, that number doesn't match the card on file. Could you check the card and read the number again? You have ${remaining} attempt${remaining === 1 ? '' : 's'} left.`;
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
export const SURVEY = 'Before you go: on a scale of 1 (poor) to 5 (excellent), how would you rate this call? [Demo survey — simulated]';
export const GOODBYE = 'Thank you for calling Northstar Bank. Have a wonderful day. Goodbye.';

export const CARD_ACK = 'Thank you. Let me check that for you.';
export const CARD_TOO_MANY = (n: number) => `I heard ${n} digits, which is more than 16. Let's start again. Could you read the card number slowly, a few digits at a time?`;
export const cardProgress = (digits: string, said: string) => {
  const left = 16 - digits.length;
  return `Thank you. So far I have ${said}. That's ${digits.length} of 16 digits. Please read the remaining ${left}.`;
};
export const cardReadback = (last4: string, updated: boolean) => `${updated ? "No problem, I've updated it. " : 'Thank you. '}I heard a card number ending in ${[...last4].join(' ')}. Is that correct?`;
export const CARD_REASK = 'No problem. Please read the 16-digit card number again.';
export const CARD_YESNO = 'Sorry, was that number correct? Please say yes or no, or read the card number again.';
export const CARD_UNAVAILABLE = "I'm sorry, our verification check is taking longer than expected, so I can't confirm that yet. I've kept what you told me. Say \"try again\" and I'll check once more, or I can bring in a person.";
