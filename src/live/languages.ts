/**
 * The three virtual agents. English is the primary language and Lily answers every call. When the
 * caller speaks Burmese or Tagalog, Lily offers the matching agent and, after a clear yes, the call
 * moves to that agent with everything already known carried across.
 */
export const LANGUAGES = {
  en: { name: 'English', native: 'English', agent: 'Lily', voice: 'Aoede' },
  my: { name: 'Burmese', native: 'မြန်မာ', agent: 'Hnin', voice: 'Kore' },
  fil: { name: 'Tagalog (Filipino)', native: 'Tagalog', agent: 'Maya', voice: 'Leda' },
} as const;

export type LangCode = keyof typeof LANGUAGES;
export const isLang = (v: unknown): v is LangCode => typeof v === 'string' && v in LANGUAGES;
export const agentName = (l: LangCode) => LANGUAGES[l].agent;
