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
import { ResourceIndex, AgentIndex } from '../ai/perception';
import type { TickContext } from './tick-context';
import type { SimulationConfig } from './config';
import { spawnInitialAgents } from './systems/spawn';
import { moveAgents } from './systems/movement-system';
import { updateNeeds } from './systems/needs-system';
import { interactWithResources } from './systems/resource-system';
import { updateMemory } from './systems/memory-system';
import { regenerateResources } from './systems/regeneration-system';
import { updateDeaths } from './systems/death-system';
import { updateAging } from './systems/aging-system';
import { updateMortality } from './systems/mortality-system';
import { updateReproduction } from './systems/reproduction-system';

export interface SimulationRngStreams {
  /** Non-AI tick dynamics (reserved for future systems). */
  readonly sim: Rng;
  /** Entity creation: initial agent placement (position, needs, founding genomes). */
  readonly spawn: Rng;
  /** AI decisions: tie-breaks, explore-target selection, future planning. */
  readonly ai: Rng;
  /** Reproduction: sex, crossover, mutation and birth randomness (Phase 3). */
  readonly repro: Rng;
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
  /** Cumulative deaths since creation (derived state, not serialized). */
  private deaths = 0;
  /** Cumulative births since creation (derived state, not serialized). */
  private births = 0;
  private readonly ctx: TickContext;

  private constructor(parts: SimulationParts) {
    this.seed = parts.seed;
    this.config = parts.config;
    this.world = parts.world;
    this.tickCount = parts.tickCount;
    this.ecs = new SimulationEcs(parts.config.memory.capacity);
    this.rng = parts.rng;
    this.events = new EventLog(() => ({
      tick: this.tickCount,
      timeHours: this.tickCount * this.config.time.hoursPerTick,
    }));
    this.ctx = {
      ecs: this.ecs,
      world: this.world,
      config: this.config,
      events: this.events,
      rng: this.rng.sim,
      aiRng: this.rng.ai,
      reproRng: this.rng.repro,
      resourceIndex: new ResourceIndex(
        this.world.width,
        this.world.height,
        this.config.ai.perceptionRadiusTiles,
      ),
      agentIndex: new AgentIndex(
        this.world.width,
        this.world.height,
        this.config.reproduction.partnerSeekRadiusTiles,
      ),
      dtHours: this.config.time.hoursPerTick,
      tick: this.tickCount,
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
        ai: Rng.fromSeed(deriveStreamSeed(seed, 'ai')),
        repro: Rng.fromSeed(deriveStreamSeed(seed, 'repro')),
      },
    });
    spawnInitialAgents(simulation.ecs, simulation.world, simulation.config, simulation.rng.spawn, simulation.events);
    simulation.events.record('simulation_started', { detail: `seed=${seed}` });
    return simulation;
  }

  /**
   * Rebuild a simulation from persisted state (see persistence/serialization).
   * The event history is not persisted — the log starts empty on restore.
   */
  static restore(parts: {
    seed: number;
    config: SimulationConfig;
    world: World;
    tickCount: number;
    rngStates: { sim: RngState; spawn: RngState; ai: RngState; repro: RngState };
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
        ai: Rng.fromState(parts.rngStates.ai),
        repro: Rng.fromState(parts.rngStates.repro),
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

  /** Cumulative number of deaths since the simulation was created. */
  get deathCount(): number {
    return this.deaths;
  }

  /** Cumulative number of births since the simulation was created. */
  get birthCount(): number {
    return this.births;
  }

  /**
   * Advance the simulation by exactly one fixed timestep.
   * System order is part of the determinism contract and must not change
   * without bumping the save format version:
   *
   *   1.  selectIntents        — decide what each agent wants (writes intents)
   *   2.  moveAgents           — travel toward movement-intent targets
   *   3.  interactWithResources— Eat/Drink: consume, relieve needs, learn
   *   4.  updateNeeds          — needs rise, energy flows, health damage/regen
   *   5.  updateDeaths         — remove agents whose health hit zero
   *   6.  updateMemory         — forget unused memories (decay + prune)
   *   7.  regenerateResources  — food/water regrow toward their caps
   *   8.  updateAging          — advance age
   *   9.  updateMortality      — age-related health drain for elderly
   *   10. updateReproduction   — birth children from SeekPartner pairings
   *
   * Reproduction runs last so children are created at age 0 (not aged this
   * tick), and so dead/low-health agents are already removed before they could
   * breed. Children therefore begin interacting (and being aged) on the next
   * tick — their age is exactly 0 on the tick they are born.
   */
  step(): void {
    this.ctx.tick = this.tickCount;
    selectIntents(this.ctx); // 1. decision
    moveAgents(this.ctx); // 2. travel
    interactWithResources(this.ctx); // 3. eat / drink / learn
    updateNeeds(this.ctx); // 4. need & health dynamics
    this.deaths += updateDeaths(this.ctx); // 5. death (health <= 0)
    updateMemory(this.ctx); // 6. forgetting
    regenerateResources(this.ctx); // 7. regrowth
    updateAging(this.ctx); // 8. age
    updateMortality(this.ctx); // 9. age-related mortality pressure
    this.births += updateReproduction(this.ctx); // 10. births & lineage
    this.tickCount++;
  }

  /** Serializable RNG states (part of the save state). */
  getRngStates(): { sim: RngState; spawn: RngState; ai: RngState; repro: RngState } {
    return {
      sim: this.rng.sim.getState(),
      spawn: this.rng.spawn.getState(),
      ai: this.rng.ai.getState(),
      repro: this.rng.repro.getState(),
    };
  }
}
