/**
 * Simulation configuration.
 *
 * Every tunable number used by the simulation lives here — systems never embed
 * magic numbers. The config is plain JSON-serializable data so it can be
 * embedded in save files and compared in determinism tests.
 *
 * Fixed timestep: one simulation tick advances exactly `time.hoursPerTick`
 * in-game hours, independent of the render frame rate. The worker decides how
 * many ticks to run per real-time slice based on speed (see workers/).
 */

import type { WorldDimensions } from '../world';

// --- Needs scale -----------------------------------------------------------
/** Needs (hunger/thirst/energy/health) live on a 0..100 scale. */
export const NEED_MIN = 0;
export const NEED_MAX = 100;

export interface TimeConfig {
  /** In-game hours advanced by one simulation tick. */
  hoursPerTick: number;
  /** Ticks per real-time second at 1x speed (speed multipliers scale this). */
  baseTicksPerSecond: number;
  /**
   * Upper bound on ticks processed in a single worker update slice. Guards the
   * worker loop when the simulation cannot keep up with the requested speed.
   */
  maxTicksPerUpdateSlice: number;
  /** Minimum real-time interval between snapshots sent to the main thread. */
  snapshotIntervalMs: number;
}

export interface MovementConfig {
  /** Movement speed (tiles/hour) at genome speed 0. */
  baseSpeedTilesPerHour: number;
  /** Additional movement speed (tiles/hour) at genome speed 1. */
  speedRangeTilesPerHour: number;
  /** Wander targets are picked within this radius of the agent (tiles). */
  wanderTargetRadiusTiles: number;
  /** Distance at which a wander target counts as reached (tiles). */
  targetReachedDistanceTiles: number;
}

export interface NeedsConfig {
  hungerPerHour: number;
  thirstPerHour: number;
  /** Energy spent per hour while moving/active. */
  energyDrainPerHourActive: number;
  /** Energy regained per hour while resting. */
  energyRegenPerHourResting: number;
  /** Energy below this -> agent rests (hysteresis lower bound). */
  restEnergyThreshold: number;
  /** Energy above this -> resting agent wakes up (hysteresis upper bound). */
  wakeEnergyThreshold: number;
  /** At or above this hunger/thirst, health starts to deteriorate. */
  criticalNeedThreshold: number;
  /** Health lost per hour while any need is critical. */
  healthDrainPerHourCritical: number;
  /** Health regained per hour while all needs are comfortable. */
  healthRegenPerHourComfortable: number;
  /** Needs at or below this count as comfortable for regeneration. */
  comfortableNeedThreshold: number;
}

export interface AgentsConfig {
  /** Number of agents spawned when a simulation is created. */
  initialPopulation: number;
  spawn: {
    /** Attempts to find a land tile per spawned agent before giving up. */
    maxLandTileAttempts: number;
    /**
     * Starting age (lower bound) of the founding generation, in in-game hours.
     * The spec makes *children born during the run* start at age 0; the founding
     * generation is unconstrained and spawns as a mixed-age cohort of adults so a
     * fresh simulation can reproduce immediately and does not hit a synchronized
     * old-age cliff. Ages are drawn uniformly in
     * [initialAgeHours, initialAgeHours + initialAgeVariationHours).
     */
    initialAgeHours: number;
    /** Spread (in-game hours) of the founding generation's starting ages. */
    initialAgeVariationHours: number;
    initialHungerMax: number;
    initialThirstMax: number;
    initialEnergyMin: number;
    initialEnergyMax: number;
    initialHealth: number;
  };
}

export interface AiConfig {
  /** Radius (tiles) within which an agent can perceive resource tiles. */
  perceptionRadiusTiles: number;
  /**
   * Distance scale (tiles) for reachability scoring. A resource this far away
   * scores ~0; remembered locations beyond perception still compete within it.
   */
  travelHorizonTiles: number;
  /** Hunger below this produces no urge to eat (0..100). */
  seekFoodNeedThreshold: number;
  /** Thirst below this produces no urge to drink (0..100). */
  seekWaterNeedThreshold: number;
  /** Base utility of exploring when nothing else matters (0..1). */
  explorationDrive: number;
  /** Bonus added to the currently-selected action (prevents thrashing). */
  hysteresisBonus: number;
  /** Half-width of deterministic tie-break jitter added to each utility. */
  tieBreakNoise: number;
}

