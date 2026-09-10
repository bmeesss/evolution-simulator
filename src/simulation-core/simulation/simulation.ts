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
import { GroupRegistry, createSocialStats, restoreSocialStats, serializeSocialStats } from '../social';
import type { GroupRegistry as GroupRegistryType, SocialStats, SerializedSocialStats } from '../social';
import { selectIntents } from '../ai';
import { ResourceIndex, AgentIndex } from '../ai/perception';
import type { TickContext } from './tick-context';
import type { SimulationConfig } from './config';
import { spawnInitialAgents } from './systems/spawn';
import { moveAgents } from './systems/movement-system';
import { updateNeeds } from './systems/needs-system';
import { interactWithResources } from './systems/resource-system';
import { updateSocialInteractions } from './systems/social-system';
import { updateSocialState } from './systems/social-maintenance';
import { updateGroups } from './systems/group-system';
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
  /** Emergent group registry — derived social communities (Phase 4). */
  readonly groups: GroupRegistryType;
  /** Cumulative social counters (Phase 4). */
  readonly socialStats: SocialStats;

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
    this.ecs = new SimulationEcs(parts.config.memory.capacity, parts.config.social.memory.capacity);
    this.rng = parts.rng;
    this.groups = new GroupRegistry();
    this.socialStats = createSocialStats();
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
      socialIndex: new AgentIndex(
        this.world.width,
        this.world.height,
        this.config.social.perception.radiusTiles,
      ),
      groups: this.groups,
      socialStats: this.socialStats,
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
    groups: ReturnType<GroupRegistryType['serialize']>;
    socialStats: SerializedSocialStats;
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
    simulation.groups.restore(parts.groups);
    simulation.socialStatsRestore(parts.socialStats);
    return simulation;
  }

  private socialStatsRestore(saved: SerializedSocialStats): void {
    const restored = restoreSocialStats(saved);
    this.socialStats.cooperationEvents = restored.cooperationEvents;
    this.socialStats.conflictEvents = restored.conflictEvents;
    this.socialStats.helpEvents = restored.helpEvents;
    this.socialStats.socialInteractionEvents = restored.socialInteractionEvents;
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
   *   1.  selectIntents         — decide what each agent wants (writes intents)
   *   2.  moveAgents            — travel toward movement-intent targets
   *   3.  interactWithResources — Eat/Drink: consume, relieve needs, learn
   *   4.  updateSocialInteractions — Socialize/Help/Cooperate/Confront in
   *                                  reach + presence familiarity (Phase 4)
   *   5.  updateNeeds           — needs rise, energy flows, health damage/regen
   *   6.  updateDeaths          — remove agents whose health hit zero
   *   7.  updateSocialState     — loneliness, familiarity decay, relationship
   *                               pruning (after deaths; sees fresh stores)
   *   8.  updateMemory          — forget unused memories (decay + prune)
   *   9.  regenerateResources   — food/water regrow toward their caps
   *   10. updateAging           — advance age
   *   11. updateMortality       — age-related health drain for elderly
   *   12. updateReproduction    — birth children from SeekPartner pairings
   *   13. updateGroups          — periodic emergent community detection
   *                               (runs only every detectionIntervalTicks)
   *
   * Reproduction runs late so children are created at age 0 (not aged this
   * tick), and so dead/low-health agents are already removed before they could
   * breed. Group detection runs last so it sees this tick's final social state
   * (including newborn kin seeds) and its heavy clustering work happens at
   * most once per detection interval.
   */
  step(): void {
    this.ctx.tick = this.tickCount;
    selectIntents(this.ctx); // 1. decision
    moveAgents(this.ctx); // 2. travel
    interactWithResources(this.ctx); // 3. eat / drink / learn
    updateSocialInteractions(this.ctx); // 4. social consequences (Phase 4)
    updateNeeds(this.ctx); // 5. need & health dynamics
    this.deaths += updateDeaths(this.ctx); // 6. death (health <= 0)
    updateSocialState(this.ctx); // 7. social slow dynamics (Phase 4)
    updateMemory(this.ctx); // 8. forgetting
    regenerateResources(this.ctx); // 9. regrowth
    updateAging(this.ctx); // 10. age
    updateMortality(this.ctx); // 11. age-related mortality pressure
    this.births += updateReproduction(this.ctx); // 12. births & lineage
    updateGroups(this.ctx); // 13. emergent groups (periodic, Phase 4)
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

  /** Serializable group registry (part of the save state). */
  getSerializedGroups(): ReturnType<GroupRegistryType['serialize']> {
    return this.groups.serialize();
  }

  /** Serializable social statistics (part of the save state). */
  getSerializedSocialStats(): SerializedSocialStats {
    return serializeSocialStats(this.socialStats);
  }
}
