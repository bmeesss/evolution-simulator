/**
 * Life stages — the age-based behavioral/biological phases every agent passes
 * through. Stages are NOT hardcoded branches inside systems; each system reads
 * the multipliers/exponents returned here from centralized config, so the whole
 * lifecycle is tunable in `SimulationConfig.life`.
 *
 *   child       [0, childMaxAgeHours)                 — no reproduction, slower,
 *                                                       higher energy drain
 *   adolescent  [childMaxAgeHours, adolescentMaxAgeHours) — no reproduction
 *   adult       [adolescentMaxAgeHours, adultMaxAgeHours) — normal reproduction
 *   elderly     [adultMaxAgeHours, ∞)                — reduced movement, rising
 *                                                       age mortality (mortality-system)
 *
 * Sex is a separate, orthogonal binary flag (see reproductiveschema) — life
 * stage is purely age-driven.
 */

import type { SimulationConfig } from './config';

export const LifeStage = {
  Child: 0,
  Adolescent: 1,
  Adult: 2,
  Elderly: 3,
} as const;

export type LifeStage = (typeof LifeStage)[keyof typeof LifeStage];

export const LIFE_STAGE_NAMES: readonly string[] = ['child', 'adolescent', 'adult', 'elderly'];

export function lifeStageName(stage: number): string {
  return LIFE_STAGE_NAMES[stage] ?? 'unknown';
}

/** Stage for an age (in-game hours) under a given config. */
export function lifeStageForAge(ageHours: number, config: SimulationConfig): LifeStage {
  const { childMaxAgeHours, adolescentMaxAgeHours, adultMaxAgeHours } = config.life;
  if (ageHours < childMaxAgeHours) return LifeStage.Child;
  if (ageHours < adolescentMaxAgeHours) return LifeStage.Adolescent;
  if (ageHours < adultMaxAgeHours) return LifeStage.Adult;
  return LifeStage.Elderly;
}

/** Movement speed multiplier for a stage (children/adolescents slower). */
export function movementEfficiencyForStage(stage: LifeStage, config: SimulationConfig): number {
  switch (stage) {
    case LifeStage.Child:
      return config.life.childMovementEfficiency;
    case LifeStage.Adolescent:
      return config.life.adolescentMovementEfficiency;
    case LifeStage.Adult:
      return config.life.adultMovementEfficiency;
    case LifeStage.Elderly:
      return config.life.elderlyMovementEfficiency;
  }
}

/** Energy drain multiplier while active (children burn relatively more energy). */
export function energyDrainMultiplierForStage(stage: LifeStage, config: SimulationConfig): number {
  switch (stage) {
    case LifeStage.Child:
      return config.life.childEnergyDrainMultiplier;
    case LifeStage.Adolescent:
      return config.life.adolescentEnergyDrainMultiplier;
    case LifeStage.Adult:
      return config.life.adultEnergyDrainMultiplier;
    case LifeStage.Elderly:
      return config.life.elderlyEnergyDrainMultiplier;
  }
}

/**
 * Whether a stage is biologically reproductively *capable*. The spec forbids
 * reproduction before adulthood; elderly remain capable (their reduced health
 * and rising mortality usually block it through the health/need gates in the
 * reproduction system, which is exactly the natural-selection pressure we want).
 */
export function isReproductiveStage(stage: LifeStage): boolean {
  return stage === LifeStage.Adult || stage === LifeStage.Elderly;
}
