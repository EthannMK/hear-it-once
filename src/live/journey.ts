/**
 * The four selectable demo journeys on the landing page. Selecting one starts the call against the
 * matching SYNTHETIC customer, so the caller number, the account data and the faults are those of
 * that scenario. Everything shown comes from the seeded mock bank, never from real customers.
 */
import { env } from '../config/env.ts';
import { get } from '../db/db.ts';
import { formatMoney } from '../conversation/format.ts';
import type { ScenarioDef } from '../db/scenarios.ts';

export interface JourneyDef {
  id: 'unexpected_charge' | 'card_declined' | 'fee_question' | 'speak_to_human';
  scenarioId: string;
  title: string;
  tag: string;
  quote: string;
}

export const JOURNEY_SCENARIOS: JourneyDef[] = [
  { id: 'unexpected_charge', scenarioId: 'S01', title: 'Unexpected card charge', tag: 'Transaction · possible fraud', quote: 'I noticed a transaction I don’t recognise.' },
  { id: 'card_declined', scenarioId: 'S19', title: 'Card declined', tag: 'Card troubleshooting', quote: 'My card was declined when I tried to pay.' },
  { id: 'fee_question', scenarioId: 'S05', title: 'Question about a fee', tag: 'Fee enquiry · eligibility check', quote: 'Why was I charged this fee, and can it be reversed?' },
  { id: 'speak_to_human', scenarioId: 'S08', title: 'Speak to a human', tag: 'Human-agent handover', quote: 'I’d prefer to speak to a real person.' },
];

/** Card details are built from the seeded customer's own rows so they change if the data does. */
export function journeyCard(j: JourneyDef, s: ScenarioDef) {
  const card = get<{ last4: string; network: string }>("SELECT last4, network FROM bank_cards WHERE customer_id = ? ORDER BY id LIMIT 1", [s.customer.id]);
  const details: { label: string; value: string }[] = [{ label: 'Persona', value: s.customer.name }];
  if (card) details.push({ label: 'Card', value: `${card.network} ····${card.last4}` });
  if (j.id === 'unexpected_charge') {
    const t = get<{ merchant_name: string; amount_minor: number }>("SELECT merchant_name, amount_minor FROM bank_transactions WHERE customer_id = ? AND kind = 'purchase' ORDER BY amount_minor DESC LIMIT 1", [s.customer.id]);
    if (t) details.push({ label: 'Flagged charge', value: `${formatMoney(t.amount_minor)} · ${t.merchant_name}` }, { label: 'Risk level', value: 'Elevated' });
  } else if (j.id === 'card_declined') {
    const d = get<{ merchant_name: string; amount_minor: number }>('SELECT merchant_name, amount_minor FROM bank_declines WHERE customer_id = ? ORDER BY declined_at DESC LIMIT 1', [s.customer.id]);
    if (d) details.push({ label: 'Declined payment', value: `${formatMoney(d.amount_minor)} · ${d.merchant_name}` });
  } else if (j.id === 'fee_question') {
    const f = get<{ amount_minor: number }>('SELECT amount_minor FROM bank_fees WHERE customer_id = ? AND reversed_at IS NULL ORDER BY charged_at DESC LIMIT 1', [s.customer.id]);
    if (f) details.push({ label: 'Fee on account', value: `${formatMoney(f.amount_minor)} · late payment` });
  } else {
    details.push({ label: 'Routing', value: 'Agent console (in-app)' }, { label: 'Handover', value: 'Waits until an agent accepts' });
  }
  return {
    id: j.id,
    scenarioId: j.scenarioId,
    title: j.title,
    tag: j.tag,
    quote: j.quote,
    persona: s.customer.name,
    callerNumber: s.customer.phone,
    details,
    // Demo-only helper so a presenter can answer the verification questions out loud.
    verificationHints: env().DEMO_MODE ? { dob: s.customer.dob, passcode: 'Shown on the simulated phone when Lily asks for it.' } : null,
    synthetic: true,
  };
}
