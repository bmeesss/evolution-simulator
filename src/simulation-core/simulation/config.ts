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

export interface SimulationConfig {
  time: TimeConfig;
  world: WorldDimensions;
  movement: MovementConfig;
  needs: NeedsConfig;
  agents: AgentsConfig;
  ai: AiConfig;
  memory: MemoryConfig;
  resources: ResourcesConfig;
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
} satisfies SimulationConfig);

/** Deep-clone a config (configs are treated as immutable per simulation). */
export function cloneConfig(config: SimulationConfig): SimulationConfig {
  return structuredClone(config);
}
