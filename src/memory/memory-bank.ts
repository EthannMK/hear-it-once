/**
 * AGENT MEMORY — soft context that survives between calls.
 *
 * What this is for: the small human things a customer should not have to repeat. That they go by
 * Alex rather than Alexander, that they travel a lot, that they raised this merchant last month,
 * that the last call needed a person. It is what makes an assistant feel like it remembers someone.
 *
 * What it is emphatically NOT for: anything a decision rests on. Identity, verification state,
 * card status, balances, limits and eligibility are read from the bank's records on every call,
 * every time. A memory may say "mentioned travelling in December"; it may never say "this caller
 * is verified" — and if one did, it would change nothing, because nothing that authorises an
 * action reads memory at all. authorizeAction in src/policy/engine.ts does not import this file.
 *
 * Three rules hold that line, and none of them live in a prompt:
 *   1. WHAT GOES IN is built here from the call analysis the app already computed, never from free
 *      model output, and every line is checked against DECIDING_FACTS before it is written. A line
 *      that reads like a decision is dropped, not softened.
 *   2. WHAT COMES OUT is untrusted input. A memory is model-written text derived from customer
 *      speech, so it is wrapped like any other record before a model reads it (FP-07).
 *   3. NOTHING SECRET goes in. redactText runs over every line, so a card number, passcode, date
 *      of birth or national id cannot reach the store even if it reached the transcript.
 *
 * The store is Vertex AI Agent Engine Memory Bank on the same engine as the back-office agent. The
 * agent reads its own memories through its own tool; this app only writes and deletes.
 */
import { GoogleAuth } from 'google-auth-library';
import { env } from '../config/env.ts';
import { log } from '../lib/logger.ts';
import { redactText } from '../lib/redact.ts';
import { audit, type Actor } from '../audit/audit.ts';
import { untrusted, UNTRUSTED_PREAMBLE } from '../security/untrusted.ts';

/**
 * Phrases that mean a decision has been made. A memory line matching any of these is dropped: the
 * answer to "is this caller verified" must always come from the verification record, and a stored
 * sentence that looks like that answer is a liability even when it happens to be true today. The
 * bare-number rule is deliberately blunt — amounts, limits and balances all arrive as digits.
 */
const DECIDING_FACTS = [
  /\bverif(y|ied|ication)\b/i,
  /\bauthenticat/i,
  /\bidentity (is|was|confirmed|checked)\b/i,
  /\bpasscode\b|\botp\b/i,
  /\bcard (is |was )?(active|blocked|frozen|cancelled|closed)\b/i,
  /\bbalance\b|\bavailable credit\b|\bcredit limit\b|\blimit is\b/i,
  /\beligib/i,
  /\bapproved\b|\bauthorised\b|\bauthorized\b/i,
  /\bentitled to\b|\ballowed to\b|\bpermitted\b/i,
  /\$\s?\d/,
  /\b\d{3,}\b/,
];

export const isDecidingFact = (line: string): boolean => DECIDING_FACTS.some((r) => r.test(line));

/** The store seam, so tests can stand in for Vertex exactly as the back office does. */
export interface MemoryStore {
  write(scope: string, lines: string[]): Promise<void>;
  list(scope: string): Promise<string[]>;
  deleteAll(scope: string): Promise<number>;
}

let stub: MemoryStore | null = null;
export function setMemoryStoreForTests(s: MemoryStore | null): void { stub = s; }

let auth: GoogleAuth | null = null;

function engineBase(): string | null {
  const r = env().AGENT_ENGINE_RESOURCE;
  if (!r) return null;
  const location = r.split('/')[3];
  return `https://${location}-aiplatform.googleapis.com/v1/${r}`;
}

