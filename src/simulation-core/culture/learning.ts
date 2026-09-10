/**
 * Cultural learning rules — how knowledge and signal associations change over
 * time, and how likely a transmission is.
 *
 * Everything here is bounded, deterministic arithmetic: no neural networks, no
 * LLMs, no evolutionary algorithms. Intelligence modulates PACE (learning rate,
 * retention), never outcome: a smart agent learns faster and forgets slower,
 * but exposure and social contact still decide what it ever gets to learn.
 *
 * Knowledge values (strength in [0, 1]):
 *   reinforce(strength, rate) = strength + rate * (1 - strength)   success -> stronger
 *   weaken(strength, rate)    = strength * (1 - rate)              contradiction -> weaker
 *   decay(strength, perTick)  = strength * (1 - perTick)           unused -> fades
 *
 * Transmission probability (the interpretable formula — every factor is a
 * bounded [0, 1] influence, weighted from config, so no single factor can
 * dominate and none can be removed without changing behaviour):
 *
 *   chance = clamp01( base
 *     * affinityFactor        (0.5 + weight * relationship affinity: friends teach best)
 *     * familiarityFactor     (how well the two know each other — the proxy for
 *                              time spent together; strangers still learn something)
 *     * learnerIntelligence   (1 + bonus * intelligence: a quick study)
 *     * teacherSociability    (how inclined the teacher is to spend effort)
 *     * strengthFactor        (a well-established item is easier to convey)
 *   )
 *
 * The familiarity term is intentional: Phase 4 already accrues familiarity from
 * physical co-presence (config.social.perception.familiarityPerTickNear), so
 * "time spent together" is an existing, already-serialized quantity rather than
 * a parallel timer invented for Phase 5.
 */

import type { SimulationConfig } from '../simulation';
import { clamp01 } from '../ai/utility';
import { reinforceValue, punishValue, decayValue } from '../ai/memory';

export { reinforceValue, punishValue, decayValue };

/** Learning-rate multiplier for cultural knowledge at a given intelligence. */
export function effectiveCulturalLearningRate(intelligence: number, config: SimulationConfig): number {
  const { baseLearningRate, intelligenceLearningFactor } = config.culture.memory;
  return baseLearningRate * (1 + clamp01(intelligence) * intelligenceLearningFactor);
}

/** Forgetting rate per in-game hour for cultural knowledge (intelligence-retained). */
export function effectiveCulturalDecayPerHour(intelligence: number, config: SimulationConfig): number {
  const { baseDecayPerHour, intelligenceRetentionFactor } = config.culture.memory;
  return baseDecayPerHour * (1 - clamp01(intelligence) * intelligenceRetentionFactor);
}

/** Association-update rate for signal meanings at a given intelligence. */
export function effectiveSignalLearningRate(intelligence: number, config: SimulationConfig): number {
  const { learningRate, intelligenceLearningFactor } = config.culture.signals;
  return learningRate * (1 + clamp01(intelligence) * intelligenceLearningFactor);
}

/** Forgetting rate per in-game hour for signal associations. */
export function effectiveSignalDecayPerHour(intelligence: number, config: SimulationConfig): number {
  const { baseDecayPerHour, intelligenceRetentionFactor } = config.culture.signals;
  return baseDecayPerHour * (1 - clamp01(intelligence) * intelligenceRetentionFactor);
}

/** Decay applied to the *competing* meanings of a token when one is observed. */
export function competingMeaningDecay(strength: number, rate: number): number {
  return Math.max(0, strength * (1 - clamp01(rate)));
}

export interface TransmissionFactors {
  /** Relationship score of teacher -> learner in [−1, 1] (0 = strangers). */
  readonly relationshipScore: number;
  /** Familiarity in [0, 1] (the time-spent-together proxy). */
  readonly familiarity: number;
  /** Learner genome intelligence in [0, 1]. */
  readonly learnerIntelligence: number;
  /** Teacher genome social tendency in [0, 1]. */
  readonly teacherSocialTendency: number;
  /** Strength of the item being transmitted, in [0, 1]. */
  readonly itemStrength: number;
}

/** Map a relationship score to a [0, 1] affinity (mirrors the social affinity curve). */
function transmissionAffinity(score: number): number {
  const clamped = score < -1 ? -1 : score > 1 ? 1 : score;
  if (clamped >= 0) return clamp01(0.5 + 0.5 * clamped);
  return clamp01(0.5 * (1 + clamped / 0.25));
}

/**
 * Probability that one transmission event (a Teach interaction, or a passive
 * imitation opportunity) actually transfers knowledge. `base` is the
 * interaction's baseline chance (deliberate teaching is much higher than
 * observation). Never 0 and never 1: even a great teacher sometimes fails, and
 * even a bored acquaintance occasionally shows you something.
 */
export function transmissionChance(
  base: number,
  factors: TransmissionFactors,
  config: SimulationConfig,
): number {
  const t = config.culture.transmission;
  const affinityFactor = 1 - t.relationshipWeight + t.relationshipWeight * transmissionAffinity(factors.relationshipScore);
  const familiarityFactor = 1 - t.familiarityWeight + t.familiarityWeight * clamp01(factors.familiarity);
  const intelligenceFactor = 1 + t.intelligenceBonus * clamp01(factors.learnerIntelligence);
  const socialFactor =
    1 - t.socialTendencyWeight + t.socialTendencyWeight * clamp01(factors.teacherSocialTendency);
  const strengthFactor = 1 - t.strengthWeight + t.strengthWeight * clamp01(factors.itemStrength);
  return clamp01(base * affinityFactor * familiarityFactor * intelligenceFactor * socialFactor * strengthFactor);
}

/**
 * Whether a transmission is perfect. Fidelity is checked once per successful
 * transmission; a failed check produces a *cultural variant* (a slightly
 * different location or an alternate technique/norm token) — cultural drift,
 * never arbitrary text generation.
 */
export function transmissionIsFaithful(fidelity: number, roll: number): boolean {
  return roll < clamp01(fidelity);
}
