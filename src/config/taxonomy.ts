/**
 * CASE TAXONOMY used by the CRM workspace. Change the labels and rules here, not in the UI.
 * Every value an agent can pick comes from these lists, and the server rejects anything else.
 * Priority and status are computed from recorded case state by explicit rules. A sentiment
 * label is shown for context only: it never raises priority above "high" and never triggers
 * a banking action.
 */
export const CATEGORIES = ['Card services', 'Payment issue', 'Transaction dispute', 'Card security', 'Fee inquiry', 'General inquiry'] as const;
export const ISSUE_TYPES = ['Unrecognised transaction', 'Payment not received', 'Lost or stolen card', 'Duplicate or wrong charge', 'Fee question', 'Card declined', 'Account question', 'Other'] as const;
export const PRIORITIES = ['normal', 'high', 'urgent'] as const;
export const STATUSES = ['new', 'in_progress', 'awaiting_customer', 'awaiting_bank', 'escalated', 'resolved'] as const;
export const RESOLUTION_TYPES = ['Resolved by assistant', 'Information given', 'Action taken, awaiting bank', 'Passed to an agent', 'Resolved by agent', 'Not resolved'] as const;
export const ESCALATION_REASONS = [
  'Customer asked for a person',
  'Formal complaint',
  'Identity could not be verified',
  'Outside what the assistant may do',
  'Needs human approval',
  'An action failed or is unconfirmed',
  'System unavailable or conflicting data',
  'Security concern',
  'Assistant unsure of the request',
] as const;
/**
 * Call tags: the agent's own labels for what a call turns out to be, chosen at wrap-up. They are
 * reporting labels, not a classification the assistant acts on, which is why they are kept apart
 * from the category and issue type. The list is a starting set; an agent may add their own.
 */
export const CALL_TAGS = [
  'First contact resolution',
  'Repeat contact',
  'Vulnerable customer',
  'Complaint risk',
  'Fraud suspected',
  'Dispute raised',
  'Fee reversed',
  'Card blocked',
  'Card replaced',
  'Payment chased',
  'Identity check failed',
  'Escalated to specialist',
  'Callback promised',
  'Customer education',
  'Process gap',
] as const;

export const TEAMS = ['Card services', 'Disputes', 'Fraud and security', 'Payments operations', 'Complaints'] as const;

export type Priority = (typeof PRIORITIES)[number];
export type CrmStatus = (typeof STATUSES)[number];

export const STATUS_LABELS: Record<CrmStatus, string> = {
  new: 'New',
  in_progress: 'In progress',
  awaiting_customer: 'Awaiting customer',
  awaiting_bank: 'Awaiting bank',
  escalated: 'Escalated',
  resolved: 'Resolved',
};

/** Issue key (as stored on the case) → CRM category and issue type. */
export const ISSUE_MAP: Record<string, { category: (typeof CATEGORIES)[number]; issueType: (typeof ISSUE_TYPES)[number]; team: (typeof TEAMS)[number] }> = {
  unrecognised_transaction: { category: 'Transaction dispute', issueType: 'Unrecognised transaction', team: 'Disputes' },
  wrong_or_duplicate_charge: { category: 'Transaction dispute', issueType: 'Duplicate or wrong charge', team: 'Disputes' },
  lost_stolen_card: { category: 'Card security', issueType: 'Lost or stolen card', team: 'Fraud and security' },
  payment_not_showing: { category: 'Payment issue', issueType: 'Payment not received', team: 'Payments operations' },
  fee_query: { category: 'Fee inquiry', issueType: 'Fee question', team: 'Card services' },
  card_declined: { category: 'Card services', issueType: 'Card declined', team: 'Card services' },
  account_inquiry: { category: 'Card services', issueType: 'Account question', team: 'Card services' },
};

/** Handover reason recorded by the call → escalation reason shown in the CRM. */
export const ESCALATION_MAP: Record<string, (typeof ESCALATION_REASONS)[number]> = {
  customer_requested: 'Customer asked for a person',
  customer_accepted_offer: 'Customer asked for a person',
  complaint: 'Formal complaint',
  verification_failed: 'Identity could not be verified',
  out_of_policy: 'Outside what the assistant may do',
  approval_required: 'Needs human approval',
  action_failed: 'An action failed or is unconfirmed',
  system_unavailable: 'System unavailable or conflicting data',
  conflicting_data: 'System unavailable or conflicting data',
  social_engineering_suspected: 'Security concern',
  account_takeover_suspected: 'Security concern',
  ai_uncertain: 'Assistant unsure of the request',
  communication_breakdown: 'Assistant unsure of the request',
  assistant_unavailable: 'System unavailable or conflicting data',
};

/** Amount at or above which a disputed charge is treated as high priority. */
export const HIGH_VALUE_MINOR = 50_000;
