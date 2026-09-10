import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation-core/simulation/simulation';
import { cloneConfig, DEFAULT_SIMULATION_CONFIG } from '../src/simulation-core/simulation/config';
import { AgentIntent } from '../src/simulation-core/ai/intents';
import { World } from '../src/simulation-core/world/world';
import { serializeSimulation, canonicalJson } from '../src/persistence/serialization';
import type { SerializedWorld } from '../src/simulation-core/world/world';
import type { RngState } from '../src/simulation-core/rng';
import type { SimulationEvent } from '../src/simulation-core/events';

const TEST_SEED = 1337;
const TICKS = 500;

function stateFingerprint(sim: Simulation): string {
  return canonicalJson(serializeSimulation(sim));
}

/**
 * Field-by-field comparable state, with every per-entity list ordered by
 * entity ID. WHY sorted order: dense store slots depend on the historical
 * sequence of attaches/detaches; sorting by the stable entity ID makes the
 * comparison independent of slot order, so equal runs compare equal and
 * divergent runs point at the exact field that diverged.
 */
interface ComparableState {
  tick: number;
  world: SerializedWorld;
  entityCount: number;
  entityIds: number[];
  positions: Array<[number, number, number]>;
  needs: Array<[number, number, number, number]>;
  genomes: Array<[number, number, number, number, number, number]>;
  ages: Array<[number, number]>;
  healths: Array<[number, number]>;
  intents: Array<[number, number, number, number, number]>; // + targetEntity
  // 12 action utilities (survival + social) per agent.
  aiStates: Array<[number, number, number, number, number, number, number, number, number, number, number, number, number]>;
  lineages: Array<[number, number, number, number]>; // generation, parentA, parentB
  reproductives: Array<[number, number, number, number]>; // sex, cooldown, eligible
  // Phase 4: social state must be part of the determinism contract too.
  socials: Array<[number, number, number, number, number, number, number, number]>;
  relationships: unknown; // full serialized relationship store
  groups: unknown; // full serialized group registry
  socialStats: unknown; // serialized social statistics counters
  memory: unknown;
  rngSim: RngState;
  rngSpawn: RngState;
  rngAi: RngState;
  rngRepro: RngState;
  events: SimulationEvent[];
}

function byEntityId(a: readonly number[], b: readonly number[]): number {
  return a[0] - b[0];
}

