/**
 * Cultural effects — the per-agent view of culture that behaviour reads.
 *
 * Culture influences behaviour through a small, explicit set of numbers, and
 * this module is the single place that turns a bounded walk over an agent's
 * cultural memory into them:
 *
 *   - the best known food / water location (a *believed* location — the agent
 *     has been told it, or worked it out, but has not necessarily seen it),
 *   - the strongest foraging technique (habitat-specific efficiency),
 *   - the strength of each social norm (Help / Share / Avoid-conflict).
 *
 * WHY one collector: the Utility AI needs several of these per agent per tick,
 * and walking the cultural chain once (<= capacity entries) instead of five
 * times keeps the per-agent cost constant and small. The result object is
 * reused module scratch — consumers read it immediately and never retain it,
 * the established pattern for hot-path queries in this codebase.
 */

import type { EntityId } from '../ecs';
import type { CulturalMemoryStore } from './cultural-memory-store';
import { KnowledgeType, NORM_COUNT } from './knowledge';

export interface CulturalEffects {
  /** Best known food location (only meaningful when `foodKnown`). */
  foodKnown: boolean;
  foodX: number;
  foodY: number;
  foodStrength: number;
  /** Best known water location (only meaningful when `waterKnown`). */
  waterKnown: boolean;
  waterX: number;
  waterY: number;
  waterStrength: number;
  /** Strongest known foraging technique and its habitat variant. */
  techniqueStrength: number;
  techniqueVariant: number;
  /** Strength of each norm, indexed by NormId. */
  readonly normStrength: Float32Array;
}

export function createCulturalEffects(): CulturalEffects {
  return {
    foodKnown: false,
    foodX: 0,
    foodY: 0,
    foodStrength: 0,
    waterKnown: false,
    waterX: 0,
    waterY: 0,
    waterStrength: 0,
    techniqueStrength: 0,
    techniqueVariant: -1,
    normStrength: new Float32Array(NORM_COUNT),
  };
}

/**
 * Fill `out` from one agent's cultural memory (one pass over its bounded
 * chain). Unknown kinds of knowledge contribute nothing — the switch is
 * exhaustive so a new KnowledgeType cannot silently do nothing.
 */
export function collectCulturalEffects(
  store: CulturalMemoryStore,
  entity: EntityId,
  out: CulturalEffects,
): CulturalEffects {
  out.foodKnown = false;
  out.foodStrength = 0;
  out.waterKnown = false;
  out.waterStrength = 0;
  out.techniqueStrength = 0;
  out.techniqueVariant = -1;
  for (let n = 0; n < NORM_COUNT; n++) out.normStrength[n] = 0;

  for (let e = store.headOf(entity); e !== -1; e = store.nextOf(e)) {
    const strength = store.entryStrength(e);
    if (strength <= 0) continue;
    switch (store.entryType(e)) {
      case KnowledgeType.FoodLocation:
        if (strength > out.foodStrength) {
          out.foodKnown = true;
          out.foodStrength = strength;
          out.foodX = store.entryTileX(e);
          out.foodY = store.entryTileY(e);
        }
        break;
      case KnowledgeType.WaterLocation:
        if (strength > out.waterStrength) {
          out.waterKnown = true;
          out.waterStrength = strength;
          out.waterX = store.entryTileX(e);
          out.waterY = store.entryTileY(e);
        }
        break;
      case KnowledgeType.ForagingTechnique:
        if (strength > out.techniqueStrength) {
          out.techniqueStrength = strength;
          out.techniqueVariant = store.entryVariant(e);
        }
        break;
      case KnowledgeType.SocialNorm: {
        const norm = store.entryVariant(e);
        if (norm >= 0 && norm < NORM_COUNT && strength > out.normStrength[norm]) {
          out.normStrength[norm] = strength;
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/**
 * Scratch for the single-value technique query (reused across calls — read it
 * immediately; same contract as `partnerScratch` in the utility AI).
 */
const techniqueScratch = { strength: 0, variant: -1 };

/** Strongest foraging technique an agent holds (strength 0 / variant -1: none). */
export function techniqueOf(store: CulturalMemoryStore, entity: EntityId): { strength: number; variant: number } {
  let strength = 0;
  let variant = -1;
  for (let e = store.headOf(entity); e !== -1; e = store.nextOf(e)) {
    if (store.entryType(e) !== KnowledgeType.ForagingTechnique) continue;
    const candidate = store.entryStrength(e);
    if (candidate > strength) {
      strength = candidate;
      variant = store.entryVariant(e);
    }
  }
  techniqueScratch.strength = strength;
  techniqueScratch.variant = variant;
  return techniqueScratch;
}

/** Norm strength for the behaviour multipliers (0 when the agent holds none). */
export function normStrength(effects: CulturalEffects, norm: number): number {
  return norm >= 0 && norm < NORM_COUNT ? effects.normStrength[norm] : 0;
}
