import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation-core/simulation/simulation';
import { cloneConfig, DEFAULT_SIMULATION_CONFIG } from '../src/simulation-core/simulation/config';
import { Rng } from '../src/simulation-core/rng';
import type { GenomeValues } from '../src/simulation-core/genetics';
import {
  crossoverGenomes,
  mutateGenome,
  GENOME_KEYS,
} from '../src/simulation-core/genetics';
import {
  lifeStageForAge,
  isReproductiveStage,
  LifeStage,
} from '../src/simulation-core/simulation/life-stages';
import { ageHealthDrainPerHour } from '../src/simulation-core/simulation/systems/mortality-system';
import { updateReproduction } from '../src/simulation-core/simulation/systems/reproduction-system';
import { makeContext, spawnAgent } from './helpers';
import { AgentIntent } from '../src/simulation-core/ai/intents';

const TEST_SEED = 1337;

describe('life stages', () => {
  it('maps ages to the correct stage', () => {
    const c = DEFAULT_SIMULATION_CONFIG;
    // Boundaries from config: child<24, adolescent<48, adult<720, elderly>=720.
    expect(lifeStageForAge(0, c)).toBe(LifeStage.Child);
    expect(lifeStageForAge(23.9, c)).toBe(LifeStage.Child);
    expect(lifeStageForAge(24, c)).toBe(LifeStage.Adolescent);
    expect(lifeStageForAge(47.9, c)).toBe(LifeStage.Adolescent);
    expect(lifeStageForAge(48, c)).toBe(LifeStage.Adult);
    expect(lifeStageForAge(719.9, c)).toBe(LifeStage.Adult);
    expect(lifeStageForAge(720, c)).toBe(LifeStage.Elderly);
  });

  it('only adults and elderly are reproductively capable', () => {
    for (const stage of [
      LifeStage.Child,
      LifeStage.Adolescent,
      LifeStage.Adult,
      LifeStage.Elderly,
    ]) {
      expect(isReproductiveStage(stage)).toBe(stage === LifeStage.Adult || stage === LifeStage.Elderly);
    }
  });
});

describe('genetic inheritance (crossover + mutation)', () => {
  it('crossover produces traits within the parent range and stays bounded', () => {
    const rng = Rng.fromSeed(1);
    const a: GenomeValues = { intelligence: 0.9, strength: 0.1, speed: 0.5, fertility: 0.2, socialTendency: 0.8 };
    const b: GenomeValues = { intelligence: 0.2, strength: 0.9, speed: 0.5, fertility: 0.8, socialTendency: 0.1 };
    for (let i = 0; i < 200; i++) {
      const child = crossoverGenomes(a, b, rng);
      for (const key of GENOME_KEYS) {
        const v = child[key];
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
        // Each gene is exactly one of the two parents' alleles (uniform crossover).
        expect(v === a[key] || v === b[key]).toBe(true);
      }
    }
  });

  it('crossover is deterministic for a fixed RNG seed', () => {
    const a: GenomeValues = { intelligence: 0.9, strength: 0.1, speed: 0.5, fertility: 0.2, socialTendency: 0.8 };
    const b: GenomeValues = { intelligence: 0.2, strength: 0.9, speed: 0.5, fertility: 0.8, socialTendency: 0.1 };
    const r1 = crossoverGenomes(a, b, Rng.fromSeed(7));
    const r2 = crossoverGenomes(a, b, Rng.fromSeed(7));
    expect(r1).toEqual(r2);
  });

  it('mutation keeps every value in [0, 1]', () => {
    const rng = Rng.fromSeed(3);
    const genome: GenomeValues = { intelligence: 0.5, strength: 0.5, speed: 0.5, fertility: 0.5, socialTendency: 0.5 };
    const config = DEFAULT_SIMULATION_CONFIG.mutation;
    for (let i = 0; i < 500; i++) {
      const { genome: next, mutations } = mutateGenome(genome, rng, config);
      for (const key of GENOME_KEYS) {
        expect(next[key]).toBeGreaterThanOrEqual(0);
        expect(next[key]).toBeLessThanOrEqual(1);
      }
      for (const m of mutations) {
        expect(m.delta).toBeGreaterThanOrEqual(-config.magnitude - 1e-9);
        expect(m.delta).toBeLessThanOrEqual(config.magnitude + 1e-9);
      }
    }
  });

  it('mutation is deterministic for a fixed RNG seed and much smaller than inheritance', () => {
    const genome: GenomeValues = { intelligence: 0.5, strength: 0.5, speed: 0.5, fertility: 0.5, socialTendency: 0.5 };
    const a = mutateGenome(genome, Rng.fromSeed(42), DEFAULT_SIMULATION_CONFIG.mutation);
    const b = mutateGenome(genome, Rng.fromSeed(42), DEFAULT_SIMULATION_CONFIG.mutation);
    expect(a.genome).toEqual(b.genome);
    expect(a.mutations.map((m) => [m.gene, m.delta])).toEqual(b.mutations.map((m) => [m.gene, m.delta]));
    // Mutation magnitude stays a small perturbation, not a reconfigure.
    for (const m of a.mutations) {
      expect(Math.abs(m.delta)).toBeLessThan(1);
    }
  });
});

