import { randomBytes, randomUUID, createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** Prefixed, unguessable identifiers (e.g. CASE-7F3K9Q2M). */
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export function newId(prefix: string, len = 10): string {
  const bytes = randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return `${prefix}-${s}`;
}
export const newUuid = () => randomUUID();
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const hmac = (secret: string, s: string) => createHmac('sha256', secret).update(s).digest('hex');
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
/** Stable hash of a JSON-able value (key-order independent) for idempotency comparisons. */
export function stableHash(value: unknown): string {
  return sha256(stableStringify(value));
}
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}
export function randomDigits(n: number): string {
  const b = randomBytes(n);
  return Array.from(b, (x) => String(x % 10)).join('');
}
