/**
 * Considerations — the reusable primitives the Utility AI multiplies together
 * to score each candidate action.
 *
 * A "consideration" maps some observable fact (hunger, distance, remembered
 * value…) to a bounded [0, 1] number, always via the curve functions in
 * `utility/curves.ts`. All tuning constants come from `SimulationConfig`, so
 * no behavior constants are scattered through the action code. Each function
 * documents *why* it is shaped the way it is.
 */

import type { SimulationConfig } from '../../simulation';
import { clamp01, inverseQuadratic, quadratic } from '../utility';

/**
 * How much an agent wants to eat given its hunger (0..100).
 *
 * WHY quadratic from a seek threshold up to the critical threshold: agents
 * should tolerate mild hunger (wandering, exploring) and only become single-
 * minded as starvation approaches. Below `seekFoodNeedThreshold` the urge is
 * zero (not worth interrupting other activity); at the critical threshold it
 * saturates to 1 (health starts failing).
 */
export function hungerUrgency(hunger: number, config: SimulationConfig): number {
  const { seekFoodNeedThreshold } = config.ai;
  const { criticalNeedThreshold } = config.needs;
  if (hunger <= seekFoodNeedThreshold) return 0;
  const span = criticalNeedThreshold - seekFoodNeedThreshold;
  if (span <= 0) return 1;
  return quadratic(clamp01((hunger - seekFoodNeedThreshold) / span));
}

/** Mirror of `hungerUrgency` for thirst. */
export function thirstUrgency(thirst: number, config: SimulationConfig): number {
  const { seekWaterNeedThreshold } = config.ai;
  const { criticalNeedThreshold } = config.needs;
  if (thirst <= seekWaterNeedThreshold) return 0;
  const span = criticalNeedThreshold - seekWaterNeedThreshold;
  if (span <= 0) return 1;
  return quadratic(clamp01((thirst - seekWaterNeedThreshold) / span));
}

/**
 * How much an agent needs to rest given its energy (0..100).
 *
 * WHY quadratic over the wake→rest band: energy has to drop meaningfully below
 * the wake threshold before resting wins, and the urge saturates (1) once
 * energy reaches the rest threshold — giving a decisive "must sleep now"
 * signal instead of a slow fade. Using the existing needs thresholds keeps
 * rest hysteresis consistent between the AI and the needs system.
 */
export function fatigueUrgency(energy: number, config: SimulationConfig): number {
  const { restEnergyThreshold, wakeEnergyThreshold } = config.needs;
  if (energy >= wakeEnergyThreshold) return 0;
  const span = wakeEnergyThreshold - restEnergyThreshold;
  if (span <= 0) return 1;
  return quadratic(clamp01((wakeEnergyThreshold - energy) / span));
}

/**
 * How attractive a resource *amount* is (food/water are normalized 0..1).
 *
 * WHY quadratic: an agent prefers a rich tile over a barely-usable one —
 * heading for 0.9 food is much better than 0.05 — so the quality curve grows
 * faster than linearly, while still being bounded to [0, 1].
 */
export function resourceQuality(amount: number): number {
  return quadratic(clamp01(amount));
}

/**
 * Reachability from distance: 1 at distance 0, falling to 0 at `radius`.
 *
 * WHY inverse-quadratic: nearby targets all score similarly high (an agent a
 * tile or two from food shouldn't reroute for a marginal gain), but distant
 * targets drop off sharply. This reduces pointless path changes — a form of
 * spatial hysteresis that complements the action-level commitment.
 */
export function distanceFactor(distance: number, radius: number): number {
  if (radius <= 0) return distance <= 0 ? 1 : 0;
  return inverseQuadratic(clamp01(distance / radius));
}

/**
 * Same reachability curve as `distanceFactor`, but from squared distance —
 * used by the AI candidate loop to avoid a sqrt per candidate (the ordering is
 * identical; the exact values differ slightly because the curve is applied to
 * the squared ratio).
 */
export function distanceFactorSquared(distanceSquared: number, radiusSquared: number): number {
  if (radiusSquared <= 0) return distanceSquared <= 0 ? 1 : 0;
  return inverseQuadratic(clamp01(distanceSquared / radiusSquared));
}

/**
 * How uncertain an agent is about the world's resources, from the average
 * remembered value of its memory (0 = no memory → fully uncertain → explore;
 * 1 = rich, trusted memories → exploit). Feeds the Wander/Explore action so
 * agents with weak knowledge explore more than agents with strong knowledge.
 */
export function explorationUncertainty(averageMemoryValue: number): number {
  return clamp01(1 - averageMemoryValue);
}