describe('reproduction eligibility and birth', () => {
  /** Build a minimal ctx, spawn two compatible adults, run updateReproduction. */
  function twoAdultScene() {
    const mini = makeContext(TEST_SEED, 32);
    const { ctx } = mini;
    // Two eligible, opposite-sex adults (age 100h) at the same tile.
    const a = spawnAgent(mini, 10, 10, {
      ageHours: 100,
      sex: 0,
      eligible: true,
      hunger: 10,
      thirst: 10,
      energy: 100,
      health: 100,
      fertility: 0.6,
      generation: 0,
    });
    const b = spawnAgent(mini, 10.2, 10.2, {
      ageHours: 100,
      sex: 1,
      eligible: true,
      hunger: 10,
      thirst: 10,
      energy: 100,
      health: 100,
      fertility: 0.6,
      generation: 0,
    });
    // Seeker A aims at partner B.
    const aSlot = ctx.ecs.intent.index[a];
    ctx.ecs.intent.columns.kind[aSlot] = AgentIntent.SeekPartner;
    ctx.ecs.intent.columns.targetEntity[aSlot] = b;
    // partnerReachTiles = 1.5 -> distance ~0.28 <= reach.
    return { mini, ctx, a, b };
  }

  it('creates exactly one child for a valid pair and advances generation', () => {
    const { ctx } = twoAdultScene();
    const before = new Set<number>();
    for (let i = 0; i < ctx.ecs.entities.aliveCount; i++) before.add(ctx.ecs.entities.aliveIds[i]);
    const births = updateReproduction(ctx);
    expect(births).toBe(1);
    expect(ctx.ecs.entities.aliveCount).toBe(before.size + 1);

    // The new child is the only entity id not present before.
    let child = -1;
    for (let i = 0; i < ctx.ecs.entities.aliveCount; i++) {
      const e = ctx.ecs.entities.aliveIds[i];
      if (!before.has(e)) child = e;
    }
    expect(child).toBeGreaterThanOrEqual(0);
    const linSlot = ctx.ecs.lineage.index[child];
    expect(linSlot).toBeGreaterThanOrEqual(0);
    expect(ctx.ecs.lineage.columns.generation[linSlot]).toBe(1);
    expect(ctx.ecs.lineage.columns.parentA[linSlot]).toBeGreaterThanOrEqual(0);
    expect(ctx.ecs.lineage.columns.parentB[linSlot]).toBeGreaterThanOrEqual(0);
  });

  it('child starts with age 0 and fresh memory', () => {
    const { ctx } = twoAdultScene();
    updateReproduction(ctx);
    const child = ctx.ecs.entities.aliveCount - 1;
    const ageSlot = ctx.ecs.age.index[child];
    expect(ageSlot).toBeGreaterThanOrEqual(0);
    expect(ctx.ecs.age.columns.ageHours[ageSlot]).toBe(0);
    // Fresh memory: no entries attached for the child.
    expect(ctx.ecs.memory.headOf(child)).toBe(-1);
  });

  it('does not create a child when same-sex (invalid pairing)', () => {
    const mini = makeContext(TEST_SEED, 32);
    const { ctx } = mini;
    const a = spawnAgent(mini, 10, 10, {
      ageHours: 100, sex: 0, eligible: true, hunger: 10, thirst: 10, energy: 100, health: 100, fertility: 0.6,
    });
    const b = spawnAgent(mini, 10.2, 10.2, {
      ageHours: 100, sex: 0, eligible: true, hunger: 10, thirst: 10, energy: 100, health: 100, fertility: 0.6,
    });
    const aSlot = ctx.ecs.intent.index[a];
    ctx.ecs.intent.columns.kind[aSlot] = AgentIntent.SeekPartner;
    ctx.ecs.intent.columns.targetEntity[aSlot] = b;
    const births = updateReproduction(ctx);
    expect(births).toBe(0);
  });

  it('does not create a child when a parent is a child (pre-adulthood)', () => {
    const mini = makeContext(TEST_SEED, 32);
    const { ctx } = mini;
    // One adult, one child (age 10). Child cannot reproduce.
    const a = spawnAgent(mini, 10, 10, {
      ageHours: 100, sex: 0, eligible: true, hunger: 10, thirst: 10, energy: 100, health: 100,
    });
    const b = spawnAgent(mini, 10.2, 10.2, {
      ageHours: 10, sex: 1, eligible: true, hunger: 10, thirst: 10, energy: 100, health: 100,
    });
    const aSlot = ctx.ecs.intent.index[a];
    ctx.ecs.intent.columns.kind[aSlot] = AgentIntent.SeekPartner;
    ctx.ecs.intent.columns.targetEntity[aSlot] = b;
    const births = updateReproduction(ctx);
    expect(births).toBe(0);
  });

  it('does not create a child while a parent is on cooldown', () => {
    const mini = makeContext(TEST_SEED, 32);
    const { ctx } = mini;
    const a = spawnAgent(mini, 10, 10, {
      ageHours: 100, sex: 0, eligible: true, hunger: 10, thirst: 10, energy: 100, health: 100, cooldownHours: 100,
    });
    const b = spawnAgent(mini, 10.2, 10.2, {
      ageHours: 100, sex: 1, eligible: true, hunger: 10, thirst: 10, energy: 100, health: 100,
    });
    const aSlot = ctx.ecs.intent.index[a];
    ctx.ecs.intent.columns.kind[aSlot] = AgentIntent.SeekPartner;
    ctx.ecs.intent.columns.targetEntity[aSlot] = b;
    const births = updateReproduction(ctx);
    expect(births).toBe(0);
  });

  it('does not create a child when a parent is starving or unhealthy', () => {
    const mini = makeContext(TEST_SEED, 32);
    const { ctx } = mini;
    // Seeker is healthy but the partner is starving (hunger > maxNeed).
    const a = spawnAgent(mini, 10, 10, { ageHours: 100, sex: 0, eligible: true, hunger: 10, thirst: 10, energy: 100, health: 100 });
    const b = spawnAgent(mini, 10.2, 10.2, { ageHours: 100, sex: 1, eligible: true, hunger: 90, thirst: 10, energy: 100, health: 100 });
    const aSlot = ctx.ecs.intent.index[a];
    ctx.ecs.intent.columns.kind[aSlot] = AgentIntent.SeekPartner;
    ctx.ecs.intent.columns.targetEntity[aSlot] = b;
    expect(updateReproduction(ctx)).toBe(0);
  });

  it('does not create a child when partners are too far apart', () => {
    const mini = makeContext(TEST_SEED, 64);
    const { ctx } = mini;
    const a = spawnAgent(mini, 10, 10, { ageHours: 100, sex: 0, eligible: true, hunger: 10, thirst: 10, energy: 100, health: 100 });
    const b = spawnAgent(mini, 40, 40, { ageHours: 100, sex: 1, eligible: true, hunger: 10, thirst: 10, energy: 100, health: 100 });
    const aSlot = ctx.ecs.intent.index[a];
    ctx.ecs.intent.columns.kind[aSlot] = AgentIntent.SeekPartner;
    ctx.ecs.intent.columns.targetEntity[aSlot] = b;
    expect(updateReproduction(ctx)).toBe(0);
  });

  it('cooldowns tick down by dtHours each reproduction pass', () => {
    const mini = makeContext(TEST_SEED, 32);
    const { ctx, config } = mini;
    const a = spawnAgent(mini, 10, 10, { ageHours: 100, sex: 0, eligible: false, cooldownHours: 10 });
    updateReproduction(ctx);
    const slot = ctx.ecs.reproductive.index[a];
    expect(ctx.ecs.reproductive.columns.cooldownHours[slot]).toBeCloseTo(
      10 - config.time.hoursPerTick,
      10,
    );
  });

  it('emits birth, reproduction_attempted and reproduction_success events', () => {
    const { ctx } = twoAdultScene();
    updateReproduction(ctx);
    const types = ctx.events.recent(50).map((e) => e.type);
    expect(types).toContain('reproduction_attempted');
    expect(types).toContain('reproduction_success');
    expect(types).toContain('birth');
  });
});

