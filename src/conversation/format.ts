/** Plain-language labels and formatting shared by messages, summaries and the UI. */
export const ISSUE_LABELS: Record<string, string> = {
  unrecognised_transaction: 'Unrecognised transaction',
  lost_stolen_card: 'Lost or stolen card',
  wrong_or_duplicate_charge: 'Wrong or duplicate charge',
  payment_not_showing: 'Payment not showing',
  fee_query: 'Fee query',
  card_declined: 'Card declined',
  account_inquiry: 'Account enquiry',
};

export const ACTION_LABELS: Record<string, string> = {
  block_card: 'Block card',
  order_replacement: 'Order replacement card',
  submit_dispute: 'Submit dispute',
  reverse_fee: 'Reverse fee',
  create_case: 'Create case',
  initiate_handoff: 'Transfer to agent',
};

export const OP_STATUS_LABELS: Record<string, string> = {
  requested: 'Requested',
  validated: 'Validated',
  rejected: 'Rejected by policy',
  awaiting_confirmation: 'Awaiting confirmation',
  awaiting_approval: 'Awaiting agent approval',
  submitted: 'Pending (submitted, not yet confirmed)',
  succeeded: 'Succeeded (confirmed)',
  failed: 'Failed',
  unknown: 'Unknown — outcome not confirmed',
};

export const HANDOFF_REASON_LABELS: Record<string, string> = {
  customer_requested: 'Customer asked for a person',
  complaint: 'Customer made a formal complaint',
  verification_failed: 'Identity verification failed',
  ai_uncertain: 'Assistant uncertain of the request',
  system_unavailable: 'Required system unavailable',
  conflicting_data: 'Systems returned conflicting results',
  social_engineering_suspected: 'Possible social engineering / third-party caller',
  account_takeover_suspected: 'Possible account takeover',
  out_of_policy: 'Outside approved policy',
  approval_required: 'Action requires human approval',
  action_failed: 'A consequential action failed',
  communication_breakdown: 'Communication breakdown / distress',
  assistant_unavailable: 'Assistant unavailable (fallback)',
  customer_accepted_offer: 'Customer accepted offer of an agent',
};

export function formatMoney(minor: number, currency = 'USD'): string {
  const v = Math.abs(minor) / 100;
  const s = v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${minor < 0 ? '-' : ''}${currency === 'USD' ? '$' : currency + ' '}${s}`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' });
}
