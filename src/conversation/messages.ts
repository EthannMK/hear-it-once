/** Customer-facing message templates. Plain language; every claim is filled from persisted data. */
import type { Operation } from '../actions/action-service.ts';
import { formatDateTime, formatMoney, ISSUE_LABELS } from './format.ts';
import { get } from '../db/db.ts';

export const GREETING_NOTICE =
  'Notice: this call may be recorded and transcribed for quality, security and training. Your information is handled under our privacy notice. ' +
  '[DEMO: this is a simulation with synthetic data — nothing is actually recorded and no real account, card or payment is affected.]';

export const GREETING =
  "Hello, you've reached Card Services. I'm an AI assistant — a computer program, not a person. You can ask to speak to a person at any time. In a few words, how can I help you today?";

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
};

export function ackIssue(issueType: string): string {
  if (issueType === 'lost_stolen_card') return "I'm sorry to hear that. Let's get the card blocked as quickly as possible — first I need to quickly verify it's you.";
  return `Thanks — I understand this is about ${ISSUE_PHRASES[issueType] ?? ISSUE_LABELS[issueType].toLowerCase()}. I've noted what you said, so you won't need to repeat it. First, I need to verify your identity.`;
}

export const ASK_DOB = 'Please tell me your date of birth.';
export const ASK_CUSTOMER_NUMBER = "I couldn't match the number you're calling from to an account. Please tell me your 8-digit customer number.";
export const otpSent = (to: string) => `Thank you. I've sent a 6-digit passcode by text message to your registered phone (${to}). Please read me the code when it arrives.`;
export const VERIFIED = "Thank you — you're verified. I'm checking our systems now.";
export const LOCKED =
  "I'm sorry, I wasn't able to verify your identity, so I can't access or change anything on the account. For your security, I'm transferring you to an agent who can verify you another way.";

export function retryVerification(step: 'identify' | 'dob' | 'otp', remaining: number, unparsed: boolean): string {
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

export const ANYTHING_ELSE = 'Is there anything else I can help you with today?';
export const SURVEY = 'Before you go: on a scale of 1 (poor) to 5 (excellent), how would you rate this call? [Demo survey — simulated]';
export const GOODBYE = 'Thank you for calling. Goodbye.';