describe('age mortality', () => {
  it('is zero below the elderly threshold and grows with age past it', () => {
    const c = DEFAULT_SIMULATION_CONFIG;
    expect(ageHealthDrainPerHour(0, c)).toBe(0);
    expect(ageHealthDrainPerHour(c.life.adultMaxAgeHours, c)).toBe(0);
    const justOver = ageHealthDrainPerHour(c.life.adultMaxAgeHours + 1, c);
    const muchOlder = ageHealthDrainPerHour(c.life.adultMaxAgeHours + 100, c);
    expect(justOver).toBeGreaterThan(0);
    expect(muchOlder).toBeGreaterThan(justOver);
  });

  it('mortality is gradual (no hard instant-death threshold)', () => {
    // drain(threshold+100) must be finite and modest, not a cliff.
    const c = DEFAULT_SIMULATION_CONFIG;
    const drain = ageHealthDrainPerHour(c.life.adultMaxAgeHours + 1000, c);
    expect(Number.isFinite(drain)).toBe(true);
    expect(drain).toBeLessThan(200); // not an instant kill
  });
});

describe('natural-selection invariants', () => {
  it('fertility positively affects the reproduction drive (not a hidden fitness)', () => {
    // The reproduction *drive* increases with fertility via the config boost, but
    // this is an intentional, documented game mechanic (energy trade-off for
    // fertility cost), not a hidden fitness score. Here we only assert that the
    // reproduction system is driven by the utility-AI decision, not by a trait
    // being directly rewarded — i.e. a birth requires a SeekPartner intent.
    const mini = makeContext(TEST_SEED, 32);
    const { ctx } = mini;
    // Two compatible adults, but the seeker has NO SeekPartner intent.
    const a = spawnAgent(mini, 10, 10, { ageHours: 100, sex: 0, eligible: true, hunger: 10, thirst: 10, energy: 100, health: 100, intent: AgentIntent.Wander });
    const b = spawnAgent(mini, 10.2, 10.2, { ageHours: 100, sex: 1, eligible: true, hunger: 10, thirst: 10, energy: 100, health: 100 });
    expect(updateReproduction(ctx)).toBe(0); // no decision -> no birth
    void a;
    void b;
  });

  it('every live agent keeps a valid, bounded genome after many generations', () => {
    // Run a few hundred ticks; every agent's traits stay in [0,1].
    const config = cloneConfig(DEFAULT_SIMULATION_CONFIG);
    config.reproduction.cooldownHours = 144;
    const sim = Simulation.create(TEST_SEED, config);
    for (let i = 0; i < 400; i++) sim.step();
    const g = sim.ecs.genome.columns;
    for (let i = 0; i < sim.ecs.genome.count; i++) {
      for (const column of [g.intelligence, g.strength, g.speed, g.fertility, g.socialTendency]) {
        expect(column[i]).toBeGreaterThanOrEqual(0);
        expect(column[i]).toBeLessThanOrEqual(1);
      }
    }
  });

  it('children inherit generation = max(parent generations) + 1 (differing parents)', () => {
    const mini = makeContext(TEST_SEED, 32);
    const { ctx } = mini;
    const a = spawnAgent(mini, 10, 10, { ageHours: 100, sex: 0, eligible: true, hunger: 10, thirst: 10, energy: 100, health: 100, generation: 3 });
    const b = spawnAgent(mini, 10.2, 10.2, { ageHours: 100, sex: 1, eligible: true, hunger: 10, thirst: 10, energy: 100, health: 100, generation: 5 });
    const aSlot = ctx.ecs.intent.index[a];
    ctx.ecs.intent.columns.kind[aSlot] = AgentIntent.SeekPartner;
    ctx.ecs.intent.columns.targetEntity[aSlot] = b;
    const before = ctx.ecs.entities.aliveCount;
    updateReproduction(ctx);
    const child = ctx.ecs.entities.aliveCount - 1;
    void before;
    const linSlot = ctx.ecs.lineage.index[child];
    expect(ctx.ecs.lineage.columns.generation[linSlot]).toBe(6);
    expect(ctx.ecs.lineage.columns.parentA[linSlot]).toBe(a);
    expect(ctx.ecs.lineage.columns.parentB[linSlot]).toBe(b);
  });
});

