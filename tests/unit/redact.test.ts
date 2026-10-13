import { describe, it, expect } from 'vitest';
import { redactText, redactDeep, luhnValid, containsProhibitedCardData, maskPhone } from '../../src/lib/redact.ts';

describe('redaction (FR-13)', () => {
  it('redacts Luhn-valid PANs with separators and keeps only last 4', () => {
    const out = redactText('my card is 4111 1111 1111 1111 thanks');
    expect(out).not.toMatch(/4111 1111 1111 1111/);
    expect(out).toContain('••••1111');
    expect(containsProhibitedCardData(out)).toBe(false);
  });
  it('redacts long digit runs even when not Luhn-valid', () => {
    expect(redactText('number 1234567812345678')).toContain('[REDACTED-CARD?');
  });
  it('redacts CVV phrases', () => {
    const out = redactText('the CVV is 123 and security code: 4567');
    expect(out).not.toMatch(/\b123\b/);
    expect(out).not.toMatch(/4567/);
  });
  it('does not touch ordinary amounts and dates', () => {
    expect(redactText('a charge of $249.00 on 2026-10-10')).toBe('a charge of $249.00 on 2026-10-10');
  });
  it('deep-redacts sensitive keys', () => {
    const out = redactDeep({ otp: '123456', nested: { dob: '1990-01-01', ok: 'fine', authorization: 'Bearer abcdefghijkl' } });
    expect(out).toEqual({ otp: '[REDACTED]', nested: { dob: '[REDACTED]', ok: 'fine', authorization: '[REDACTED]' } });
  });
  it('luhn + phone masking', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(maskPhone('+1 (555) 010-0101')).toBe('•••-•••-0101');
  });
});
