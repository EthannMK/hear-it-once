/**
 * BACK-OFFICE AGENT for the CRM.
 *
 * The human agent can ask about the customer on the call ("has she disputed before?", "is anyone
 * else reporting this merchant?") and gets three insights when the case opens.
 *
 *  - With AGENT_ENGINE_RESOURCE set, questions go to the Google ADK agent deployed on Vertex AI
 *    Agent Engine (agents/backoffice). It reads BigQuery through read-only tools and answers with
 *    its sources and the queries it ran.
 *  - Without it (local runs, tests, or if the agent is slow or down), built-in answers are computed
 *    from the same bank records. The UI says which one answered.
 *
 * Read-only either way: nothing here can change an account.
 */
import { GoogleAuth } from 'google-auth-library';
import { all, get, parseJson } from '../db/db.ts';
import { env } from '../config/env.ts';
import { log } from '../lib/logger.ts';
import { AppError } from '../lib/errors.ts';
import { formatMoney } from '../conversation/format.ts';
import { ISSUE_LABELS } from '../conversation/format.ts';
import { accountOverview } from '../crm/crm.ts';

export interface AgentStep { tool: string; detail: string | null }
export interface AgentAnswer {
  mode: 'adk' | 'builtin';
  engine: string;
  text: string;
  bullets: string[];
  sources: string[];
  steps: AgentStep[];
  ms: number;
  fallbackReason?: string;
}

/* ------------------------------------------------------------------ context */

interface Ctx {
  caseId: string | null;
  customerId: string | null;
  verified: boolean;
  name: string | null;
  issue: string | null;
  said: string | null;
  card: { ref: string; label: string } | null;
  txns: { id: string; merchant: string | null; amount: string; at: string }[];
}

export function contextFor(target: { caseId?: string; customerId?: string }): Ctx {
  if (target.caseId) {
    const c = get<{ id: string; session_id: string; customer_id: string | null; issue_type: string | null; customer_reported: string | null; verification_outcome: string; transaction_refs_json: string }>(
      'SELECT id, session_id, customer_id, issue_type, customer_reported, verification_outcome, transaction_refs_json FROM cases WHERE id = ?', [target.caseId]);
    if (!c) throw new AppError('NOT_FOUND', 'Case not found.');
    const verified = !!c.customer_id && c.verification_outcome === 'verified';
    const ops = all<{ action_type: string; target_ref: string }>('SELECT action_type, target_ref FROM action_operations WHERE session_id = ?', [c.session_id]);
    const txnIds = [...new Set([...parseJson<string[]>(c.transaction_refs_json, []), ...ops.filter((o) => o.action_type === 'submit_dispute').map((o) => o.target_ref)])];
    const base = verified ? customerBits(c.customer_id!, txnIds, ops.map((o) => o.target_ref)) : { name: null, card: null, txns: [] };
    return { caseId: c.id, customerId: verified ? c.customer_id : null, verified, issue: c.issue_type ? ISSUE_LABELS[c.issue_type] ?? c.issue_type : null, said: c.customer_reported, ...base };
  }
  const id = target.customerId!;
  if (!get('SELECT 1 FROM bank_customers WHERE id = ?', [id])) throw new AppError('NOT_FOUND', 'Customer not found.');
  return { caseId: null, customerId: id, verified: true, issue: null, said: null, ...customerBits(id, [], []) };
}