export interface MemoryConfig {
  /** Maximum remembered locations per agent. */
  capacity: number;
  /** Fraction a successful interaction moves a memory value toward 1. */
  baseLearningRate: number;
  /** Base forgetting rate per in-game hour (memory value decays toward 0). */
  baseDecayPerHour: number;
  /** Value a newly created memory starts at. */
  initialValue: number;
  /** Entries whose value falls below this are forgotten entirely. */
  forgetThreshold: number;
  /** Extra learning-rate multiplier at intelligence 1 (intel 0 adds nothing). */
  intelligenceLearningFactor: number;
  /** Fraction of base decay removed at intelligence 1 (better retention). */
  intelligenceRetentionFactor: number;
}

export interface ResourcesConfig {
  /** Food consumed per Eat action (fraction of the tile's [0,1] capacity). */
  eatAmount: number;
  /** Water consumed per Drink action (fraction of the tile's [0,1] capacity). */
  drinkAmount: number;
  /** Hunger points removed per Eat (0..100 scale). */
  hungerReliefPerEat: number;
  /** Thirst points removed per Drink (0..100 scale). */
  thirstReliefPerDrink: number;
  /** A tile with less food than this is treated as empty (also perception). */
  minFoodToEat: number;
  /** A tile with less water than this is treated as dry (also perception). */
  minWaterToDrink: number;
  /** Fraction of a tile's capacity regenerated per in-game hour. */
  foodRegenPerHour: number;
  /** Fraction of a tile's capacity regenerated per in-game hour. */
  waterRegenPerHour: number;
}

/**
 * Life stage thresholds (in in-game hours) and per-stage behavior modifiers.
 * Stages influence behavior through *multipliers*, never through hardcoded
 * per-stage branches scattered through the systems — each modifier is read from
 * config so the balance is tunable in one place.
 *
 *   child       [0, childMaxAgeHours)          — no reproduction, slower, costlier
 *   adolescent  [childMaxAgeHours, adolescentMaxAgeHours) — slower, no reproduction
 *   adult       [adolescentMaxAgeHours, adultMaxAgeHours) — normal reproduction/movement
 *   elderly     [adultMaxAgeHours, ∞)          — reduced movement, rising mortality
 */
export interface LifeStageConfig {
  childMaxAgeHours: number;
  adolescentMaxAgeHours: number;
  /** Age at which agents become elderly (past this point mortality rises). */
  adultMaxAgeHours: number;
  /** Movement speed multiplier while a child (slower to grow up, better than 0). */
  childMovementEfficiency: number;
  adolescentMovementEfficiency: number;
  adultMovementEfficiency: number;
  elderlyMovementEfficiency: number;
  /** Energy drain multiplier while active (costlier to be a growing child). */
  childEnergyDrainMultiplier: number;
  adolescentEnergyDrainMultiplier: number;
  adultEnergyDrainMultiplier: number;
  elderlyEnergyDrainMultiplier: number;
}

/**
 * Reproduction tuning. Reproduction is chosen by the Utility AI only when an
 * adult is not in an unsafe survival state; the AI's `reproductionUrgency`
 * drops to zero as hunger/thirst/fatigue rise, so agents never breed while
 * starving. All values are absolute/centralized for tunable natural selection.
 */