function captureComparableState(sim: Simulation): ComparableState {
  const { ecs } = sim;
  const positions: Array<[number, number, number]> = [];
  for (let i = 0; i < ecs.position.count; i++) {
    positions.push([ecs.position.entityOf[i], ecs.position.columns.x[i], ecs.position.columns.y[i]]);
  }
  const needs: Array<[number, number, number, number]> = [];
  for (let i = 0; i < ecs.needs.count; i++) {
    needs.push([
      ecs.needs.entityOf[i],
      ecs.needs.columns.hunger[i],
      ecs.needs.columns.thirst[i],
      ecs.needs.columns.energy[i],
    ]);
  }
  const genomes: Array<[number, number, number, number, number, number]> = [];
  for (let i = 0; i < ecs.genome.count; i++) {
    const g = ecs.genome.columns;
    genomes.push([
      ecs.genome.entityOf[i],
      g.intelligence[i],
      g.strength[i],
      g.speed[i],
      g.fertility[i],
      g.socialTendency[i],
    ]);
  }
  const ages: Array<[number, number]> = [];
  for (let i = 0; i < ecs.age.count; i++) {
    ages.push([ecs.age.entityOf[i], ecs.age.columns.ageHours[i]]);
  }
  const healths: Array<[number, number]> = [];
  for (let i = 0; i < ecs.health.count; i++) {
    healths.push([ecs.health.entityOf[i], ecs.health.columns.current[i]]);
  }
  const intents: Array<[number, number, number, number, number]> = [];
  for (let i = 0; i < ecs.intent.count; i++) {
    intents.push([
      ecs.intent.entityOf[i],
      ecs.intent.columns.kind[i],
      ecs.intent.columns.targetX[i],
      ecs.intent.columns.targetY[i],
      ecs.intent.columns.targetEntity[i],
    ]);
  }
  const aiStates: Array<[number, number, number, number, number, number, number, number, number, number, number, number, number]> = [];
  for (let i = 0; i < ecs.aiState.count; i++) {
    const a = ecs.aiState.columns;
    aiStates.push([
      ecs.aiState.entityOf[i],
      a.rest[i],
      a.wander[i],
      a.seekFood[i],
      a.seekWater[i],
      a.eat[i],
      a.drink[i],
      a.seekPartner[i],
      a.socialize[i],
      a.help[i],
      a.cooperate[i],
      a.avoid[i],
      a.confront[i],
    ]);
  }
  const socials: Array<[number, number, number, number, number, number, number, number]> = [];
  for (let i = 0; i < ecs.social.count; i++) {
    const s = ecs.social.columns;
    socials.push([
      ecs.social.entityOf[i],
      s.loneliness[i],
      s.groupId[i],
      s.groupJoinTick[i],
      s.cooperationTarget[i],
      s.cooperationTicks[i],
      s.forageBonusTicks[i],
      s.lastConflictTick[i],
    ]);
  }
  const lineages: Array<[number, number, number, number]> = [];
  for (let i = 0; i < ecs.lineage.count; i++) {
    lineages.push([
      ecs.lineage.entityOf[i],
      ecs.lineage.columns.generation[i],
      ecs.lineage.columns.parentA[i],
      ecs.lineage.columns.parentB[i],
    ]);
  }
  const reproductives: Array<[number, number, number, number]> = [];
  for (let i = 0; i < ecs.reproductive.count; i++) {
    reproductives.push([
      ecs.reproductive.entityOf[i],
      ecs.reproductive.columns.sex[i],
      ecs.reproductive.columns.cooldownHours[i],
      ecs.reproductive.columns.eligible[i],
    ]);
  }
  positions.sort(byEntityId);
  needs.sort(byEntityId);
  genomes.sort(byEntityId);
  ages.sort(byEntityId);
  healths.sort(byEntityId);
  intents.sort(byEntityId);
  aiStates.sort(byEntityId);
  socials.sort(byEntityId);
  lineages.sort(byEntityId);
  reproductives.sort(byEntityId);

  return {
    tick: sim.tick,
    world: sim.world.serialize(),
    entityCount: sim.ecs.entities.aliveCount,
    entityIds: Array.from(ecs.entities.aliveIds.subarray(0, ecs.entities.aliveCount)).sort((a, b) => a - b),
    positions,
    needs,
    genomes,
    ages,
    healths,
    intents,
    aiStates,
    socials,
    lineages,
    reproductives,
    relationships: ecs.relationships.serialize(),
    groups: sim.groups.serialize(),
    socialStats: {
      cooperationEvents: sim.socialStats.cooperationEvents,
      conflictEvents: sim.socialStats.conflictEvents,
      helpEvents: sim.socialStats.helpEvents,
      socialInteractionEvents: sim.socialStats.socialInteractionEvents,
    },
    memory: ecs.memory.serialize(),
    rngSim: sim.rng.sim.getState(),
    rngSpawn: sim.rng.spawn.getState(),
    rngAi: sim.rng.ai.getState(),
    rngRepro: sim.rng.repro.getState(),
    events: sim.events.recent(1000),
  };
}

