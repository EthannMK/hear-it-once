/**
 * Structured, privacy-safe logger. Every record passes through redactDeep, so secrets,
 * card data and verification answers cannot reach log output.
 */
import { redactDeep } from './redact.ts';

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60, silent: 100 } as const;
type Level = keyof typeof LEVELS;

let threshold: number = LEVELS[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? LEVELS.info;
const sink: { write: (line: string) => void } = { write: (l) => process.stdout.write(l + '\n') };

export function setLogLevel(level: Level): void {
  threshold = LEVELS[level];
}
export function setLogSink(fn: (line: string) => void): void {
  sink.write = fn;
}

function emit(level: Exclude<Level, 'silent'>, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const rec = { ts: new Date().toISOString(), level, msg, ...(fields ? redactDeep(fields) : {}) };
  sink.write(JSON.stringify(rec));
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => emit('debug', m, f),
  info: (m: string, f?: Record<string, unknown>) => emit('info', m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit('warn', m, f),
  error: (m: string, f?: Record<string, unknown>) => emit('error', m, f),
};
