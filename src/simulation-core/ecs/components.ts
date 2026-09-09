/**
 * Component schemas for the simulation.
 *
 * A schema maps column names to typed array constructors; each schema becomes
 * one ComponentStore on the SimulationEcs. This file is the single place where
 * components are declared — see ARCHITECTURE.md ("Adding a component") for the
 * full recipe.
 *
 * PLANNED COMPONENTS (deliberately not instantiated yet — later phases):
 * The generic ComponentStore already supports them without changes; they will
 * simply be added as new schemas + stores when their gameplay phases arrive:
 *
 * - Social: relationship references between entities. Sparse per-entity pairs;
 *   likely a per-agent open-addressed table or a separate edge store.
 * - Inventory: carried resources. Fixed columns (e.g. per-resource counts) fit
 *   ComponentStore directly.
 *
 * Memory is implemented in phase 2 as a dedicated store (see
 * `ai/memory/memory-store.ts`) because its per-agent length is variable (but
 * bounded) — exactly the arena/offset scheme previously sketched here.
 */

/** Position in tile units. Valid range: [0, worldWidth-1] x [0, worldHeight-1]. */
export const PositionSchema = { x: Float64Array, y: Float64Array };

/**
 * Survival needs on a 0..100 scale (0 = fully satisfied, 100 = critical).
 * `energy` is spent while active and regenerated while resting.
 */
export const NeedsSchema = { hunger: Float32Array, thirst: Float32Array, energy: Float32Array };

/** Age in in-game hours (float; hoursPerTick is configurable). */
export const AgeSchema = { ageHours: Float64Array };

/** Health on a 0..100 scale. */
export const HealthSchema = { current: Float32Array };

/**
 * Genome — all traits normalized to [0, 1].
 * Phase 1 genomes are drawn uniformly at spawn; inheritance and mutation are
 * deliberately NOT implemented yet (later phase).
 */
export const GenomeSchema = {
  intelligence: Float32Array,
  strength: Float32Array,
  speed: Float32Array,
  fertility: Float32Array,
  socialTendency: Float32Array,
};

/**
 * Current behavioral intent, written by the AI module and consumed by the
 * movement/needs systems. `kind` uses the AgentIntent constants; `targetX/Y`
 * is the current movement goal (tile units).
 */
export const IntentSchema = { kind: Uint8Array, targetX: Float64Array, targetY: Float64Array };

/**
 * Per-agent Utility AI scores from the most recent decision pass (the base
 * scores, before tie-break noise and hysteresis). Persisted so the selected-
 * agent debug view and the determinism tests can inspect "Action | Utility"
 * without recomputing the AI (which would consume RNG). The column order must
 * stay aligned with the action order in `ai/actions`.
 */
export const AiStateSchema = {
  rest: Float32Array,
  wander: Float32Array,
  seekFood: Float32Array,
  seekWater: Float32Array,
  eat: Float32Array,
  drink: Float32Array,
};
