/**
 * Cloud Shell check: which Gemini Live model IDs can this project actually open a session with?
 *   GOOGLE_CLOUD_PROJECT=hear-it-once GOOGLE_CLOUD_LOCATION=us-central1 npm run check:live
 * Optional: pass model IDs as arguments to test your own candidates. Uses Application Default Credentials.
 * It opens a real Live session per model (no audio sent) and reports success or the exact error.
 */
import { GoogleGenAI, Modality } from '@google/genai';

const project = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT;
const location = process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1';
if (!project) { console.error('Set GOOGLE_CLOUD_PROJECT first (e.g. export GOOGLE_CLOUD_PROJECT=hear-it-once).'); process.exit(2); }

const candidates = process.argv.slice(2).length ? process.argv.slice(2) : [
  'gemini-3.8-live',
  'gemini-3.1-flash-live-preview',
  'gemini-live-2.5-flash-native-audio',
  'gemini-live-2.5-flash-preview-native-audio-09-2025',
  'gemini-2.5-flash-native-audio-preview-09-2025',
  'gemini-live-2.5-flash',
  'gemini-2.0-flash-live-preview-04-09',
].filter((m, i, a): m is string => !!m && a.indexOf(m) === i);

async function tryModel(model: string, location: string): Promise<string> {
  return new Promise<string>((resolve) => {
    let done = false;
    const finish = (r: string) => { if (!done) { done = true; resolve(r); } };
    const timer = setTimeout(() => finish('TIMEOUT (no setup response in 12s)'), 12000);
    new GoogleGenAI({ vertexai: true, project, location }).live.connect({
      model,
      config: { responseModalities: [Modality.AUDIO] },
      callbacks: {
        onopen: () => {},
        onmessage: (m) => { if (m.setupComplete) { clearTimeout(timer); finish('OK'); } },
        onerror: (e) => { clearTimeout(timer); finish(`ERROR ${String(e?.message ?? e).slice(0, 160)}`); },
        onclose: (e) => { clearTimeout(timer); finish(`CLOSED ${String(e?.reason ?? '').slice(0, 160)}`); },
      },
    }).then((s) => setTimeout(() => s.close(), 500)).catch((e) => { clearTimeout(timer); finish(`ERROR ${String(e?.message ?? e).slice(0, 160)}`); });
  });
}

// Newer models are sometimes served only from the global location, so each model is tried in a few locations.
const locations = [...new Set([location, 'global', 'us-central1'])];
console.log(`Project ${project}\n`);
let first: { model: string; location: string } | null = null;
for (const m of candidates) {
  for (const loc of locations) {
    const r = await tryModel(m, loc);
    console.log(`${r === 'OK' ? '  OK  ' : ' FAIL '} ${m} @ ${loc}${r === 'OK' ? '' : '  → ' + r}`);
    if (r === 'OK' && !first) first = { model: m, location: loc };
    if (r === 'OK') break;
  }
}
console.log(first ? `\nBest working model: ${first.model} in ${first.location}\nUse it:  gcloud run services update hear-it-once --region=asia-southeast1 --update-env-vars=LIVE_MODEL=${first.model},GOOGLE_CLOUD_LOCATION=${first.location}` : '\nNo candidate worked. Check the Vertex AI API is enabled, the location, and the model list in Vertex AI Studio.');
process.exit(first ? 0 : 1);
