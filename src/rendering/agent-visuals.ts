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
 *   - Wander        -> amber dot (moving / exploring) when actively seeking a target
 *   - Rest          -> dimmed body
 *   - SeekFood/SeekWater -> normal body (the resource ring is drawn by the
 *                           moving indicator, and the resource UI shows the target)
 *
 * All of these are pure functions of snapshot data, so the same state always
 * renders the same way. Rendering consumes snapshot data only.
 */

import { AgentIntent } from '../simulation-core/ai/intents';

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
  return null;
}

/** A small dot color shown when the agent is actively moving without a state ring. */
export function moveMarkerColor(kind: number): string | null {
  return kind === AgentIntent.Wander ? MOVE_MARKER_COLOR : null;
}
