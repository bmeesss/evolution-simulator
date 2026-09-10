/**
 * Signal tokens and meanings — the alphabet of Phase 5 proto-communication.
 *
 * WHAT THIS IS: a fixed alphabet of sixteen arbitrary tokens
 * (`Signal_01` … `Signal_16`) and a fixed set of five contexts an agent can
 * ground a signal in (food / water / danger / follow / help). This is
 * PROTO-COMMUNICATION SCAFFOLDING, not human language: there is no grammar, no
 * syntax, no words, no phonology and no consciousness anywhere in the model.
 * Tokens are meaningless integers — they acquire meaning ONLY through an
 * individual agent's repeated association of a token with an observed context
 * (see `signal-store.ts` and `simulation/systems/signal-system.ts`).
 *
 * WHY a fixed alphabet: it keeps signals compact (one byte), it makes
 * "meaning" a measurable learned state instead of generated text, and it makes
 * conventions comparable between groups (two groups can use different tokens
 * for the same context — that difference IS cultural divergence).
 *
 * WHY the tokens are not labelled by meaning here: any mapping of token to
 * meaning lives in per-agent state, never in this file. The names below are
 * UI/debug labels only, and `Signal_01` is deliberately as arbitrary as
 * `Signal_16` — nothing in the simulation treats token 0 as "the food token".
 *
 * Values are stable and save-format relevant: never renumber tokens or meanings
 * without bumping SAVE_FORMAT_VERSION.
 */

/** Number of discrete signal tokens in the alphabet. */
export const SIGNAL_TOKEN_COUNT = 16;

/** Special token value meaning "no signal" (stored in the component store). */
export const NO_SIGNAL_TOKEN = 255;

/** Contexts a signal can be grounded in. Meanings are NOT assigned to tokens. */
export const SignalMeaning = {
  /** Something edible where the emitter is / is pointing. */
  Food: 0,
  /** Something drinkable. */
  Water: 1,
  /** A threat: a hostile neighbour, a recent conflict, an active avoidance. */
  Danger: 2,
  /** "Come with me / let us go somewhere." */
  Follow: 3,
  /** "I need help" (low health or exhausted emitter). */
  Help: 4,
} as const;

export type SignalMeaning = (typeof SignalMeaning)[keyof typeof SignalMeaning];

/** Number of meanings a token can be associated with. */
export const SIGNAL_MEANING_COUNT = 5;

/** Sentinel for "no association / unknown meaning". */
export const SIGNAL_MEANING_UNKNOWN = -1;

const MEANING_NAMES: readonly string[] = ['FOOD', 'WATER', 'DANGER', 'FOLLOW', 'HELP'];

/** Human-readable meaning name (UI only). */
export function signalMeaningName(meaning: number): string {
  return MEANING_NAMES[meaning] ?? 'UNKNOWN';
}

/**
 * Canonical token label: `Signal_01` … `Signal_16`. Two decimal digits, so the
 * labels sort consistently in the UI and the event feed.
 */
export function signalTokenName(token: number): string {
  if (token < 0 || token >= SIGNAL_TOKEN_COUNT) return 'Signal_??';
  return `Signal_${token < 10 ? '0' : ''}${token + 1}`;
}

/**
 * Display form of one learned association, e.g. `Signal_04 → FOOD`. Used by the
 * inspector and by `signal_learned` event details so the UI can show what an
 * agent actually came to believe, without the simulation ever storing a string.
 */
export function describeAssociation(token: number, meaning: number): string {
  return `${signalTokenName(token)} → ${signalMeaningName(meaning)}`;
}
