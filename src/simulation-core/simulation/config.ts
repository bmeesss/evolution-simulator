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

export interface SimulationConfig {
  time: TimeConfig;
  world: WorldDimensions;
  movement: MovementConfig;
  needs: NeedsConfig;
  agents: AgentsConfig;
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
} satisfies SimulationConfig);

/** Deep-clone a config (configs are treated as immutable per simulation). */
export function cloneConfig(config: SimulationConfig): SimulationConfig {
  return structuredClone(config);
}
