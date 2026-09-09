/**
 * Genome definition, inheritance and mutation.
 *
 * All traits are normalized to [0, 1]:
 *   intelligence   — learning/planning capacity (drives memory acquisition)
 *   strength       — physical power (drives agent size on screen)
 *   speed          — movement speed multiplier
 *   fertility      — reproduction aptitude (shorter cooldown, stronger drive)
 *   socialTendency — attraction to other agents (partner compatibility)
 *
 * Phase 1 spawned agents with uniform traits. Phase 3 adds the genetic
 * operators used on every birth:
 *   - crossover: uniform crossover — for each gene, one parent's allele is
 *     copied (50/50). Deterministic; all randomness comes from the supplied RNG.
 *   - mutation: per-gene additive, small, clamped to [0, 1]. Most mutations are
 *     tiny (magnitude configurable) so inheritance stays meaningful.
 *
 * Neither operator uses the platform random source — both draw exclusively from
 * the `repro` RNG stream (see ARCHITECTURE.md §deterministic RNG).
 */

import type { Rng } from '../rng';
import type { MutationConfig } from '../simulation/config';

export interface GenomeValues {
  intelligence: number;
  strength: number;
  speed: number;
  fertility: number;
  socialTendency: number;
}

/** Fixed gene order — must stay aligned with GenomeSchema (see ecs/components). */
export const GENOME_KEYS: readonly (keyof GenomeValues)[] = [
  'intelligence',
  'strength',
  'speed',
  'fertility',
  'socialTendency',
] as const;

export type GenomeKey = (typeof GENOME_KEYS)[number];

/** A single observed mutation (for compact mutation events / lineage display). */
export interface GenomeMutation {
  readonly gene: GenomeKey;
  readonly before: number;
  readonly after: number;
  readonly delta: number;
}

/** Clamp a genome trait into [0, 1] (mutation must never leave the bounds). */
function clampTrait(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Draw a phase-1 (founding) genome: every trait uniform in [0, 1). */
export function randomGenomeValues(rng: Rng): GenomeValues {
  return {
    intelligence: rng.nextFloat(),
    strength: rng.nextFloat(),
    speed: rng.nextFloat(),
    fertility: rng.nextFloat(),
    socialTendency: rng.nextFloat(),
  };
}

/**
 * Uniform crossover of two parents. For each gene, with probability 0.5 the
 * child inherits parent A's allele, otherwise parent B's. Deterministic given
 * the RNG stream, and every returned trait stays in the parent range [0, 1]
 * (so it is automatically bounded). No memory/life-experience is passed on —
 * only genes.
 */
export function crossoverGenomes(parentA: GenomeValues, parentB: GenomeValues, rng: Rng): GenomeValues {
  const fromA = () => (rng.chance(0.5) ? parentA : parentB);
  return {
    intelligence: fromA().intelligence,
    strength: fromA().strength,
    speed: fromA().speed,
    fertility: fromA().fertility,
    socialTendency: fromA().socialTendency,
  };
}

/**
 * Apply mutation to a freshly-crossovered genome. Each gene independently
 * mutates with `config.perGeneProbability`; a mutated gene is perturbed by a
 * uniform delta in [-magnitude, +magnitude] and clamped to [0, 1]. Returns the
 * resulting genome plus the list of genes that actually changed. Deterministic
 * given the RNG stream; the mutation list only contains real (delta != 0)
 * changes so events stay compact.
 */
export function mutateGenome(
  genome: GenomeValues,
  rng: Rng,
  config: MutationConfig,
): { genome: GenomeValues; mutations: GenomeMutation[] } {
  const next: GenomeValues = { ...genome };
  const mutations: GenomeMutation[] = [];
  for (const key of GENOME_KEYS) {
    if (!rng.chance(config.perGeneProbability)) continue;
    const before = next[key];
    const delta = (rng.nextFloat() * 2 - 1) * config.magnitude;
    const after = clampTrait(before + delta);
    next[key] = after;
    if (after !== before) {
      mutations.push({ gene: key, before, after, delta: after - before });
    }
  }
  return { genome: next, mutations };
}