function customerBits(customerId: string, txnIds: string[], targets: string[]) {
  const name = get<{ full_name: string }>('SELECT full_name FROM bank_customers WHERE id = ?', [customerId])?.full_name ?? null;
  const cards = all<{ id: string; last4: string; network: string; status: string; holder_role: string }>('SELECT id, last4, network, status, holder_role FROM bank_cards WHERE customer_id = ?', [customerId]);
  const k = cards.find((x) => targets.includes(x.id)) ?? cards.find((x) => x.holder_role === 'primary') ?? cards[0];
  const txns = txnIds.length
    ? all<{ id: string; merchant_name: string | null; amount_minor: number; currency: string; txn_at: string }>(`SELECT id, merchant_name, amount_minor, currency, txn_at FROM bank_transactions WHERE id IN (${txnIds.map(() => '?').join(',')})`, txnIds)
        .map((t) => ({ id: t.id, merchant: t.merchant_name, amount: formatMoney(t.amount_minor, t.currency), at: t.txn_at.slice(0, 10) }))
    : [];
  return { name, card: k ? { ref: k.id, label: `${k.network} •••• ${k.last4}, ${k.status}` } : null, txns };
}

function contextText(x: Ctx): string {
  const lines = [
    x.caseId ? `Case ${x.caseId}${x.issue ? ` (${x.issue})` : ''}.` : 'No case: the agent is looking up a customer.',
    x.verified && x.customerId ? `Customer: ${x.name}, customer_id ${x.customerId}, identity verified.` : 'The caller is NOT verified: do not look up or reveal any account details; answer only about rules and guidance.',
    x.card ? `Card on this call: ${x.card.ref} (${x.card.label}).` : null,
    x.txns.length ? `Transactions in question: ${x.txns.map((t) => `${t.id} ${t.merchant ?? ''} ${t.amount} on ${t.at}`).join('; ')}.` : null,
    x.said ? `The customer said: "${x.said.slice(0, 300)}"` : null,
  ];
  return lines.filter(Boolean).join('\n');
}

/* ------------------------------------------------------------------ Agent Engine (ADK) */

let auth: GoogleAuth | null = null;
const sessions = new Map<string, { id: string; at: number }>();
const SESSION_TTL = 30 * 60_000;

function endpoint(resource: string, method: 'query' | 'streamQuery'): string {
  const location = resource.split('/')[3];
  return `https://${location}-aiplatform.googleapis.com/v1/${resource}:${method}`;
}

