/**
 * The virtual agents. English is the primary language and Lily answers every call. When the caller
 * speaks a language another agent covers, Lily offers that agent and, after a clear yes, the call
 * moves across with everything already known.
 *
 * `live` is what decides whether an agent can actually take a call. Burmese is built — May has a
 * voice, a prompt and a seat in the switch — but it is not good enough to put in front of a customer
 * yet, so it is off and named as an upcoming language instead. It stays in this table rather than
 * being deleted because the work is real and half-finished code that is deleted gets rebuilt from
 * scratch; `live: false` is enforced in one place (`canSwitchTo`) so there is no second opinion
 * about whether it is on.
 */
export const LANGUAGES = {
  en: { name: 'English', native: 'English', agent: 'Lily', voice: 'Aoede', live: true },
  my: { name: 'Burmese', native: 'မြန်မာ', agent: 'May', voice: 'Kore', live: false },
  fil: { name: 'Tagalog (Filipino)', native: 'Tagalog', agent: 'Maya', voice: 'Leda', live: true },
} as const;

export type LangCode = keyof typeof LANGUAGES;
export const isLang = (v: unknown): v is LangCode => typeof v === 'string' && v in LANGUAGES;
export const agentName = (l: LangCode) => LANGUAGES[l].agent;

/** The languages a call can actually move to today. */
export const LIVE_LANGS = (Object.keys(LANGUAGES) as LangCode[]).filter((l) => LANGUAGES[l].live);

/** The ones that are named to customers as coming, but cannot take a call. */
export const UPCOMING_LANGS = (Object.keys(LANGUAGES) as LangCode[]).filter((l) => !LANGUAGES[l].live);

/** May this call move to that agent? The single answer; nothing else decides. */
export const canSwitchTo = (l: LangCode): boolean => LANGUAGES[l].live;

/**
 * What Lily says when someone speaks a language that is coming but not ready. It names the agent, so
 * the customer knows it is a real plan rather than a brush-off, and it offers the thing that does
 * work rather than leaving them with nothing.
 */
export const upcomingReply = (l: LangCode): string =>
  `I'm sorry — ${LANGUAGES[l].agent}, who speaks ${LANGUAGES[l].name}, is not taking calls just yet. We can carry on in English, or I can put you through to a colleague. Which would you prefer?`;