export interface ReproductionConfig {
  /** Radius (tiles) within which an agent searches for a partner. */
  partnerSeekRadiusTiles: number;
  /** Distance (tiles) at which a seeker and partner are "close enough" to breed. */
  partnerReachTiles: number;
  /** Minimum health (0..100) for either parent to breed. */
  minHealthToReproduce: number;
  /** Minimum energy (0..100) for the seeker to bother breeding. */
  minEnergyToReproduce: number;
  /** Hunger AND thirst must be below this (0..100) to breed (unsafe = blocked). */
  maxNeedToReproduce: number;
  /** Base cooldown after a successful reproduction (in-game hours). */
  cooldownHours: number;
  /** Fraction of the cooldown removed at fertility 1 (higher fertility -> shorter cooldown). */
  fertilityCooldownReduction: number;
  /** Base Utility-AI drive to seek a partner (0..1). */
  baseDrive: number;
  /** Utility-AI drive added at fertility 1 (eager breeders reproduce more). */
  fertilityDriveBoost: number;
  /** Utility-AI drive added at social-tendency 1 (social agents seek mates more). */
  socialDriveBoost: number;
  childInitialHungerMax: number;
  childInitialThirstMax: number;
  childInitialEnergyMin: number;
  childInitialEnergyMax: number;
  childInitialHealth: number;
}

/**
 * Age-related mortality. This is *gradually rising pressure*, not a hard
 * "age > X -> die" rule: past `life.adultMaxAgeHours`, health drains at a rate
 * that grows linearly with age, so elderly agents are increasingly at risk and
 * are removed by the existing death system.
 */
export interface MortalityConfig {
  /** Health lost per in-game hour right at the elderly threshold. */
  elderlyHealthDrainPerHour: number;
  /** Additional health drain per in-game hour of age past the threshold. */
  ageHealthDrainPerHourExtra: number;
}

/**
 * Gene trade-offs: each genome trait carries a metabolic energy cost so high
 * values are not free. The energy drain while active is multiplied by
 * `1 + Σ(trait * factor)` — documented in ARCHITECTURE.md §Trade-offs.
 */
export interface MetabolismConfig {
  intelligenceCostFactor: number;
  strengthCostFactor: number;
  fertilityCostFactor: number;
  speedCostFactor: number;
}

/** Mutation tuning (per-gene probability and additive magnitude in [0, 1]). */
export interface MutationConfig {
  /** Probability that a single gene mutates when a child is created. */
  perGeneProbability: number;
  /** Maximum magnitude of an additive mutation (delta is uniform in [-m, +m]). */
  magnitude: number;
}

export interface SimulationConfig {
  time: TimeConfig;
  world: WorldDimensions;
  movement: MovementConfig;
  needs: NeedsConfig;
  agents: AgentsConfig;
  ai: AiConfig;
  memory: MemoryConfig;
  resources: ResourcesConfig;
  life: LifeStageConfig;
  reproduction: ReproductionConfig;
  mortality: MortalityConfig;
  metabolism: MetabolismConfig;
  mutation: MutationConfig;
}

