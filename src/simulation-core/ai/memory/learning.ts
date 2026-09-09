/**
 * Lightweight associative learning — how remembered resource values change.
 *
 * No neural networks, no LLMs, no evolutionary algorithms: just bounded,
 * deterministic updates that make memory useful without making intelligence
 * automatically dominant (the energetic cost of intelligence arrives in a
 * later phase; here it only shapes *how fast* an agent learns and forgets).
 *
 * The model (each value stays in [0, 1]):
 *   - reinforce(value, rate):  value += rate * (1 - value)   (success → closer
 *     to "definitely useful")
 *   - punish(value, rate):     value -= rate * value          (depletion →
 *     closer to "useless")
 *   - decay(value, perTick):   value *= (1 - perTick)         (forgetting)
 *
 * Intelligence influence (documented formula — kept moderate so intelligence
 * 0 vs 1 is a difference in *pace*, not in outcome):
 *   effectiveLearningRate = baseLearningRate * (1 + intelligence *
 *                           intelligenceLearningFactor)
 *   effectiveDecayPerHour = baseDecayPerHour * (1 - intelligence *
 *                           intelligenceRetentionFactor)
 *
 * With the defaults (factor 0.8 / retention 0.6) a maximally intelligent agent
 * learns 1.8× faster and forgets at 40% of the base rate. Both are clamped so
 * no configuration can produce negative or >1 rates.
 */

import type { SimulationConfig } from '../../simulation';
import { clamp01 } from '../utility';

/** Learning-rate multiplier for a given intelligence (in [0, 1]). */
export function effectiveLearningRate(intelligence: number, config: SimulationConfig): number {
  const { baseLearningRate, intelligenceLearningFactor } = config.memory;
  return baseLearningRate * (1 + clamp01(intelligence) * intelligenceLearningFactor);
}

/** Forgetting rate (per in-game hour) for a given intelligence (in [0, 1]). */
export function effectiveDecayPerHour(intelligence: number, config: SimulationConfig): number {
  const { baseDecayPerHour, intelligenceRetentionFactor } = config.memory;
  return baseDecayPerHour * (1 - clamp01(intelligence) * intelligenceRetentionFactor);
}

/** Move a memory value toward "useful" after a successful interaction. */
export function reinforceValue(value: number, rate: number): number {
  const r = clamp01(rate);
  return Math.min(1, clamp01(value) + r * (1 - clamp01(value)));
}

/** Move a memory value toward "useless" after finding a location depleted. */
export function punishValue(value: number, rate: number): number {
  const r = clamp01(rate);
  return Math.max(0, clamp01(value) * (1 - r));
}

/** Apply one tick of forgetting to a memory value. */
export function decayValue(value: number, decayPerTick: number): number {
  const d = clamp01(decayPerTick);
  return Math.max(0, clamp01(value) * (1 - d));
}
