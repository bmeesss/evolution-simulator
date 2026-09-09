/**
 * Genome -> visual property mapping.
 *
 * Documented mapping (also shown in README):
 *   - SIZE  <- genome `strength`     (bigger circle = stronger agent)
 *   - HUE   <- genome `intelligence` (blue = low, yellow = high)
 *
 * Both are pure functions of genome values, so the same genome always renders
 * the same way. Rendering consumes snapshot data only — no simulation imports.
 */

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

export function agentRadiusTiles(strength: number): number {
  const clamped = Math.min(1, Math.max(0, strength));
  return BASE_RADIUS_TILES + clamped * STRENGTH_RADIUS_RANGE_TILES;
}

export function agentColor(intelligence: number): string {
  const clamped = Math.min(1, Math.max(0, intelligence));
  const hue = LOW_INTELLIGENCE_HUE + (HIGH_INTELLIGENCE_HUE - LOW_INTELLIGENCE_HUE) * clamped;
  return `hsl(${hue.toFixed(1)}, ${AGENT_SATURATION * 100}%, ${AGENT_LIGHTNESS * 100}%)`;
}
