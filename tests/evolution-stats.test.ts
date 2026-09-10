import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation-core/simulation/simulation';
import { cloneConfig, DEFAULT_SIMULATION_CONFIG } from '../src/simulation-core/simulation/config';
import {
  buildSimulationSnapshot,
  buildAgentDetails,
  TRAIT_DISTRIBUTION_BINS,
} from '../src/persistence/snapshots';

const TEST_SEED = 1337;

describe('evolution statistics (snapshot)', () => {
  it('reports births, deaths and max generation from live state', () => {
    const config = cloneConfig(DEFAULT_SIMULATION_CONFIG);
    config.reproduction.cooldownHours = 144;
    const sim = Simulation.create(TEST_SEED, config);
    for (let i = 0; i < 1500; i++) sim.step();
    const snap = buildSimulationSnapshot(sim);
    expect(snap.formatVersion).toBe(4);
    expect(snap.births).toBe(sim.birthCount);
    expect(snap.reproductionSuccesses).toBe(sim.birthCount);
    expect(snap.deaths).toBe(sim.deathCount);

    // maxGeneration must equal the highest generation among alive agents.
    let expectedMax = 0;
    for (let i = 0; i < sim.ecs.lineage.count; i++) {
      expectedMax = Math.max(expectedMax, sim.ecs.lineage.columns.generation[i]);
    }
    expect(snap.maxGeneration).toBe(expectedMax);
  }, 30_000);

  it('trait distributions cover the full [0,1] range and sum to the population', () => {
    const sim = Simulation.create(TEST_SEED, DEFAULT_SIMULATION_CONFIG);
    const snap = buildSimulationSnapshot(sim);
    const pop = snap.population;
    for (const dist of [snap.distributions.intelligence, snap.distributions.strength,
      snap.distributions.speed, snap.distributions.fertility]) {
      expect(dist).toHaveLength(TRAIT_DISTRIBUTION_BINS);
      expect(dist.reduce((a, b) => a + b, 0)).toBe(pop);
      for (const bin of dist) expect(bin).toBeGreaterThanOrEqual(0);
    }
  });

  it('every bin index maps into [0, TRAIT_DISTRIBUTION_BINS)', () => {
    const sim = Simulation.create(TEST_SEED, DEFAULT_SIMULATION_CONFIG);
    const snap = buildSimulationSnapshot(sim);
    // 1.0 clamps into the top bin; 0 into the first. All values sum to population.
    const total = snap.distributions.intelligence.reduce((a, b) => a + b, 0);
    expect(total).toBe(snap.population);
  });

  it('agent snapshot exposes the speed trait for rendering', () => {
    const sim = Simulation.create(TEST_SEED, DEFAULT_SIMULATION_CONFIG);
    const snap = buildSimulationSnapshot(sim);
    expect(snap.agents.speed).toHaveLength(snap.agents.ids.length);
    for (let i = 0; i < snap.agents.speed.length; i++) {
      expect(snap.agents.speed[i]).toBeGreaterThanOrEqual(0);
      expect(snap.agents.speed[i]).toBeLessThanOrEqual(1);
    }
  });

  it('selected-agent details expose phase-3 fields (sex, life stage, lineage, reproduction)', () => {
    const sim = Simulation.create(TEST_SEED, DEFAULT_SIMULATION_CONFIG);
    const details = buildAgentDetails(sim, 0);
    expect(details).not.toBeNull();
    expect(details!.lifeStage).toBeDefined();
    expect(details!.generation).toBe(0);
    expect(details!.parentA).toBe(-1);
    expect(details!.parentB).toBe(-1);
    expect(details!.sex === 0 || details!.sex === 1).toBe(true);
    expect(typeof details!.reproductionEligible).toBe('boolean');
    expect(details!.reproductionCooldownHours).toBeGreaterThanOrEqual(0);
    // Genome origins exist for a founder (all 'founding').
    expect(details!.genomeOrigins.length).toBeGreaterThan(0);
    for (const origin of details!.genomeOrigins) {
      expect(origin.source).toBe('founding');
    }
  });
});

describe('partner search performance regression', () => {
  it('scales roughly linearly in population, not quadratically', () => {
    // Measure per-tick cost at two population sizes by directly building a
    // simulation and timing a fixed tick budget. A quadratic partner scan would
    // make cost grow ~4x when population doubles; we assert it stays near-linear.
    function timePerTick(pop: number): number {
      const config = cloneConfig(DEFAULT_SIMULATION_CONFIG);
      config.agents.initialPopulation = pop;
      // Disable reproduction so population stays ~flat during the measurement.
      config.reproduction.baseDrive = 0;
      config.reproduction.fertilityDriveBoost = 0;
      config.reproduction.socialDriveBoost = 0;
      const sim = Simulation.create(99, config);
      const budget = 200;
      const t0 = performance.now();
      for (let i = 0; i < budget; i++) sim.step();
      return (performance.now() - t0) / budget;
    }

    const t100 = timePerTick(100);
    const t400 = timePerTick(400);
    // If cost were quadratic, t400/t100 would approach ~16. We allow generous
    // slack for allocation noise and only require it is far from quadratic.
    const ratio = t400 / t100;
    expect(ratio).toBeLessThan(8);
    // Sanity: both measurements are positive.
    expect(t100).toBeGreaterThan(0);
    expect(t400).toBeGreaterThan(0);
  }, 30_000);
});