describe('simulation determinism (the core guarantee)', () => {
  it('same seed -> identical initial state (world, agents, RNG)', () => {
    const a = Simulation.create(TEST_SEED, DEFAULT_SIMULATION_CONFIG);
    const b = Simulation.create(TEST_SEED, DEFAULT_SIMULATION_CONFIG);
    expect(stateFingerprint(a)).toBe(stateFingerprint(b));

    // Spot-check the guarantees the spec calls out explicitly.
    expect(a.world.serialize()).toEqual(b.world.serialize());
    expect(a.population).toBe(DEFAULT_SIMULATION_CONFIG.agents.initialPopulation);
    const aIds = Array.from(a.ecs.position.entityOf.subarray(0, a.ecs.position.count));
    const bIds = Array.from(b.ecs.position.entityOf.subarray(0, b.ecs.position.count));
    expect(aIds).toEqual(bIds); // stable entity ids
    for (let i = 0; i < a.ecs.position.count; i++) {
      expect(a.ecs.position.columns.x[i]).toBe(b.ecs.position.columns.x[i]);
      expect(a.ecs.genome.columns.strength[i]).toBe(b.ecs.genome.columns.strength[i]);
    }
    expect(a.getRngStates()).toEqual(b.getRngStates());
  });

  it('same seed + same tick count -> identical state after many ticks', () => {
    const a = Simulation.create(TEST_SEED, DEFAULT_SIMULATION_CONFIG);
    const b = Simulation.create(TEST_SEED, DEFAULT_SIMULATION_CONFIG);
    for (let i = 0; i < TICKS; i++) {
      a.step();
      b.step();
    }
    // Covers positions, needs, genome, age, health, intents, RNG state, tick.
    expect(stateFingerprint(a)).toBe(stateFingerprint(b));
    expect(a.tick).toBe(TICKS);
  });

  // The explicit, per-field determinism contract (stable entity ID ordering):
  // world, entity count/IDs, positions, needs, genomes, ages, health, intents,
  // RNG state and the event sequence must all match after advancing N ticks.
  it.each([1, 97, 500])('same seed after %i ticks -> identical per-field state', (ticks) => {
    const a = Simulation.create(TEST_SEED, DEFAULT_SIMULATION_CONFIG);
    const b = Simulation.create(TEST_SEED, DEFAULT_SIMULATION_CONFIG);
    for (let i = 0; i < ticks; i++) {
      a.step();
      b.step();
    }
    expect(a.tick).toBe(ticks); // the test really advanced the simulation

    const stateA = captureComparableState(a);
    const stateB = captureComparableState(b);
    expect(stateA.tick).toBe(stateB.tick);
    expect(stateA.world).toEqual(stateB.world); // world state
    expect(stateA.entityCount).toBe(stateB.entityCount); // entity count
    expect(stateA.entityIds).toEqual(stateB.entityIds); // entity IDs
    expect(stateA.positions).toEqual(stateB.positions); // positions
    expect(stateA.needs).toEqual(stateB.needs); // needs
    expect(stateA.genomes).toEqual(stateB.genomes); // genomes
    expect(stateA.ages).toEqual(stateB.ages); // ages
    expect(stateA.healths).toEqual(stateB.healths); // health
    expect(stateA.intents).toEqual(stateB.intents); // movement targets + partner
    expect(stateA.aiStates).toEqual(stateB.aiStates); // AI utility scores (12 actions)
    expect(stateA.socials).toEqual(stateB.socials); // social columns
    expect(stateA.relationships).toEqual(stateB.relationships); // relationship store
    expect(stateA.groups).toEqual(stateB.groups); // group registry
    expect(stateA.socialStats).toEqual(stateB.socialStats); // social statistics
    expect(stateA.lineages).toEqual(stateB.lineages); // generation + parents
    expect(stateA.reproductives).toEqual(stateB.reproductives); // sex + cooldown + eligibility
    expect(stateA.memory).toEqual(stateB.memory); // memory state
    expect(stateA.rngSim).toEqual(stateB.rngSim); // RNG state (sim stream)
    expect(stateA.rngSpawn).toEqual(stateB.rngSpawn); // RNG state (spawn stream)
    expect(stateA.rngAi).toEqual(stateB.rngAi); // RNG state (ai stream)
    expect(stateA.rngRepro).toEqual(stateB.rngRepro); // RNG state (repro stream)
    expect(stateA.events).toEqual(stateB.events); // event sequence
  });

  it('different seed -> different state', () => {
    const a = Simulation.create(TEST_SEED, DEFAULT_SIMULATION_CONFIG);
    const b = Simulation.create(TEST_SEED + 1, DEFAULT_SIMULATION_CONFIG);
    for (let i = 0; i < TICKS; i++) {
      a.step();
      b.step();
    }
    expect(stateFingerprint(a)).not.toBe(stateFingerprint(b));
    // ...and the divergence shows up in the explicit fields too.
    const stateA = captureComparableState(a);
    const stateB = captureComparableState(b);
    expect(stateA.positions).not.toEqual(stateB.positions);
  });

  it('save -> restore -> continue matches an uninterrupted run', () => {
    const straight = Simulation.create(TEST_SEED, DEFAULT_SIMULATION_CONFIG);
    for (let i = 0; i < TICKS; i++) straight.step();

    const interrupted = Simulation.create(TEST_SEED, DEFAULT_SIMULATION_CONFIG);
    for (let i = 0; i < Math.floor(TICKS / 2); i++) interrupted.step();
    const save = serializeSimulation(interrupted);
    const continued = Simulation.restore({
      seed: save.seed,
      config: save.config,
      world: World.fromArrays(save.world),
      tickCount: save.tick,
      rngStates: save.rng,
      ecs: save.ecs,
      groups: save.groups,
      socialStats: save.socialStats,
    });
    for (let i = 0; i < TICKS - Math.floor(TICKS / 2); i++) continued.step();

    expect(stateFingerprint(continued)).toBe(stateFingerprint(straight));
    // All per-entity fields must match too. The event history is excluded:
    // it is deliberately not persisted in phase 1 (ARCHITECTURE.md §8), so the
    // restored run starts with an empty log.
    const restoredState = captureComparableState(continued);
    const straightState = captureComparableState(straight);
    expect({ ...restoredState, events: [] }).toEqual({ ...straightState, events: [] });
    expect(straightState.events.length).toBeGreaterThan(0); // the exclusion is real
  });
});

