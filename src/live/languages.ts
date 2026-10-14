/** Languages Lily can speak and write. The judge picks one on the customer page. */
export const LANGUAGES = {
  en: { name: 'English', native: 'English' },
  my: { name: 'Burmese', native: 'မြန်မာ' },
  fil: { name: 'Tagalog (Filipino)', native: 'Tagalog' },
} as const;

export type LangCode = keyof typeof LANGUAGES;
export const isLang = (v: unknown): v is LangCode => typeof v === 'string' && v in LANGUAGES;
