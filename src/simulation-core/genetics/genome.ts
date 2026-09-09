/**
 * Genome definition.
 *
 * All traits are normalized to [0, 1]:
 *   intelligence   — learning/planning capacity (used by future AI systems)
 *   strength       — physical power (drives agent size on screen, phase 1)
 *   speed          — movement speed multiplier
 *   fertility      — reproduction aptitude (unused in phase 1)
 *   socialTendency — attraction to other agents (unused in phase 1)
 *
 * Phase 1 spawns agents with traits drawn uniformly from the spawn RNG.
 * Inheritance, mutation and natural selection are explicitly OUT OF SCOPE for
 * this phase — see the phase plan in ARCHITECTURE.md.
 */

import type { Rng } from '../rng';

export interface GenomeValues {
  intelligence: number;
  strength: number;
  speed: number;
  fertility: number;
  socialTendency: number;
}

/** Draw a phase-1 genome: every trait uniform in [0, 1). */
export function randomGenomeValues(rng: Rng): GenomeValues {
  return {
    intelligence: rng.nextFloat(),
    strength: rng.nextFloat(),
    speed: rng.nextFloat(),
    fertility: rng.nextFloat(),
    socialTendency: rng.nextFloat(),
  }
}
