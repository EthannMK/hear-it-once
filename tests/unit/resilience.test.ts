import { describe, it, expect } from 'vitest';
import { withTimeout, withRetries, CircuitBreakerRegistry, TimeoutError, CircuitOpenError } from '../../src/lib/resilience.ts';

describe('resilience primitives', () => {
  it('times out slow promises', async () => {
    await expect(withTimeout(new Promise((r) => setTimeout(r, 200)), 20)).rejects.toBeInstanceOf(TimeoutError);
  });
  it('retries a bounded number of times', async () => {
    let n = 0;
    await expect(withRetries(async () => { n++; throw new Error('x'); }, { retries: 2, baseDelayMs: 1 })).rejects.toThrow('x');
    expect(n).toBe(3);
  });
  it('does not retry when retryOn says no', async () => {
    let n = 0;
    await expect(withRetries(async () => { n++; throw new Error('no'); }, { retries: 3, baseDelayMs: 1, retryOn: () => false })).rejects.toThrow();
    expect(n).toBe(1);
  });
  it('opens the circuit after the threshold and half-opens after cooldown', async () => {
    let t = 0;
    const cb = new CircuitBreakerRegistry(() => ({ failureThreshold: 2, cooldownMs: 100 }), () => t);
    const fail = () => cb.run('k', async () => { throw new Error('down'); });
    await expect(fail()).rejects.toThrow('down');
    await expect(fail()).rejects.toThrow('down');
    await expect(fail()).rejects.toBeInstanceOf(CircuitOpenError);
    t = 150;
    expect(cb.state('k')).toBe('half_open');
    await expect(cb.run('k', async () => 'ok')).resolves.toBe('ok');
    expect(cb.state('k')).toBe('closed');
  });
});
