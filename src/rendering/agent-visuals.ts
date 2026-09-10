/**
 * Genome -> visual property mapping, plus the per-intent state indicators.
 *
 * Documented mapping (also shown in README):
 *   - SIZE  <- genome `strength`     (bigger circle = stronger agent)
 *   - HUE   <- genome `intelligence` (blue = low, yellow = high)
 *   - RING  <- genome `speed`        (thinner inner ring = faster agent)
 *
 * Intent state is drawn as a thin ring around the agent (or, for Rest, a
 * dimmed body) so the behavior is visible at a glance:
 *   - Eat           -> green ring
 *   - Drink         -> blue ring
 *   - SeekPartner   -> pink ring
 *   - Socialize     -> teal ring
 *   - Help          -> light-green ring
 *   - Cooperate     -> violet ring (plus a bond line to the partner)
 *   - Avoid         -> gray ring
 *   - Confront      -> red ring (plus a red flash after a conflict)
 *   - Wander        -> amber dot (moving / exploring) when actively seeking a target
 *   - Rest          -> dimmed body
 *   - SeekFood/SeekWater -> normal body (the resource ring is drawn by the
 *                           moving indicator, and the resource UI shows the target)
 *
 * Group affiliation is an outer dashed ring in the group's color. Group colors
 * are a deterministic function of the group ID (golden-angle hue spacing), so
 * a group keeps its color across frames and distinct groups stay readable.
 *
 * All of these are pure functions of snapshot data, so the same state always
 * renders the same way. Rendering consumes snapshot data only.
 */

import { AgentIntent } from '../simulation-core/ai/intents';

/**
 * Signal indicators (Phase 5): a short-lived flash drawn next to an agent that
 * just emitted a signal, coloured by the TOKEN it used (a deterministic hue
 * from the token id — tokens have no inherent meaning, so the colour only
 * identifies which token was used, never what it "means").
 *
 * The flash uses the same token→hue mapping for every agent, so watching the
 * world shows whether a group has settled on a shared token or different
 * groups keep different vocabularies.
 */
const SIGNAL_FLASH_MIN_RADIUS_TILES = 0.05;
const SIGNAL_FLASH_RADIUS_RANGE_TILES = 0.07;

/** No-signal sentinel (kept in sync with culture/signals.ts). */
const NO_SIGNAL = 255;

/** Radius in tile units at genome strength 0. */
const BASE_RADIUS_TILES = 0.16;
/** Additional radius in tile units at genome strength 1. */
const STRENGTH_RADIUS_RANGE_TILES = 0.24;

/** Hue at genome intelligence 0 (blue). */
const LOW_INTELLIGENCE_HUE = 220;
/** Hue at genome intelligence 1 (yellow). */
const HIGH_INTELLIGENCE_HUE = 55;

const AGENT_SATURATION = 0.65;
const AGENT_LIGHTNESS = 0.55;

/** Ring widths in tile units, from the slowest to the fastest genome speed. */
const SPEED_RING_MIN_WIDTH_TILES = 0.03;
const SPEED_RING_MAX_WIDTH_TILES = 0.14;

const EAT_RING_COLOR = '#7ee06a';
const DRINK_RING_COLOR = '#6ab7e0';
const SEEK_PARTNER_RING_COLOR = '#e08ac9';
const MOVE_MARKER_COLOR = '#e0b050';

// Phase 4 social intent indicators.
const SOCIALIZE_RING_COLOR = '#5fd0c0';
const HELP_RING_COLOR = '#a8e07e';
const COOPERATE_RING_COLOR = '#a68ce0';
const AVOID_RING_COLOR = '#9aa4b2';
const CONFRONT_RING_COLOR = '#e0565f';
const CONFLICT_FLASH_COLOR = 'rgba(224, 86, 95, 0.55)';
const COOPERATION_LINK_COLOR = 'rgba(166, 140, 224, 0.45)';

