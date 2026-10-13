/**
 * Timeouts, bounded retries and circuit breakers for integration calls.
 * Reads may be retried; writes are never retried here (see actions/action-service.ts).
 */

export class TimeoutError extends Error {
  constructor(readonly afterMs: number) {
    super(`Timed out after ${afterMs} ms`);
  }
}
export class CircuitOpenError extends Error {
  constructor(readonly key: string) {
    super(`Circuit open for ${key}`);
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
    }),
  ]);
}

export async function withRetries<T>(
  fn: (attempt: number) => Promise<T>,
  opts: { retries: number; baseDelayMs?: number; retryOn?: (e: unknown) => boolean },
): Promise<{ value: T; attempts: number }> {
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      return { value: await fn(attempt), attempts: attempt };
    } catch (e) {
      const retryable = opts.retryOn ? opts.retryOn(e) : true;
      if (!retryable || attempt > opts.retries) {
        (e as { attempts?: number }).attempts = attempt;
        throw e;
      }
      await new Promise((r) => setTimeout(r, (opts.baseDelayMs ?? 25) * attempt));
    }
  }
}

interface BreakerState {
  failures: number;
  openedAt: number | null;
}

/** Minimal consecutive-failure circuit breaker with half-open probe after cooldown. */
export class CircuitBreakerRegistry {
  private states = new Map<string, BreakerState>();
  constructor(private cfg: () => { failureThreshold: number; cooldownMs: number }, private clock: () => number = Date.now) {}

  state(key: string): 'closed' | 'open' | 'half_open' {
    const s = this.states.get(key);
    if (!s || s.openedAt === null) return 'closed';
    return this.clock() - s.openedAt >= this.cfg().cooldownMs ? 'half_open' : 'open';
  }

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.state(key) === 'open') throw new CircuitOpenError(key);
    try {
      const v = await fn();
      this.states.set(key, { failures: 0, openedAt: null });
      return v;
    } catch (e) {
      const s = this.states.get(key) ?? { failures: 0, openedAt: null };
      s.failures++;
      if (s.failures >= this.cfg().failureThreshold || s.openedAt !== null) s.openedAt = this.clock();
      this.states.set(key, s);
      throw e;
    }
  }

  reset(): void {
    this.states.clear();
  }
}