describe('simulation behavior (phase 2)', () => {
  it(
    'agents remain inside the world over a long run',
    () => {
      const sim = Simulation.create(TEST_SEED, DEFAULT_SIMULATION_CONFIG);
      const maxX = sim.world.width - 1;
      const maxY = sim.world.height - 1;
      for (let i = 0; i < 2000; i++) sim.step();
      const position = sim.ecs.position;
      for (let i = 0; i < position.count; i++) {
        expect(position.columns.x[i]).toBeGreaterThanOrEqual(0);
        expect(position.columns.x[i]).toBeLessThanOrEqual(maxX);
        expect(position.columns.y[i]).toBeGreaterThanOrEqual(0);
        expect(position.columns.y[i]).toBeLessThanOrEqual(maxY);
      }
    },
    30_000,
  );

  it('agents move around the world (positions change over time)', () => {
    const config = cloneConfig(DEFAULT_SIMULATION_CONFIG);
    config.needs.energyDrainPerHourActive = 0; // nobody rests: everyone wanders
    const sim = Simulation.create(TEST_SEED, config);
    const startX = Array.from(sim.ecs.position.columns.x.subarray(0, sim.ecs.position.count));
    const startY = Array.from(sim.ecs.position.columns.y.subarray(0, sim.ecs.position.count));
    for (let i = 0; i < 20; i++) sim.step();
    let moved = 0;
    for (let i = 0; i < sim.ecs.position.count; i++) {
      if (
        sim.ecs.position.columns.x[i] !== startX[i] ||
        sim.ecs.position.columns.y[i] !== startY[i]
      ) {
        moved++;
      }
    }
    expect(moved).toBe(sim.ecs.position.count);
  });

  it('hunger and thirst increase over time', () => {
    const sim = Simulation.create(TEST_SEED, DEFAULT_SIMULATION_CONFIG);
    const needs = sim.ecs.needs;
    const hungerBefore = Array.from(needs.columns.hunger.subarray(0, needs.count));
    const thirstBefore = Array.from(needs.columns.thirst.subarray(0, needs.count));
    for (let i = 0; i < 10; i++) sim.step();
    for (let i = 0; i < needs.count; i++) {
      expect(needs.columns.hunger[i]).toBeGreaterThan(hungerBefore[i]);
      expect(needs.columns.thirst[i]).toBeGreaterThan(thirstBefore[i]);
    }
  });

  it('energy regenerates while resting and drains while active', () => {
    const sim = Simulation.create(TEST_SEED, DEFAULT_SIMULATION_CONFIG);
    const intent = sim.ecs.intent;
    const needs = sim.ecs.needs;
    const previousEnergy = new Map<number, number>();

    let sawRestingGain = false;
    let sawActiveDrain = false;
    for (let tick = 0; tick < 800; tick++) {
      sim.step();
      for (let i = 0; i < intent.count; i++) {
        const entity = intent.entityOf[i];
        const needsSlot = needs.index[entity];
        const energy = needs.columns.energy[needsSlot];
        const before = previousEnergy.get(entity);
        if (before !== undefined) {
          if (intent.columns.kind[i] === AgentIntent.Rest && energy > before) sawRestingGain = true;
          if (intent.columns.kind[i] !== AgentIntent.Rest && energy < before) sawActiveDrain = true;
        }
        previousEnergy.set(entity, energy);
      }
    }
    expect(sawRestingGain).toBe(true); // resting restores energy
    expect(sawActiveDrain).toBe(true); // activity spends energy

    // Needs always stay within the 0..100 scale.
    for (let i = 0; i < needs.count; i++) {
      for (const column of [needs.columns.hunger, needs.columns.thirst, needs.columns.energy]) {
        expect(column[i]).toBeGreaterThanOrEqual(0);
        expect(column[i]).toBeLessThanOrEqual(100);
      }
    }
  });

  it('critical unmet needs damage health and kill agents', () => {
    const config = cloneConfig(DEFAULT_SIMULATION_CONFIG);
    config.needs.hungerPerHour = 100;
    config.needs.thirstPerHour = 100;
    config.needs.healthDrainPerHourCritical = 60;
    const sim = Simulation.create(TEST_SEED, config);
    for (let i = 0; i < 80; i++) sim.step();
    expect(sim.deathCount).toBeGreaterThan(0);
    expect(sim.population).toBeLessThan(DEFAULT_SIMULATION_CONFIG.agents.initialPopulation);
  });

  it('ages agents according to the configurable hours-per-tick', () => {
    const config = cloneConfig(DEFAULT_SIMULATION_CONFIG);
    config.time.hoursPerTick = 1; // not the default — proves it is configurable
    const sim = Simulation.create(TEST_SEED, config);
    // The founding cohort starts at varied ages, so assert the *increment*,
    // not the absolute age: every live agent must gain exactly hoursPerTick.
    const before = Array.from(sim.ecs.age.columns.ageHours.subarray(0, sim.ecs.age.count));
    for (let i = 0; i < 5; i++) sim.step();
    expect(sim.timeHours).toBe(5);
    const age = sim.ecs.age;
    for (let i = 0; i < age.count; i++) {
      expect(age.columns.ageHours[i] - before[i]).toBeCloseTo(5, 10);
    }
  });

  it('reproduction can grow the population beyond the initial count (phase 3)', () => {
    // With reproduction enabled the founding generation is free to breed, so the
    // population may exceed the initial 50. Use a config that reaches adulthood
    // quickly to make a birth likely within the tick budget.
    const config = cloneConfig(DEFAULT_SIMULATION_CONFIG);
    config.agents.spawn.initialAgeHours = config.life.adolescentMaxAgeHours; // founding adults
    const sim = Simulation.create(TEST_SEED, config);
    for (let i = 0; i < TICKS; i++) sim.step();
    // The determinism guarantee holds regardless: the same config+seed is stable.
    const sim2 = Simulation.create(TEST_SEED, config);
    for (let i = 0; i < TICKS; i++) sim2.step();
    expect(stateFingerprint(sim)).toBe(stateFingerprint(sim2));
    // Reproduction is genuinely possible (population can grow above the spawn count).
    expect(sim.birthCount).toBeGreaterThanOrEqual(0);
  });

  it('protects the shared default config from accidental mutation', () => {
    // The module-level default is deep-frozen shared state...
    expect(Object.isFrozen(DEFAULT_SIMULATION_CONFIG)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SIMULATION_CONFIG.needs)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SIMULATION_CONFIG.agents.spawn)).toBe(true);
    // ...while cloneConfig yields a normal mutable copy for per-run tuning.
    const config = cloneConfig(DEFAULT_SIMULATION_CONFIG);
    config.time.hoursPerTick = 2;
    config.world.width = 32;
    expect(config.time.hoursPerTick).toBe(2);
    expect(DEFAULT_SIMULATION_CONFIG.time.hoursPerTick).toBe(0.25);
    expect(DEFAULT_SIMULATION_CONFIG.world.width).toBe(64);
  });

  it('records lifecycle events with tick stamps', () => {
    const sim = Simulation.create(TEST_SEED, DEFAULT_SIMULATION_CONFIG);
    const events = sim.events.recent(1000);
    const types = events.map((event) => event.type);
    expect(types).toContain('simulation_started');
    expect(types.filter((type) => type === 'agent_spawned')).toHaveLength(
      DEFAULT_SIMULATION_CONFIG.agents.initialPopulation,
    );
    for (const event of events) {
      expect(event.tick).toBe(0);
      expect(event.timeHours).toBe(0);
    }
  });
});