async function callMemory(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  auth ??= new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const token = await auth.getAccessToken();
  const res = await fetch(url, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
  const text = await res.text();
  if (!res.ok) throw new Error(`memory bank ${res.status}: ${text.slice(0, 200)}`);
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

/** The live store. Memories are scoped to one customer, never to a session, a card or a case. */
const vertexStore: MemoryStore = {
  async write(scope, lines) {
    const base = engineBase();
    if (!base) return;
    for (const fact of lines) {
      await callMemory(`${base}/memories`, { method: 'POST', body: JSON.stringify({ fact, scope: { customer_id: scope } }) });
    }
  },
  async list(scope) {
    const base = engineBase();
    if (!base) return [];
    const r = await callMemory(`${base}/memories?filter=${encodeURIComponent(`scope.customer_id="${scope}"`)}`, { method: 'GET' });
    const items = (r.memories as { fact?: string }[] | undefined) ?? [];
    return items.map((m) => String(m.fact ?? '')).filter(Boolean);
  },
  async deleteAll(scope) {
    const base = engineBase();
    if (!base) return 0;
    const r = await callMemory(`${base}/memories?filter=${encodeURIComponent(`scope.customer_id="${scope}"`)}`, { method: 'GET' });
    const items = (r.memories as { name?: string }[] | undefined) ?? [];
    const host = base.split('/v1/')[0];
    let n = 0;
    for (const m of items) {
      if (!m.name) continue;
      await callMemory(`${host}/v1/${m.name}`, { method: 'DELETE' });
      n += 1;
    }
    return n;
  },
};

const store = (): MemoryStore => stub ?? vertexStore;

export interface CallMemoryInput {
  reasonLabel: string | null;
  resolution: string | null;
  merchants?: string[];
}

/**
 * Turn one finished call into at most a few soft lines. Everything comes from the analysis the app
 * already built, each line is redacted, and anything that reads like a decision is dropped. A call
 * with nothing worth keeping writes nothing.
 */
export function linesFromCall(a: CallMemoryInput): string[] {
  const out: string[] = [];
  if (a.reasonLabel) out.push(`Last call was about: ${a.reasonLabel}.`);
  if (a.resolution === 'escalated') out.push('Last call needed a person rather than finishing with the assistant.');
  else if (a.resolution === 'resolved') out.push('Last call finished without needing a person.');
  for (const m of (a.merchants ?? []).slice(0, 2)) out.push(`Has raised the merchant ${m} before.`);
  return out.map(redactText).filter((l) => !isDecidingFact(l));
}

/**
 * Remember what is worth remembering from a finished call. Never throws: a memory is a nicety and
 * must not be able to fail a call's analysis or its record.
 */
export async function rememberFromCall(customerId: string | null, a: CallMemoryInput, actor: Actor): Promise<number> {
  if (!customerId) return 0;
  const lines = linesFromCall(a);
  if (!lines.length) return 0;
  try {
    await store().write(customerId, lines);
    audit({ actor, event: 'memory.written', status: 'ok', resourceType: 'customer', resourceId: customerId, metadata: { lines: lines.length } });
    return lines.length;
  } catch (e) {
    log.warn('memory.write_failed', { customerId, err: (e as Error).message });
    audit({ actor, event: 'memory.written', status: 'failed', resourceType: 'customer', resourceId: customerId, metadata: { lines: lines.length } });
    return 0;
  }
}

/**
 * What a model may see, wrapped. A memory is model-written text derived from customer speech, so it
 * is quoted as data under the untrusted preamble exactly as a merchant name or a stored note is.
 */
export async function memoryContext(customerId: string | null): Promise<string> {
  if (!customerId) return '';
  try {
    const lines = await store().list(customerId);
    if (!lines.length) return '';
    // The preamble travels with the block. This text may reach a model on its own, through the
    // agent's own memory tool, so it cannot rely on some other caller having said it already.
    return `${UNTRUSTED_PREAMBLE}\n${untrusted('remembered_context', lines.map((l) => `- ${l}`).join('\n'))}`;
  } catch (e) {
    log.warn('memory.read_failed', { customerId, err: (e as Error).message });
    return '';
  }
}

/** A customer must be forgettable. Audited, because erasing a record is itself a record. */
export async function forgetCustomer(customerId: string, actor: Actor): Promise<number> {
  const n = await store().deleteAll(customerId);
  audit({ actor, event: 'memory.forgotten', status: 'ok', resourceType: 'customer', resourceId: customerId, metadata: { deleted: n } });
  return n;
}
