/** Injectable clock so tests can control time deterministically. */
let offsetMs = 0;
let fixed: number | null = null;

export function nowMs(): number {
  return fixed ?? Date.now() + offsetMs;
}
export function now(): Date {
  return new Date(nowMs());
}
export function nowIso(): string {
  return now().toISOString();
}
export function advanceClock(ms: number): void {
  if (fixed !== null) fixed += ms;
  else offsetMs += ms;
}
export function freezeClock(at: Date | null): void {
  fixed = at ? at.getTime() : null;
}
export function resetClock(): void {
  fixed = null;
  offsetMs = 0;
}
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
