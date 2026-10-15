import { z } from 'zod';
import { existsSync } from 'node:fs';

// Load a local .env (if present) outside tests. Real deployments inject env vars directly.
if (process.env.NODE_ENV !== 'test' && existsSync('.env')) process.loadEnvFile('.env');

/**
 * Environment configuration. All secrets come from the environment, never source.
 * Validated once at startup; invalid configuration fails fast.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('127.0.0.1'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  HIO_DB_PATH: z.string().default('./data/hear-it-once.db'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters').optional(),
  DEMO_MODE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  ADAPTER_MODE: z.string().default('mock'),
  POLICY_PROFILE: z.enum(['prototype-mock', 'pilot-conservative']).default('prototype-mock'),
  INTENT_MODEL: z.enum(['rules', 'anthropic', 'gemini']).default('rules'),
  /** Used when INTENT_MODEL=gemini: reads the full sentence when the keyword rules are unsure. */
  INTENT_GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().optional(),
  ADAPTER_TIMEOUT_MS: z.coerce.number().int().positive().default(1500),
  ACTION_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  ADAPTER_READ_RETRIES: z.coerce.number().int().min(0).max(3).default(1),
  TRANSCRIPT_RETENTION_DAYS: z.coerce.number().int().min(0).default(30),
  /**
   * Live voice (Lily). "gemini" streams audio to Gemini Live on Vertex AI through the server-side
   * bridge; "off" leaves the text fallback only. "scripted" is a test/offline stand-in and is
   * refused outside NODE_ENV=test and DEMO_MODE.
   */
  LIVE_PROVIDER: z.enum(['gemini', 'scripted', 'off']).default('gemini'),
  /** Vertex AI project; on Cloud Run this is picked up from GOOGLE_CLOUD_PROJECT. */
  GOOGLE_CLOUD_PROJECT: z.string().optional(),
  /** Live models are regional; keep this independent of the Cloud Run region. */
  GOOGLE_CLOUD_LOCATION: z.string().default('us-central1'),
  /** One model ID or a comma-separated list, best first. The first one the project can open is used. */
  LIVE_MODEL: z.string().default('gemini-3.8-live,gemini-3.8-live@global,gemini-live-2.5-flash-native-audio'),
  LIVE_VOICE: z.string().default('Aoede'),
});

export type Env = z.infer<typeof EnvSchema> & { SESSION_SECRET: string };

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(Object.fromEntries(Object.entries(source).filter(([, v]) => v !== '')));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const env = parsed.data;
  if (!env.SESSION_SECRET) {
    if (env.NODE_ENV === 'production') throw new Error('SESSION_SECRET is required in production');
    // Development convenience only: a per-process random secret (sessions reset on restart).
    env.SESSION_SECRET = cryptoRandom();
  }
  if (env.NODE_ENV === 'production' && env.DEMO_MODE) {
    throw new Error('DEMO_MODE must be false when NODE_ENV=production');
  }
  return env as Env;
}

function cryptoRandom(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function env(): Env {
  if (!cached) cached = loadEnv();
  return cached;
}

/** Test hook: override configuration. */
export function setEnvForTests(overrides: Partial<Env>): void {
  cached = { ...env(), ...overrides };
}
