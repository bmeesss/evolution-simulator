/**
 * The Simulation: owns world, entities, RNG streams, events and the fixed
 * timestep tick. This class is the entire simulation-core public surface used
 * by the worker, persistence and tests.
 *
 * Determinism contract:
 *   - `Simulation.create(seed, config)` produces identical state for identical
 *     (seed, config) on every run.
 *   - `step()` advances exactly one tick; N calls from a created/restored state
 *     produce identical state regardless of wall-clock time or render rate.
 *
 * The class has ZERO knowledge of DOM/canvas/workers — rendering and UI only
 * ever consume extracted snapshots (see persistence/snapshots.ts).
 */

import { SimulationEcs } from '../ecs';
import type { SimulationEcs as SimulationEcsType, SerializedEcs } from '../ecs';
import { EventLog } from '../events';
import type { EventLog as EventLogType } from '../events';
import { Rng } from '../rng';
import type { RngState } from '../rng';
import { deriveStreamSeed } from '../rng';
import { createWorld } from '../world';
import type { World } from '../world';
import { selectIntents } from '../ai';
import type { TickContext } from './tick-context';
import type { SimulationConfig } from './config';
import { spawnInitialAgents } from './systems/spawn';
import { moveAgents } from './systems/movement-system';
import { updateNeeds } from './systems/needs-system';
import { updateAging } from './systems/aging-system';

export interface SimulationRngStreams {
  /** Tick dynamics: movement target selection, future AI tie-breaks, etc. */
  readonly sim: Rng;
  /** Entity creation: initial spawn and future births. */
  readonly spawn: Rng;
}

interface SimulationParts {
  readonly seed: number;
  readonly config: SimulationConfig;
  readonly world: World;
  readonly tickCount: number;
  readonly rng: SimulationRngStreams;
}

export class Simulation {
  readonly seed: number;
  readonly config: SimulationConfig;
  readonly ecs: SimulationEcsType;
  readonly world: World;
  readonly events: EventLogType;
  readonly rng: SimulationRngStreams;

  private tickCount: number;
  private readonly ctx: TickContext;

  private constructor(parts: SimulationParts) {
    this.seed = parts.seed;
    this.config = parts.config;
    this.world = parts.world;
    this.tickCount = parts.tickCount;
    this.ecs = new SimulationEcs();
    this.rng = parts.rng;
    this.events = new EventLog(() => ({
      tick: this.tickCount,
      timeHours: this.tickCount * this.config.time.hoursPerTick,
    }));
    this.ctx = {
      ecs: this.ecs,
      world: this.world,
      config: this.config,
      rng: this.rng.sim,
      dtHours: this.config.time.hoursPerTick,
    };
  }

  /** Create a fresh simulation: deterministic world + initial agents from the seed. */
  static create(seed: number, config: SimulationConfig): Simulation {
    const simulation = new Simulation({
      seed,
      config,
      world: createWorld(seed, config.world),
      tickCount: 0,
      rng: {
        sim: Rng.fromSeed(deriveStreamSeed(seed, 'sim')),
        spawn: Rng.fromSeed(deriveStreamSeed(seed, 'spawn')),
      },
    });
    spawnInitialAgents(simulation.ecs, simulation.world, simulation.config, simulation.rng.spawn, simulation.events);
    simulation.events.record('simulation_started', { detail: `seed=${seed}` });
    return simulation;
  }

  /**
   * Rebuild a simulation from persisted state (see persistence/serialization).
   * The event history is not persisted in phase 1 — the log starts empty.
   */
  static restore(parts: {
    seed: number;
    config: SimulationConfig;
    world: World;
    tickCount: number;
    rngStates: { sim: RngState; spawn: RngState };
    ecs: SerializedEcs;
  }): Simulation {
    const simulation = new Simulation({
      seed: parts.seed,
      config: parts.config,
      world: parts.world,
      tickCount: parts.tickCount,
      rng: {
        sim: Rng.fromState(parts.rngStates.sim),
        spawn: Rng.fromState(parts.rngStates.spawn),
      },
    });
    simulation.ecs.restore(parts.ecs);
    return simulation;
  }

  /** Current tick number (ticks since simulation creation). */
  get tick(): number {
    return this.tickCount;
  }

  /** Total in-game hours elapsed. */
  get timeHours(): number {
    return this.tickCount * this.config.time.hoursPerTick;
  }

  /** Number of alive entities. */
  get population(): number {
    return this.ecs.entities.aliveCount;
  }

  /**
   * Advance the simulation by exactly one fixed timestep.
   * System order is part of the determinism contract and must not change
   * without bumping the save format version.
   */
  step(): void {
    selectIntents(this.ctx); // 1. decide what agents want to do
    moveAgents(this.ctx); // 2. act on movement intents
    updateNeeds(this.ctx); // 3. apply need/health dynamics
    updateAging(this.ctx); // 4. advance age
    this.tickCount++;
  }

  /** Serializable RNG states (part of the save state). */
  getRngStates(): { sim: RngState; spawn: RngState } {
    return { sim: this.rng.sim.getState(), spawn: this.rng.spawn.getState() };
  }
}