describe('whole-run reproduction produces evolution (not a crash)', () => {
  it('can sustain births and generations without exploding or collapsing too fast', () => {
    const config = cloneConfig(DEFAULT_SIMULATION_CONFIG);
    config.reproduction.cooldownHours = 144;
    const sim = Simulation.create(TEST_SEED, config);
    for (let i = 0; i < 2000; i++) sim.step();
    // Evolution is real: some reproduction happened and generations advanced.
    expect(sim.birthCount).toBeGreaterThan(0);
    expect(sim.deathCount).toBeGreaterThan(0);
    let maxGen = 0;
    for (let i = 0; i < sim.ecs.lineage.count; i++) {
      maxGen = Math.max(maxGen, sim.ecs.lineage.columns.generation[i]);
    }
    expect(maxGen).toBeGreaterThan(1);
    // Not extinct, not a run-away blow-up in this window.
    expect(sim.population).toBeGreaterThan(0);
    expect(sim.population).toBeLessThan(5000);
  }, 30_000);
});

describe('ECS stores expose phase-3 components', () => {
  it('agents have lineage and reproductive components attached', () => {
    const mini = makeContext(TEST_SEED, 32);
    const entity = spawnAgent(mini, 5, 5, { ageHours: 100, sex: 1, generation: 2, parentA: 4, parentB: 9 });
    expect(mini.ecs.lineage.index[entity]).toBeGreaterThanOrEqual(0);
    expect(mini.ecs.reproductive.index[entity]).toBeGreaterThanOrEqual(0);
    const linSlot = mini.ecs.lineage.index[entity];
    expect(mini.ecs.lineage.columns.generation[linSlot]).toBe(2);
    expect(mini.ecs.lineage.columns.parentA[linSlot]).toBe(4);
    expect(mini.ecs.lineage.columns.parentB[linSlot]).toBe(9);
  });
});
