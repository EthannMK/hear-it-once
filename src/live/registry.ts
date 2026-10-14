/**
 * Chooses and describes the live voice provider from server-side configuration. Availability is
 * reported honestly: if Vertex AI is not configured the browser is told why and offers the text
 * fallback; a successful connection is never simulated.
 */
import { env } from '../config/env.ts';
import { log } from '../lib/logger.ts';
import { GeminiLiveProvider } from './gemini.ts';
import { ScriptedProvider } from './scripted.ts';
import type { LiveAvailability, LiveProvider } from './provider.ts';

let projectCache: string | null | undefined;

/** Project id from configuration, else from the Cloud Run / GCE metadata server (1 s timeout). */
export async function resolveProject(): Promise<string | null> {
  const configured = env().GOOGLE_CLOUD_PROJECT;
  if (configured) return configured;
  if (projectCache !== undefined) return projectCache;
  try {
    const r = await fetch('http://metadata.google.internal/computeMetadata/v1/project/project-id', { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(1000) });
    projectCache = r.ok ? (await r.text()).trim() || null : null;
  } catch {
    projectCache = null;
  }
  return projectCache;
}

export async function liveAvailability(): Promise<LiveAvailability> {
  const e = env();
  if (e.LIVE_PROVIDER === 'off') return { available: false, provider: 'none', model: null, location: null, reason: 'Live voice is switched off in this deployment. You can talk to Lily by typing.' };
  if (e.LIVE_PROVIDER === 'scripted') {
    if (e.NODE_ENV !== 'test') return { available: false, provider: 'scripted', model: null, location: null, reason: 'The scripted voice stand-in only runs in automated tests.' };
    return { available: true, provider: 'scripted-test', model: 'scripted', location: null, reason: null };
  }
  const project = await resolveProject();
  if (!project) return { available: false, provider: 'gemini-live-vertex', model: e.LIVE_MODEL, location: e.GOOGLE_CLOUD_LOCATION, reason: 'Live voice is not configured on the server (no Google Cloud project). You can talk to Lily by typing.' };
  return { available: true, provider: 'gemini-live-vertex', model: e.LIVE_MODEL, location: e.GOOGLE_CLOUD_LOCATION, reason: null };
}

let override: LiveProvider | null = null;
/** Test hook. */
export function setLiveProviderForTests(p: LiveProvider | null): void {
  override = p;
}

export async function createLiveProvider(): Promise<LiveProvider> {
  if (override) return override;
  const e = env();
  if (e.LIVE_PROVIDER === 'scripted') return new ScriptedProvider();
  if (e.LIVE_PROVIDER === 'gemini') {
    const project = await resolveProject();
    if (!project) throw new Error('GOOGLE_CLOUD_PROJECT is not set');
    if (!e.GOOGLE_CLOUD_PROJECT) process.env.GOOGLE_CLOUD_PROJECT = project;
    log.info('creating Gemini Live provider', { project, location: e.GOOGLE_CLOUD_LOCATION, model: e.LIVE_MODEL });
    return new GeminiLiveProvider(project);
  }
  throw new Error('Live voice is switched off');
}
