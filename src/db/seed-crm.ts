/**
 * Earlier interactions for the demo customers, so the CRM shows believable history. SYNTHETIC,
 * labelled seeded_illustrative, and old enough (and closed) that the live call logic does not
 * treat them as open repeat contacts.
 */
import { get, run } from './db.ts';
import { newId, randomDigits } from '../lib/ids.ts';
import { nowMs } from '../lib/clock.ts';

export function seedCrmHistory(): void {
  const items: { customer: string; daysAgo: number; issue: string | null; said: string; summary: string; next: string; resolution: string; complaint?: string }[] = [
    { customer: 'CUS-1001', daysAgo: 74, issue: 'account_inquiry', said: 'Why did a contactless payment ask for my PIN?', summary: 'Explained that contactless payments sometimes ask for the PIN as a security check. No change made.', next: 'None.', resolution: 'informational' },
    { customer: 'CUS-1019', daysAgo: 58, issue: 'card_declined', said: 'I am going to Japan next month, will my card work there?', summary: 'Customer asked about using the card abroad. Explained the travel security rule and how to contact the bank if a payment is declined.', next: 'None.', resolution: 'informational' },
    { customer: 'CUS-1005', daysAgo: 120, issue: 'account_inquiry', said: 'Can I get a copy of last month’s statement?', summary: 'Statement copy sent to the registered email address.', next: 'None.', resolution: 'resolved' },
    { customer: 'CUS-1002', daysAgo: 91, issue: 'card_declined', said: 'My card was declined at a fuel pump.', summary: 'Pay-at-pump pre-authorisation was declined; the card itself was working. Explained and suggested paying inside.', next: 'None.', resolution: 'informational' },
    { customer: 'CUS-1008', daysAgo: 37, issue: null, said: 'I waited 40 minutes on hold last time and want to complain.', summary: 'Customer complained about hold times on a previous call. Complaint logged and acknowledged.', next: 'Complaints team responded within 5 working days.', resolution: 'resolved', complaint: 'Long hold time on a previous call' },
  ];
  for (const it of items) {
    if (!get('SELECT 1 FROM bank_customers WHERE id = ?', [it.customer])) continue;
    const at = new Date(nowMs() - it.daysAgo * 86_400_000);
    at.setUTCHours(14, 20, 0, 0);
    const ts = at.toISOString();
    const end = new Date(at.getTime() + 6 * 60_000).toISOString();
    const sid = newId('SES');
    const caseId = newId('CASE');
    run(
      `INSERT INTO call_sessions (id, correlation_id, channel, data_origin, scenario_id, state, customer_id, verification_status, verification_level, eligible, outcome, resolution_status, issue_type, issue_statement, answered_at, ended_at, case_created_at, created_at, updated_at)
       VALUES (?,?, 'telephony', 'seeded_illustrative', 'crm-history', 'ended', ?, 'verified', 'standard', 1, 'resolved', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [sid, newId('COR'), it.customer, it.resolution, it.issue, it.said, ts, end, ts, ts, end],
    );
    run(
      `INSERT INTO cases (id, session_id, customer_id, issue_type, status, resolution_status, verification_outcome, customer_reported, summary, next_steps, data_origin, created_at, updated_at, closed_at)
       VALUES (?,?,?,?, 'closed', ?, 'verified', ?, ?, ?, 'seeded_illustrative', ?, ?, ?)`,
      [caseId, sid, it.customer, it.issue, it.resolution, it.said, it.summary, it.next, ts, end, end],
    );
    // A short transcript, so the case reads like a real call.
    [['assistant', 'Thank you for calling Northstar Bank. This is Lily, an AI assistant. How can I help?'], ['customer', it.said], ['assistant', it.summary]]
      .forEach(([who, text], i) => run('INSERT INTO conversation_turns (session_id, seq, speaker, kind, text, created_at) VALUES (?,?,?,?,?,?)', [sid, i + 1, who, 'utterance', text, new Date(at.getTime() + i * 20_000).toISOString()]));
    if (it.complaint) {
      const tid = `TCK-${randomDigits(6)}`;
      run(
        `INSERT INTO case_tickets (id, case_id, customer_id, type, category, reason, original_concern, summary, confirmed_details_json, steps_taken_json, evidence_json, outstanding_action, priority, status, team, owner_id, request_key, created_by, data_origin, created_at, updated_at)
         VALUES (?,?,?, 'complaint', 'General inquiry', ?, ?, ?, '[]', ?, '[]', NULL, 'high', 'closed', 'Complaints', 'STF-AGENT-2', ?, 'STF-AGENT-2', 'seeded_illustrative', ?, ?)`,
        [tid, caseId, it.customer, it.complaint, it.said, it.summary, JSON.stringify(['Complaint acknowledged on the call', 'Complaints team replied in writing']), `seed:${tid}`, ts, end],
      );
      run('INSERT INTO ticket_events (ticket_id, event, detail, actor_id, created_at) VALUES (?,?,?,?,?)', [tid, 'created', 'Complaint ticket created for Complaints.', 'STF-AGENT-2', ts]);
      run('INSERT INTO ticket_events (ticket_id, event, detail, actor_id, created_at) VALUES (?,?,?,?,?)', [tid, 'status_closed', 'Customer accepted the apology.', 'STF-AGENT-2', end]);
    }
  }
}