async function callEngine(resource: string, method: 'query' | 'streamQuery', body: unknown, signal: AbortSignal): Promise<string> {
  auth ??= new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const token = await auth.getAccessToken();
  const res = await fetch(endpoint(resource, method), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Agent Engine ${method} ${res.status}: ${text.slice(0, 300)}`);
  return text;
}

/** Turn Agent Engine's stream (one JSON event per line, or server-sent events) into text, steps and sources. */
export function parseEngineStream(raw: string): { text: string; steps: AgentStep[]; sources: string[] } {
  const events: any[] = [];
  for (let line of raw.split(/\r?\n/)) {
    line = line.trim();
    if (line.startsWith('data:')) line = line.slice(5).trim();
    if (!line || line === '[DONE]') continue;
    try { events.push(JSON.parse(line)); } catch { /* keep-alives, partial lines */ }
  }
  const steps: AgentStep[] = [];
  const sources = new Set<string>();
  let text = '';
  for (const e of events) {
    const parts: any[] = e?.content?.parts ?? [];
    for (const p of parts) {
      const call = p.function_call ?? p.functionCall;
      const resp = p.function_response ?? p.functionResponse;
      if (call?.name) {
        const args = call.args ?? {};
        steps.push({ tool: String(call.name), detail: args.sql ? String(args.sql) : args.customer_id ? `customer ${args.customer_id}` : args.merchant ? `merchant ${args.merchant}` : args.topic ? String(args.topic) : null });
      }
      for (const s of resp?.response?.sources ?? []) sources.add(String(s));
      if (resp?.name === 'run_sql') sources.add('BigQuery query');
      if (typeof p.text === 'string' && !p.thought && (e?.content?.role ?? 'model') === 'model') text = p.text; // the last text is the answer
    }
  }
  return { text: text.trim(), steps, sources: [...sources] };
}

async function askEngine(resource: string, userId: string, sessionKey: string, message: string): Promise<{ text: string; steps: AgentStep[]; sources: string[] }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), env().AGENT_ENGINE_TIMEOUT_MS);
  try {
    let s = sessions.get(sessionKey);
    if (!s || Date.now() - s.at > SESSION_TTL) {
      const created = JSON.parse(await callEngine(resource, 'query', { class_method: 'create_session', input: { user_id: userId } }, ctrl.signal));
      const id = created?.output?.id ?? created?.output?.session_id;
      if (!id) throw new Error('Agent Engine did not return a session');
      s = { id: String(id), at: Date.now() };
      sessions.set(sessionKey, s);
    }
    const raw = await callEngine(resource, 'streamQuery', { class_method: 'stream_query', input: { user_id: userId, session_id: s.id, message } }, ctrl.signal);
    s.at = Date.now();
    const out = parseEngineStream(raw);
    if (!out.text) throw new Error('Agent Engine returned no answer');
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/** Split the agent's reply into bullets and its "Sources:" line. */
export function shapeAnswer(text: string): { text: string; bullets: string[]; sources: string[] } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const srcLine = lines.find((l) => /^\**sources?\**\s*:/i.test(l));
  const body = lines.filter((l) => l !== srcLine);
  const bullets = body.filter((l) => /^[-*•]\s+/.test(l)).map((l) => l.replace(/^[-*•]\s+/, '').replace(/\*\*/g, ''));
  const sources = srcLine ? srcLine.replace(/^\**sources?\**\s*:\s*/i, '').split(/[,;]/).map((x) => x.trim()).filter(Boolean) : [];
  return { text: body.filter((l) => !/^[-*•]\s+/.test(l)).join(' ').replace(/\*\*/g, ''), bullets, sources };
}

/* ------------------------------------------------------------------ built-in answers */

const DAY = 86_400_000;
const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const sinceIso = (d: number) => new Date(Date.now() - d * DAY).toISOString();

function history(customerId: string, exceptCaseId: string | null = null) {
  const sid = exceptCaseId ? get<{ session_id: string }>('SELECT session_id FROM cases WHERE id = ?', [exceptCaseId])?.session_id ?? '' : '';
  const disputes = all<{ transaction_id: string; status: string; created_at: string }>('SELECT transaction_id, status, created_at FROM disputes WHERE customer_id = ? AND COALESCE(session_id, \'\') != ? ORDER BY created_at DESC', [customerId, sid]);
  const cases = get<{ n: number }>('SELECT COUNT(*) n FROM cases WHERE customer_id = ?', [customerId])?.n ?? 0;
  const reversed = all<{ fee_type: string; amount_minor: number; reversed_at: string }>("SELECT fee_type, amount_minor, reversed_at FROM bank_fees WHERE customer_id = ? AND reversed_at IS NOT NULL AND reversed_at >= ?", [customerId, sinceIso(365)]);
  const alerts = all<{ alert_type: string; status: string }>('SELECT alert_type, status FROM bank_fraud_alerts WHERE customer_id = ?', [customerId]);
  return { disputes, cases, reversed, alerts };
}

function merchantPattern(merchant: string, exceptCustomer: string | null, days = 30) {
  const like = `%${merchant.toUpperCase()}%`;
  const tx = get<{ n: number; customers: number }>('SELECT COUNT(*) n, COUNT(DISTINCT customer_id) customers FROM bank_transactions WHERE UPPER(merchant_name) LIKE ? AND txn_at >= ?', [like, sinceIso(days)]) ?? { n: 0, customers: 0 };
  const alerted = get<{ customers: number }>('SELECT COUNT(DISTINCT a.customer_id) customers FROM bank_fraud_alerts a JOIN bank_transactions t ON t.id = a.transaction_id WHERE UPPER(t.merchant_name) LIKE ? AND a.created_at >= ? AND a.customer_id != ?', [like, sinceIso(days), exceptCustomer ?? '']) ?? { customers: 0 };
  const disputed = get<{ customers: number }>('SELECT COUNT(DISTINCT d.customer_id) customers FROM disputes d JOIN bank_transactions t ON t.id = d.transaction_id WHERE UPPER(t.merchant_name) LIKE ? AND d.created_at >= ? AND d.customer_id != ?', [like, sinceIso(days), exceptCustomer ?? '']) ?? { customers: 0 };
  return { transactions: tx.n, customers: tx.customers, otherAlerted: alerted.customers, otherDisputed: disputed.customers };
}

function ruleFor(x: Ctx): string | null {
  if (x.txns.length) {
    const r = get<{ rule_code: string; description: string; max_days_since_txn: number }>("SELECT rule_code, description, max_days_since_txn FROM bank_dispute_rules WHERE active = 1 ORDER BY reason = 'fraud_unrecognised' DESC, max_days_since_txn DESC LIMIT 1");
    if (r) return `Rule ${r.rule_code}: disputes are accepted up to ${r.max_days_since_txn} days after the charge. ${r.description}`.slice(0, 220);
  }
  const fee = get<{ rule_code: string; description: string }>('SELECT rule_code, description FROM bank_fee_policies WHERE reversible = 1 LIMIT 1');
  return fee ? `Rule ${fee.rule_code}: ${fee.description}`.slice(0, 220) : null;
}

function builtinInsights(x: Ctx): string[] {
  if (!x.verified || !x.customerId) {
    return [
      'The caller is not verified, so account history is not shown.',
      'Send a passcode to the registered phone before discussing the account.',
      ruleFor(x) ?? 'Follow the identity-check guidance before any change.',
    ];
  }
  const h = history(x.customerId, x.caseId);
  const first = h.disputes.length
    ? `${x.name} has ${h.disputes.length} earlier dispute${h.disputes.length > 1 ? 's' : ''}; the latest was ${day(h.disputes[0].created_at)}.`
    : `${x.name} has never disputed a charge${h.reversed.length ? `; ${h.reversed.length} fee reversal in the last 12 months` : ' and had no fee reversals in 12 months'}.`;
  const m = x.txns.find((t) => t.merchant)?.merchant ?? null;
  let second: string;
  if (m) {
    const p = merchantPattern(m.split(' ')[0], x.customerId);
    second = p.otherAlerted || p.otherDisputed
      ? `${m}: ${p.otherAlerted + p.otherDisputed} other customer${p.otherAlerted + p.otherDisputed > 1 ? 's' : ''} raised a fraud alert or dispute in 30 days. Likely a pattern.`
      : `${m}: ${p.transactions} charge${p.transactions === 1 ? '' : 's'} across ${p.customers} customer${p.customers === 1 ? '' : 's'} in 30 days, no other complaints.`;
  } else {
    const a = accountOverview(x.customerId);
    second = `Balance ${a.balance}, ${a.available} available (${a.utilisation}% used)${a.lowCredit ? '; a recent purchase was declined for low credit' : ''}.`;
  }
  const open = h.alerts.filter((a) => a.status === 'open').length;
  const third = open ? `${open} open fraud alert${open > 1 ? 's' : ''} on the account; check it before any change.` : ruleFor(x) ?? 'No open fraud alerts.';
  return [first, second, third];
}

function builtinAnswer(x: Ctx, q: string): { text: string; bullets: string[]; sources: string[]; steps: AgentStep[] } {
  const t = q.toLowerCase();
  if (!x.verified || !x.customerId) {
    return { text: 'The caller is not verified, so the back office can only answer about rules and guidance.', bullets: ruleFor(x) ? [ruleFor(x)!] : [], sources: ['bank_dispute_rules', 'bank_fee_policies'], steps: [{ tool: 'policy_lookup', detail: q.slice(0, 80) }] };
  }
  const id = x.customerId;
  if (/rule|polic|allow|eligib|can we|can i|guidance/.test(t)) {
    const rules = all<{ rule_code: string; reason: string; description: string; max_days_since_txn: number; requires_card_block: number }>('SELECT rule_code, reason, description, max_days_since_txn, requires_card_block FROM bank_dispute_rules WHERE active = 1 ORDER BY reason');
    const fee = all<{ rule_code: string; fee_type: string; reversible: number; description: string }>('SELECT rule_code, fee_type, reversible, description FROM bank_fee_policies WHERE reversible = 1');
    const want = /fee|reversal|waive|late/.test(t) ? 'fee' : 'dispute';
    const bullets = want === 'fee'
      ? fee.map((f) => `${f.rule_code} (${f.fee_type.replace(/_/g, ' ')}): ${f.description}`)
      : rules.map((r) => `${r.rule_code} (${r.reason.replace(/_/g, ' ')}): within ${r.max_days_since_txn} days${r.requires_card_block ? ', card must be blocked first' : ''}. ${r.description}`);
    return { text: want === 'fee' ? 'Fee reversal rules:' : 'Dispute rules that apply:', bullets: bullets.slice(0, 4), sources: [want === 'fee' ? 'bank_fee_policies' : 'bank_dispute_rules'], steps: [{ tool: 'policy_lookup', detail: q.slice(0, 80) }] };
  }
  if (/disput|claim|chargeback/.test(t)) {
    const h = history(id, x.caseId);
    return { text: h.disputes.length ? `${x.name} has ${h.disputes.length} dispute${h.disputes.length > 1 ? 's' : ''} on record.` : `${x.name} has no earlier disputes.`, bullets: h.disputes.slice(0, 3).map((d) => `${d.transaction_id}: ${d.status.replace(/_/g, ' ')} (${day(d.created_at)})`), sources: ['disputes'], steps: [{ tool: 'customer_snapshot', detail: `customer ${id}` }] };
  }
  if (/merchant|pattern|other customer|anyone else|novaplay|citylink|scam/.test(t)) {
    const m = x.txns.find((z) => z.merchant)?.merchant ?? (t.match(/\b(novaplay|citylink)\b/)?.[1]?.toUpperCase() ?? null);
    if (!m) return { text: 'No merchant is linked to this case yet. Ask about a specific merchant by name.', bullets: [], sources: [], steps: [] };
    const p = merchantPattern(m.split(' ')[0], id);
    return { text: `${m} in the last 30 days:`, bullets: [`${p.transactions} charge${p.transactions === 1 ? '' : 's'} across ${p.customers} customer${p.customers === 1 ? '' : 's'}`, `${p.otherAlerted} other customer${p.otherAlerted === 1 ? '' : 's'} with a fraud alert`, `${p.otherDisputed} other customer${p.otherDisputed === 1 ? '' : 's'} disputed it`], sources: ['bank_transactions', 'bank_fraud_alerts', 'disputes'], steps: [{ tool: 'merchant_activity', detail: `merchant ${m}` }] };
  }
  if (/fee|reversal|waive|late/.test(t)) {
    const fees = all<{ fee_type: string; amount_minor: number; charged_at: string; reversed_at: string | null }>('SELECT fee_type, amount_minor, charged_at, reversed_at FROM bank_fees WHERE customer_id = ? ORDER BY charged_at DESC LIMIT 4', [id]);
    const rule = get<{ rule_code: string; description: string }>("SELECT rule_code, description FROM bank_fee_policies WHERE reversible = 1 LIMIT 1");
    return { text: fees.length ? `${fees.length} fee${fees.length > 1 ? 's' : ''} on record.` : 'No fees on record.', bullets: [...fees.map((f) => `${f.fee_type.replace(/_/g, ' ')} ${formatMoney(f.amount_minor)} on ${day(f.charged_at)}${f.reversed_at ? ', reversed' : ''}`), ...(rule ? [`Policy ${rule.rule_code}: ${rule.description}`] : [])], sources: ['bank_fees', 'bank_fee_policies'], steps: [{ tool: 'customer_snapshot', detail: `customer ${id}` }, { tool: 'policy_lookup', detail: 'fee reversal' }] };
  }
  const a = accountOverview(id);
  if (/spend|usage|categor|use the card|shopping/.test(t)) {
    return { text: `${a.usage.last30} spent in the last 30 days over ${a.usage.purchases30} purchases.`, bullets: a.usage.categories.map((c) => `${c.category}: ${c.amount} (${c.count})`), sources: ['bank_transactions'], steps: [{ tool: 'run_sql', detail: 'spend by category, last 90 days' }] };
  }
  return { text: `${x.name}: balance ${a.balance}, ${a.available} available of ${a.limit}.`, bullets: builtinInsights(x), sources: ['bank_transactions', 'bank_payments', 'bank_fees', 'disputes'], steps: [{ tool: 'customer_snapshot', detail: `customer ${id}` }] };
}

/* ------------------------------------------------------------------ public */

const insightCache = new Map<string, { at: number; value: AgentAnswer }>();

export function backOfficeEngine(): string {
  const r = env().AGENT_ENGINE_RESOURCE;
  return r ? `ADK agent on Vertex AI Agent Engine (${r.split('/').pop()})` : 'Built-in answers (ADK agent not connected)';
}

async function run(x: Ctx, userId: string, message: string, builtin: () => { text: string; bullets: string[]; sources: string[]; steps: AgentStep[] }): Promise<AgentAnswer> {
  const t0 = Date.now();
  const resource = env().AGENT_ENGINE_RESOURCE;
  let fallbackReason: string | undefined;
  if (resource) {
    try {
      const out = await askEngine(resource, userId, `${userId}:${x.caseId ?? x.customerId}`, `${contextText(x)}\n\n${message}`);
      const shaped = shapeAnswer(out.text);
      return { mode: 'adk', engine: backOfficeEngine(), text: shaped.text, bullets: shaped.bullets, sources: [...new Set([...shaped.sources, ...out.sources])], steps: out.steps, ms: Date.now() - t0 };
    } catch (e) {
      fallbackReason = (e as Error).name === 'AbortError' ? 'The ADK agent took too long; built-in answer shown.' : 'The ADK agent is unavailable; built-in answer shown.';
      log.warn('back-office agent failed, using built-in answer', { error: (e as Error).message });
    }
  }
  const b = builtin();
  return { mode: 'builtin', engine: 'Built-in answers from the bank records', ...b, ms: Date.now() - t0, fallbackReason };
}

export async function insights(target: { caseId?: string; customerId?: string }, userId: string): Promise<AgentAnswer> {
  const x = contextFor(target);
  const stamp = target.caseId ? get<{ updated_at: string }>('SELECT updated_at FROM cases WHERE id = ?', [target.caseId])?.updated_at ?? '' : '';
  const key = `${target.caseId ?? target.customerId}:${stamp}`;
  const hit = insightCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
  const value = await run(x, userId, 'MODE: INSIGHTS', () => ({ text: '', bullets: builtinInsights(x), sources: ['bank records'], steps: [{ tool: 'customer_snapshot', detail: x.customerId ? `customer ${x.customerId}` : null }] }));
  if (value.bullets.length > 3) value.bullets = value.bullets.slice(0, 3);
  insightCache.set(key, { at: Date.now(), value });
  if (insightCache.size > 200) insightCache.delete(insightCache.keys().next().value!);
  return value;
}

export async function ask(target: { caseId?: string; customerId?: string }, question: string, userId: string): Promise<AgentAnswer> {
  const q = question.trim().slice(0, 500);
  if (q.length < 3) throw new AppError('VALIDATION_FAILED', 'Type a question for the back office.');
  const x = contextFor(target);
  return run(x, userId, `QUESTION: ${q}`, () => builtinAnswer(x, q));
}
