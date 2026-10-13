/**
 * Repository hygiene check (npm run check:secrets): fails if tracked source contains apparent
 * secrets or prohibited card data. Skips node_modules, data/, .env and binary files.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { containsProhibitedCardData } from '../src/lib/redact.ts';

const ROOT = process.cwd();
const SKIP = new Set(['node_modules', 'data', '.git', 'coverage']);
const SKIP_FILES = new Set(['.env', 'package-lock.json']);
const PATTERNS: [string, RegExp][] = [
  ['Anthropic/OpenAI-style API key', /\bsk-(ant-)?[A-Za-z0-9_-]{20,}/],
  ['Private key block', /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Hard-coded session secret', /SESSION_SECRET\s*=\s*(?!replace-with|test-only)[A-Za-z0-9]{24,}/],
];
// Test fixtures intentionally contain well-known TEST card numbers to prove redaction works.
const ALLOW_CARD_DATA = /^tests\/|^scripts\/(debug-|check-secrets)/;

const findings: string[] = [];
function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || SKIP_FILES.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (/\.(ts|js|mjs|json|md|sql|html|css|example|txt|ya?ml)$/.test(name) || name.startsWith('.env')) {
      const rel = relative(ROOT, p);
      const text = readFileSync(p, 'utf8');
      for (const [label, re] of PATTERNS) if (re.test(text)) findings.push(`${rel}: ${label}`);
      if (!ALLOW_CARD_DATA.test(rel) && containsProhibitedCardData(text)) findings.push(`${rel}: possible full card number / CVV`);
    }
  }
}
walk(ROOT);
if (findings.length) {
  console.error('Secret/card-data check FAILED:\n' + findings.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
console.log('Secret/card-data check passed: no secrets or prohibited card data found in source.');
