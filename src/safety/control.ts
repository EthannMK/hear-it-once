/**
 * THE OFF SWITCH.
 *
 * Someone has to be able to stop the assistant in the middle of a working day without a deploy, a
 * code change or a restart, and without taking the phone line down with it. Three positions:
 *
 *   normal           The assistant works as built.
 *   actions_paused   The assistant still answers and still looks things up, but it changes nothing.
 *                    Anything that would block a card, order a replacement, file a dispute or
 *                    reverse a fee goes to a person instead. Use this when something it does is
 *                    wrong but talking to it is still better than a queue.
 *   assistant_off    The assistant does not take calls. Every caller goes straight to a person.
 *
 * Two things make this worth having rather than a flag in the UI:
 *
 * It is enforced where the decision is made, not where it is displayed. `authorizeAction` refuses
 * on a paused switch before any eligibility rule is read, so nothing the caller says, nothing a
 * model returns and no request shaped to look like an agent's can get an action through — the same
 * reason verification and consent are checked there.
 *
 * It fails to the safe side. A switch position that cannot be read as one of the three is treated as
 * `assistant_off`, because a control that quietly reverts to "on" when its own storage is damaged is
 * not a control.
 *
 * Every change records who made it, when and why, in the audit log and as a timeline entry on the
 * calls it affects.
 */
import { get, run } from '../db/db.ts';
import { nowIso } from '../lib/clock.ts';
import { audit, type Actor } from '../audit/audit.ts';
import { log } from '../lib/logger.ts';

export type SafetyMode = 'normal' | 'actions_paused' | 'assistant_off';

const MODES: SafetyMode[] = ['normal', 'actions_paused', 'assistant_off'];
const SETTING = 'safety_mode';

export interface SafetyState {
  mode: SafetyMode;
  /** Why it was put here. Recorded so the next shift does not have to guess. */
  reason: string | null;
  changedBy: string | null;
  changedAt: string | null;
  /** True when the stored value could not be read and the switch defaulted to off. */
  degraded?: true;
}

const NORMAL: SafetyState = { mode: 'normal', reason: null, changedBy: null, changedAt: null };

export function safetyState(): SafetyState {
  const raw = get<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', [SETTING])?.value;
  if (raw === undefined) return NORMAL; // never set: the assistant is on, which is the initial state
  try {
    const s = JSON.parse(raw) as SafetyState;
    if (!MODES.includes(s?.mode)) throw new Error(`unknown mode ${String(s?.mode)}`);
    return { mode: s.mode, reason: s.reason ?? null, changedBy: s.changedBy ?? null, changedAt: s.changedAt ?? null };
  } catch (err) {
    // Something wrote a value we cannot read. Stopping is the only safe reading of that.
    log.error('the safety switch could not be read; treating it as off', { error: (err as Error).message });
    return { mode: 'assistant_off', reason: 'The safety switch could not be read, so the assistant is off until someone sets it.', changedBy: null, changedAt: null, degraded: true };
  }
}

/** May the assistant carry out banking actions? False on a paused or off switch. */
export const assistantMayAct = (): boolean => safetyState().mode === 'normal';

/** May the assistant take calls at all? False only when it is switched off. */
export const assistantMayHandleCalls = (): boolean => safetyState().mode !== 'assistant_off';

/** What a caller is told when the switch is off. Plain, and it does not blame the customer. */
export const OFF_MESSAGE =
  'Hello, you’re through to Northstar Bank. Our automated assistant isn’t taking calls at the moment, so I’m putting you straight to one of our team. Please hold for a moment.';

/** What goes in the case when an action is refused because the switch is thrown. */
export const PAUSED_DETAIL = 'the assistant is not making changes at the moment (safety switch), so this goes to a person';

export function setSafetyMode(mode: SafetyMode, reason: string, actor: Actor): SafetyState {
  const state: SafetyState = { mode, reason: reason.trim().slice(0, 300) || null, changedBy: actor.id, changedAt: nowIso() };
  run('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [SETTING, JSON.stringify(state)]);
  audit({
    actor,
    event: mode === 'normal' ? 'safety.switch_cleared' : 'safety.switch_thrown',
    status: 'ok',
    metadata: { mode, reason: state.reason },
  });
  log.warn('safety switch changed', { mode, by: actor.id, reason: state.reason });
  return state;
}

/** How each position reads on the safety page and in the agent console. */
export function describeMode(mode: SafetyMode): string {
  switch (mode) {
    case 'normal':
      return 'The assistant is answering calls and may carry out the actions it is allowed to.';
    case 'actions_paused':
      return 'The assistant is answering calls and looking things up, but it is changing nothing. Anything that would alter an account goes to a person.';
    case 'assistant_off':
      return 'The assistant is not taking calls. Every caller goes straight to a person.';
  }
}