/**
 * Recursively freeze a plain-data object.
 * WHY: DEFAULT_SIMULATION_CONFIG is module-level shared state handed to every
 * Simulation — freezing it turns accidental mutation of the default (instead
 * of a cloneConfig copy) into a loud error instead of silent cross-simulation
 * corruption. Note: structuredClone of a frozen object yields a normal
 * mutable clone, so cloneConfig keeps working.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

export const DEFAULT_SIMULATION_CONFIG: SimulationConfig = deepFreeze({
  time: {
    // 15 in-game minutes per tick: 96 ticks per in-game day.
    hoursPerTick: 0.25,
    baseTicksPerSecond: 10,
    maxTicksPerUpdateSlice: 1000,
    snapshotIntervalMs: 100,
  },
  world: {
    width: 64,
    height: 64,
  },
  movement: {
    baseSpeedTilesPerHour: 0.8,
    speedRangeTilesPerHour: 2.4,
    wanderTargetRadiusTiles: 6,
    targetReachedDistanceTiles: 0.25,
  },
  needs: {
    hungerPerHour: 0.8,
    thirstPerHour: 1.1,
    energyDrainPerHourActive: 2.0,
    energyRegenPerHourResting: 5.0,
    restEnergyThreshold: 20,
    wakeEnergyThreshold: 85,
    criticalNeedThreshold: 85,
    healthDrainPerHourCritical: 2.5,
    healthRegenPerHourComfortable: 1.0,
    comfortableNeedThreshold: 50,
  },
  agents: {
    initialPopulation: 50,
    spawn: {
      maxLandTileAttempts: 16,
      // All founding agents are adults (>= adolescentMaxAgeHours) but with a wide,
      // deterministic spread of ages up to the elderly threshold, so they can
      // breed immediately and their deaths are staggered rather than synchronized.
      initialAgeHours: 48,
      initialAgeVariationHours: 672,
      initialHungerMax: 15,
      initialThirstMax: 15,
      initialEnergyMin: 60,
      initialEnergyMax: 100,
      initialHealth: 100,
    },
  },
  ai: {
    perceptionRadiusTiles: 8,
    travelHorizonTiles: 24,
    seekFoodNeedThreshold: 30,
    seekWaterNeedThreshold: 30,
    explorationDrive: 0.2,
    hysteresisBonus: 0.08,
    tieBreakNoise: 0.01,
  },
  memory: {
    capacity: 8,
    baseLearningRate: 0.35,
    baseDecayPerHour: 0.03,
    initialValue: 0.5,
    forgetThreshold: 0.05,
    intelligenceLearningFactor: 0.8,
    intelligenceRetentionFactor: 0.6,
  },
  resources: {
    eatAmount: 0.1,
    drinkAmount: 0.1,
    hungerReliefPerEat: 40,
    thirstReliefPerDrink: 40,
    minFoodToEat: 0.02,
    minWaterToDrink: 0.02,
    foodRegenPerHour: 0.05,
    waterRegenPerHour: 0.05,
  },
  life: {
    childMaxAgeHours: 24,
    adolescentMaxAgeHours: 48,
    adultMaxAgeHours: 720,
    childMovementEfficiency: 0.6,
    adolescentMovementEfficiency: 0.8,
    adultMovementEfficiency: 1,
    elderlyMovementEfficiency: 0.75,
    // Children are small and relatively under-active, so they burn a little
    // less energy per active hour than adults; the cost of being an adult is
    // the gene metabolic load (see metabolism) and the need to reproduce.
    childEnergyDrainMultiplier: 0.8,
    adolescentEnergyDrainMultiplier: 0.95,
    adultEnergyDrainMultiplier: 1,
    elderlyEnergyDrainMultiplier: 0.9,
  },
  reproduction: {
    // The search radius is deliberately modest so the AgentIndex 3x3-cell walk
    // stays local (O(agents × local density), never O(n²) — the cells would cover
    // the whole world if the radius were as large as the map). This makes mate
    // finding density-limited; social tendency raises how often agents seek mates.
    partnerSeekRadiusTiles: 8,
    partnerReachTiles: 1.5,
    minHealthToReproduce: 50,
    minEnergyToReproduce: 25,
    // Breeding is only considered when an adult is genuinely comfortable: hunger
    // AND thirst must both be comfortably below the critical band, so a hungry or
    // thirsty agent never spawns offspring while it should be seeking food/water.
    maxNeedToReproduce: 60,
    // Six in-game days of cooldown after a successful birth. Reproduction is a
    // deliberate, rare act (multiplied by how urgent survival needs are), so the
    // population grows slowly and the founding wave can be replaced rather than
    // exploding; fertility still shortens this for high-fertility agents.
    cooldownHours: 144,
    fertilityCooldownReduction: 0.5,
    baseDrive: 0.12,
    fertilityDriveBoost: 0.25,
    socialDriveBoost: 0.1,
    childInitialHungerMax: 10,
    childInitialThirstMax: 10,
    childInitialEnergyMin: 60,
    childInitialEnergyMax: 100,
    childInitialHealth: 100,
  },
  mortality: {
    elderlyHealthDrainPerHour: 0.3,
    ageHealthDrainPerHourExtra: 0.05,
  },
  metabolism: {
    intelligenceCostFactor: 0.15,
    strengthCostFactor: 0.1,
    fertilityCostFactor: 0.05,
    speedCostFactor: 0.06,
  },
  mutation: {
    perGeneProbability: 0.08,
    magnitude: 0.08,
  },
} satisfies SimulationConfig);

/** Deep-clone a config (configs are treated as immutable per simulation). */
export function cloneConfig(config: SimulationConfig): SimulationConfig {
  return structuredClone(config);
}