/** Alpha applied to an agent's body while it is resting (dimmed). */
export const RESTING_ALPHA = 0.55;

export function agentRadiusTiles(strength: number): number {
  const clamped = Math.min(1, Math.max(0, strength));
  return BASE_RADIUS_TILES + clamped * STRENGTH_RADIUS_RANGE_TILES;
}

export function agentColor(intelligence: number): string {
  const clamped = Math.min(1, Math.max(0, intelligence));
  const hue = LOW_INTELLIGENCE_HUE + (HIGH_INTELLIGENCE_HUE - LOW_INTELLIGENCE_HUE) * clamped;
  return `hsl(${hue.toFixed(1)}, ${AGENT_SATURATION * 100}%, ${AGENT_LIGHTNESS * 100}%)`;
}

/**
 * Deterministic group color: hue spaced by the golden angle so consecutive
 * group ids are maximally distinguishable, with fixed saturation/lightness.
 * The same group id always maps to the same color (no per-frame randomness).
 */
export function groupColor(groupId: number): string {
  const hue = (groupId * 137.508) % 360;
  return `hsl(${hue.toFixed(1)}, 70%, 60%)`;
}

/** Ring width (tile units) for a given genome speed. Faster agents get a wider ring. */
export function speedRingWidthTiles(speed: number): number {
  const clamped = Math.min(1, Math.max(0, speed));
  return SPEED_RING_MIN_WIDTH_TILES + clamped * (SPEED_RING_MAX_WIDTH_TILES - SPEED_RING_MIN_WIDTH_TILES);
}

/** True when the agent's intent is Rest (used to dim the body). */
export function isRestingIntent(kind: number): boolean {
  return kind === AgentIntent.Rest;
}

/** Ring color for the given intent kind, or null when no ring should be drawn. */
export function intentIndicatorColor(kind: number): string | null {
  if (kind === AgentIntent.Eat) return EAT_RING_COLOR;
  if (kind === AgentIntent.Drink) return DRINK_RING_COLOR;
  if (kind === AgentIntent.SeekPartner) return SEEK_PARTNER_RING_COLOR;
  if (kind === AgentIntent.Socialize) return SOCIALIZE_RING_COLOR;
  if (kind === AgentIntent.Help) return HELP_RING_COLOR;
  if (kind === AgentIntent.Cooperate) return COOPERATE_RING_COLOR;
  if (kind === AgentIntent.Avoid) return AVOID_RING_COLOR;
  if (kind === AgentIntent.Confront) return CONFRONT_RING_COLOR;
  return null;
}

/** A small dot color shown when the agent is actively moving without a state ring. */
export function moveMarkerColor(kind: number): string | null {
  return kind === AgentIntent.Wander ? MOVE_MARKER_COLOR : null;
}

/** Overlay color for the post-conflict flash, or null when not flashing. */
export function conflictFlashColor(): string | null {
  return CONFLICT_FLASH_COLOR;
}

/**
 * Colour identifying a signal TOKEN (hue spread over the 16 tokens by the
 * golden angle). Deterministic and meaning-free — it says "this agent used
 * Signal_07", nothing more.
 */
export function signalTokenColor(token: number): string {
  const hue = (token * 137.508) % 360;
  return `hsl(${hue.toFixed(1)}, 85%, 62%)`;
}

/** Radius (tile units) of the signal flash marker. */
export function signalFlashRadiusTiles(): number {
  return SIGNAL_FLASH_MIN_RADIUS_TILES + SIGNAL_FLASH_RADIUS_RANGE_TILES;
}

/** True when the snapshot says this agent emitted a signal recently. */
export function isSignalling(token: number, recent: number): boolean {
  return recent === 1 && token !== NO_SIGNAL;
}

/** Line color for the active cooperation bond. */
export function cooperationLinkColor(): string {
  return COOPERATION_LINK_COLOR;
}
