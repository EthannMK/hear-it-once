/**
 * Redaction and masking. Applied to transcripts, case summaries, audit metadata,
 * integration-call records and logs. FR-13: full card numbers and CVV/CVC must never be
 * stored or shown.
 */

const PAN_CANDIDATE = /\b(?:\d[ -]?){12,18}\d\b/g;
const CVV_PHRASE = /\b(cvv2?|cvc2?|cid|security\s*code|card\s*verification(?:\s*(?:value|code))?|3[- ]digit\s*code)\b[^0-9]{0,20}(\d{3,4})\b/gi;
const BEARER = /\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const API_KEY = /\b(sk-[A-Za-z0-9_-]{10,}|sk-ant-[A-Za-z0-9_-]{10,})\b/g;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/**
 * Redact free text. Any 13–19 digit sequence is treated as a potential PAN (Luhn-valid or
 * not: we prefer over-redaction of long digit runs to leaking a PAN).
 */
export function redactText(input: string): string {
  if (!input) return input;
  let out = input.replace(CVV_PHRASE, (_m, label: string) => `${label} [REDACTED-CVV]`);
  out = out.replace(PAN_CANDIDATE, (m) => {
    const digits = m.replace(/[ -]/g, '');
    if (digits.length < 13 || digits.length > 19) return m;
    return `[REDACTED-CARD${luhnValid(digits) ? '' : '?'} ••••${digits.slice(-4)}]`;
  });
  out = out.replace(BEARER, '$1 [REDACTED-TOKEN]');
  out = out.replace(API_KEY, '[REDACTED-KEY]');
  out = out.replace(EMAIL, (m) => maskEmail(m));
  return out;
}

const SENSITIVE_KEYS = /^(password|pass|secret|token|otp|code_hash|otp_code|cvv|cvc|cvv2|pan|card_number|cardnumber|dob|date_of_birth|dateofbirth|authorization|cookie|set-cookie|api_key|apikey|anthropic_api_key|session_secret)$/i;

/** Deep-redact a structure for safe persistence in audit/integration records and logs. */
export function redactDeep<T>(value: T, depth = 0): T {
  if (depth > 8) return '[TRUNCATED]' as unknown as T;
  if (typeof value === 'string') return redactText(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.test(k) ? '[REDACTED]' : redactDeep(v, depth + 1);
    }
    return out as T;
  }
  return value;
}

export const maskLast4 = (last4: string) => `•••• ${last4}`;

export function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  if (!domain) return '[REDACTED-EMAIL]';
  return `${user.slice(0, 1)}•••@${domain}`;
}

export function maskPhone(phone: string): string {
  const d = phone.replace(/\D/g, '');
  return d.length >= 4 ? `•••-•••-${d.slice(-4)}` : '•••';
}

/** First name + initial, for staff views that need recognisable but minimised names. */
export function minimiseName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length < 2) return parts[0] ?? '';
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

/** Throw if text contains an apparent full PAN. Used by tests and as a write guard. */
export function containsProhibitedCardData(text: string): boolean {
  for (const m of text.matchAll(PAN_CANDIDATE)) {
    const digits = m[0].replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) return true;
  }
  CVV_PHRASE.lastIndex = 0;
  return CVV_PHRASE.test(text);
}
