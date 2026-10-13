/**
 * The 18 required demo scenarios (BRD §14 / implementation prompt §9). Each maps to a
 * SYNTHETIC customer whose data and mock faults reproduce the scenario. All names, numbers,
 * phone numbers (555-01xx fictional range) and dates of birth are invented.
 */
export interface ScenarioDef {
  id: string;
  title: string;
  issue: string;
  customer: { id: string; number: string; name: string; dob: string; phone: string };
  /** Suggested caller lines for the walkthrough (the caller may type anything). */
  script: string[];
  expected: string;
  faults?: { target: string; fault: 'unavailable' | 'timeout' | 'stale' | 'fail' | 'timeout_after_submit' | 'pending' | 'error'; scope?: 'customer' | 'scenario' }[];
}

const c = (n: number, name: string, dob: string) => ({
  id: `CUS-${String(1000 + n)}`,
  number: `4001${String(n).padStart(4, '0')}`,
  name,
  dob,
  phone: `+1 (555) 010-${String(100 + n).padStart(4, '0')}`,
});

export const SCENARIOS: ScenarioDef[] = [
  { id: 'S01', title: 'Unrecognised charge → block, replace, dispute', issue: 'unrecognised_transaction', customer: c(1, 'Alex Morgan', '1986-04-12'),
    script: ["There's a charge from Novaplay for $249 that I didn't make", '<date of birth: 1986-04-12>', '<one-time passcode from the simulated device>', 'Yes, go ahead'],
    expected: 'Parallel lookups confirm an eligible fraud dispute; after consent the card is blocked, a replacement ordered and the dispute submitted (all confirmed by mock services); case persisted.' },
  { id: 'S02', title: 'Lost card → rapid block + replacement', issue: 'lost_stolen_card', customer: c(2, 'Priya Shah', '1990-09-23'),
    script: ['I lost my credit card', '<date of birth: 1990-09-23>', '<passcode>', 'Yes, block it', 'Yes please', 'No, everything looks fine'],
    expected: 'Block is proposed immediately after verification and confirmed by the card-control mock; time-to-block recorded; replacement ordered; case created.' },
  { id: 'S03', title: 'Duplicate charge, insufficient evidence', issue: 'wrong_or_duplicate_charge', customer: c(3, 'Daniel Okafor', '1979-02-03'),
    script: ['I was charged twice at Harbor Grill', '<date of birth: 1979-02-03>', '<passcode>'],
    expected: 'One of the two charges is still pending, so no dispute is offered; assistant explains the evidence and offers a human agent.' },
  { id: 'S04', title: 'Payment not showing (pending)', issue: 'payment_not_showing', customer: c(4, 'Maria Lopez', '1983-11-30'),
    script: ["I made a payment of $500 but it's not showing", '<date of birth: 1983-11-30>', '<passcode>'],
    expected: 'Payment system reports pending with no posting date; assistant says so and does not invent a date.' },
  { id: 'S05', title: 'Eligible fee reversal', issue: 'fee_query', customer: c(5, 'Tom Becker', '1975-06-18'),
    script: ['Why was I charged a late fee?', '<date of birth: 1975-06-18>', '<passcode>', 'Yes please'],
    expected: 'Late fee meets rule FP-LATE-01; reversal proposed, consented and confirmed by the fee-ledger mock.' },
  { id: 'S06', title: 'Ineligible fee reversal', issue: 'fee_query', customer: c(6, 'Grace Lin', '1992-01-27'),
    script: ['Can you remove the late fee on my account?', '<date of birth: 1992-01-27>', '<passcode>'],
    expected: 'A courtesy reversal was already granted in the last 12 months; assistant explains the rule and offers a human agent.' },
  { id: 'S07', title: 'Repeat caller with unresolved case', issue: 'payment_not_showing', customer: c(7, 'Samuel Reed', '1968-08-08'),
    script: ["I'm calling again about my payment", '<date of birth: 1968-08-08>', '<passcode>'],
    expected: 'After verification the prior open case is retrieved, the assistant opens with known context and flags a recurring unresolved issue.' },
  { id: 'S08', title: 'Customer asks for a human immediately', issue: '—', customer: c(8, 'Lena Fischer', '1988-03-14'),
    script: ['I want to speak to a real person'],
    expected: 'Handoff starts without resistance; brief preserves the context; status shows queued until a demo agent accepts.' },
  { id: 'S09', title: 'AI uncertainty → human', issue: '—', customer: c(9, 'Omar Haddad', '1995-12-01'),
    script: ['Something is off with my stuff', "It's the thing from before, you know"],
    expected: 'Intent stays below the confidence threshold after one clarification; assistant hands off with reason "ai_uncertain".' },
  { id: 'S10', title: 'Identity verification fails', issue: 'unrecognised_transaction', customer: c(10, 'Chloe Martin', '1991-07-07'),
    script: ["There's a charge I don't recognise", '<wrong date of birth: 1990-01-01>', '1990-01-02', '1990-01-03'],
    expected: 'After 3 failed attempts verification is locked; no protected data is disclosed and no action possible; handoff offered.' },
  { id: 'S11', title: 'Required banking system unavailable', issue: 'unrecognised_transaction', customer: c(11, 'Ivan Petrov', '1980-05-05'),
    script: ["I don't recognise a QuickStream charge of $59.99", '<date of birth: 1980-05-05>', '<passcode>'],
    expected: 'Transaction history source is unavailable; no decision or write is made; safe handoff with partial results recorded.',
    faults: [{ target: 'transactions', fault: 'unavailable' }] },
  { id: 'S12', title: 'Conflicting system results', issue: 'unrecognised_transaction', customer: c(12, 'Hannah Wright', '1977-10-19'),
    script: ['There is a $1249 Orbit Electronics charge I never made', '<date of birth: 1977-10-19>', '<passcode>'],
    expected: 'Card system says the card is active but the fraud system says it is blocked; no sensitive write; escalation with conflict noted.' },
  { id: 'S13', title: 'Card block fails', issue: 'lost_stolen_card', customer: c(13, 'Ben Carter', '1984-04-04'),
    script: ['My card was stolen', '<date of birth: 1984-04-04>', '<passcode>', 'Yes, block it'],
    expected: 'Card-control mock rejects the block; assistant does NOT say the card is blocked and escalates urgently.',
    faults: [{ target: 'card_control', fault: 'fail' }] },
  { id: 'S14', title: 'Card block times out → Unknown → reconciled', issue: 'lost_stolen_card', customer: c(14, 'Sofia Rossi', '1993-02-28'),
    script: ['Someone stole my wallet with my card', '<date of birth: 1993-02-28>', '<passcode>', 'Yes', 'Can you check if it worked?'],
    expected: 'Block reply times out after submission → status Unknown; reconciliation looks it up by idempotency key and confirms the block; no blind retry.',
    faults: [{ target: 'card_control', fault: 'timeout_after_submit' }] },
  { id: 'S15', title: 'Duplicate action request (idempotency)', issue: 'lost_stolen_card', customer: c(15, 'Noah Kim', '1987-09-09'),
    script: ['I lost my card', '<date of birth: 1987-09-09>', '<passcode>', '<use "Send consent twice" in the scenario panel>'],
    expected: 'Two identical concurrent confirmations produce exactly one block operation and one downstream call.' },
  { id: 'S16', title: 'Dispute submission pending', issue: 'unrecognised_transaction', customer: c(16, 'Ava Nguyen', '1989-12-12'),
    script: ["I didn't make the Lumen Travel charge for $412.50", '<date of birth: 1989-12-12>', '<passcode>', 'Yes'],
    expected: 'Card block and replacement succeed; dispute intake returns pending (not acknowledged) — assistant says it is pending, not filed.',
    faults: [{ target: 'dispute_intake', fault: 'pending' }] },
  { id: 'S17', title: 'Assistant unavailable → fallback', issue: '—', customer: c(17, 'Leo Martins', '1972-03-03'),
    script: ['I have a question about a fee'],
    expected: 'The assistant engine fails; simulator shows the controlled fallback, keeps the issue statement and session/case state, and routes to the agent queue.',
    faults: [{ target: 'assistant', fault: 'unavailable', scope: 'scenario' }] },
  { id: 'S18', title: 'Action without consent / permission rejected', issue: 'fee_query', customer: c(18, 'Mia Jensen', '1996-06-06'),
    script: ['Please waive my late fee', '<date of birth: 1996-06-06>', '<passcode>', '<use "Attempt without consent" in the scenario panel>'],
    expected: 'Direct API action attempts without consent (422) or with a QA/admin role (403) are rejected by the backend and audited.' },
];

export const scenarioById = (id: string) => SCENARIOS.find((s) => s.id === id);
