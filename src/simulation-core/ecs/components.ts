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
 * - Inventory: carried resources. Fixed columns (e.g. per-resource counts) fit
 *   ComponentStore directly.
 *
 * Memory is implemented in phase 2 as a dedicated store (see
 * `ai/memory/memory-store.ts`) because its per-agent length is variable (but
 * bounded) — exactly the arena/offset scheme previously sketched here. The
 * Phase 4 social relationship memory follows the same dedicated-store pattern
 * (see `social/relationship-store.ts`); the fixed-column social state is the
 * `social` ComponentStore below.
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
 * is the current movement goal (tile units). For SeekPartner, `targetEntity`
 * holds the chosen partner's entity id (or -1).
 */
export const IntentSchema = {
  kind: Uint8Array,
  targetX: Float64Array,
  targetY: Float64Array,
  /** Chosen partner entity id for SeekPartner intents, -1 otherwise. */
  targetEntity: Int32Array,
};

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
  seekPartner: Float32Array,
  // Phase 4 — social actions (same order as ActionKind).
  socialize: Float32Array,
  help: Float32Array,
  cooperate: Float32Array,
  avoid: Float32Array,
  confront: Float32Array,
  // Phase 5 — culture & communication (same order as ActionKind).
  teach: Float32Array,
  signalDanger: Float32Array,
  signalFood: Float32Array,
  signalWater: Float32Array,
  signalFollow: Float32Array,
};

/**
 * Social state (Phase 4) — fixed numeric per-agent columns for the social
 * layer. The sparse per-agent relationship memory lives in a dedicated store
 * (social/relationship-store.ts) because it is variable-length but bounded,
 * exactly like the environmental memory.
 *
 *   loneliness          0..100, rises over time, relieved by socializing
 *   groupId             current emergent-group membership (-1 = ungrouped)
 *   groupJoinTick       tick the agent joined its current group
 *   cooperationTarget   partner of the running cooperation session (-1 = none)
 *   cooperationTicks    progress of the running cooperation session
 *   forageBonusTicks    remaining cooperative-foraging efficiency bonus
 *   lastConflictTick    last tick this agent was in a conflict (flash UI)
 */
export const SocialSchema = {
  loneliness: Float32Array,
  groupId: Int32Array,
  groupJoinTick: Uint32Array,
  cooperationTarget: Int32Array,
  cooperationTicks: Uint16Array,
  forageBonusTicks: Uint16Array,
  lastConflictTick: Uint32Array,
};

/**
 * Per-agent culture state (Phase 5) — the fixed numeric columns of the cultural
 * layer. The variable-length per-agent data (cultural knowledge items and
 * signal-meaning associations) lives in dedicated stores
 * (`culture/cultural-memory-store.ts`, `culture/signal-store.ts`), exactly like
 * environmental memory and social relationships.
 *
 *   signalCooldownTicks  ticks left before this agent may emit a signal again
 *   teachCooldownTicks   ticks left before this agent may teach again
 *   alertTicks           ticks of wariness left after hearing a known danger signal
 *   lastSignalToken      token of the most recent emission (255 = none); drives
 *                        the renderer's signal flash and the inspector
 *   lastSignalTick       tick of the most recent emission
 *   lastForageTick       tick of the most recent successful Eat/Drink (written by
 *                        the resource system) so the culture system can credit
 *                        discoveries and reinforcement without guessing
 */
/**
 * `lastForageTick` sentinel for "this agent has never foraged". Using a tick
 * value that can never occur (rather than 0) keeps tick 0 unambiguous: without
 * it, every agent would look like it had foraged on the very first tick.
 */
export const NO_FORAGE_TICK = 0xffff_ffff;

export const CultureStateSchema = {
  signalCooldownTicks: Uint16Array,
  teachCooldownTicks: Uint16Array,
  alertTicks: Uint16Array,
  lastSignalToken: Uint8Array,
  lastSignalTick: Uint32Array,
  lastForageTick: Uint32Array,
};

/**
 * Lineage — persistent genealogy fields. `generation` is a lineage concept:
 * a child's generation is `max(parentA.gen, parentB.gen) + 1`, so agents do not
 * all reproduce synchronously. `parentA`/`parentB` are entity ids, or -1 sentinel
 * for the founding generation (which has no parents).
 */
export const LineageSchema = {
  generation: Uint32Array,
  parentA: Int32Array,
  parentB: Int32Array,
};

/**
 * Reproductive state — a deliberately simple, deterministic model: binary sex
 * (0/1), a remaining reproduction cooldown (in-game hours) and a cached
 * `eligible` flag (1 when the agent is currently reproductively eligible, i.e.
 * adult, healthy enough, needs tolerable and cooldown expired). Eligibility is
 * recomputed each tick and persisted so the inspector and determinism tests can
 * read it without recomputation. No pregnancy/menstrual cycles/rituals.
 */
export const ReproductiveSchema = {
  sex: Uint8Array,
  cooldownHours: Float64Array,
  eligible: Uint8Array,
};
