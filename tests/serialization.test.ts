import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation-core/simulation/simulation';
import { DEFAULT_SIMULATION_CONFIG } from '../src/simulation-core/simulation/config';
import {
  buildAgentDetails,
  buildSimulationSnapshot,
} from '../src/persistence/snapshots';
import {
  canonicalJson,
  deserializeSimulation,
  SAVE_FORMAT_VERSION,
  serializeSimulation,
} from '../src/persistence/serialization';
import { runDeterminismCheck } from '../src/persistence/determinism-check';

describe('save-state serialization', () => {
  it('round-trips exactly (fresh simulation)', () => {
    const sim = Simulation.create(1337, DEFAULT_SIMULATION_CONFIG);
    const save = serializeSimulation(sim);
    expect(canonicalJson(serializeSimulation(deserializeSimulation(save)))).toBe(canonicalJson(save));
  });

  it('round-trips exactly after ticks, including RNG state', () => {
    const sim = Simulation.create(4242, DEFAULT_SIMULATION_CONFIG);
    for (let i = 0; i < 137; i++) sim.step();
    const save = serializeSimulation(sim);
    expect(save.tick).toBe(137);
    expect(canonicalJson(serializeSimulation(deserializeSimulation(save)))).toBe(canonicalJson(save));
  });

  it('rejects incompatible save versions', () => {
    const sim = Simulation.create(1, DEFAULT_SIMULATION_CONFIG);
    const save = serializeSimulation(sim);
    expect(() => deserializeSimulation({ ...save, version: save.version + 1 })).toThrow(/version/);
  });

  it('embeds the format version and all required sections', () => {
    const sim = Simulation.create(7, DEFAULT_SIMULATION_CONFIG);
    const save = serializeSimulation(sim);
    expect(save.version).toBe(SAVE_FORMAT_VERSION);
    expect(save.config).toEqual(DEFAULT_SIMULATION_CONFIG);
    expect(save.world.terrain).toHaveLength(sim.world.size);
    expect(save.ecs.entities.alive).toHaveLength(sim.population);
    expect(save.rng.sim).toBeDefined();
    expect(save.rng.spawn).toBeDefined();
  });
});

describe('snapshots', () => {
  it('builds a compact per-frame snapshot', () => {
    const sim = Simulation.create(1337, DEFAULT_SIMULATION_CONFIG);
    for (let i = 0; i < 33; i++) sim.step();
    const snapshot = buildSimulationSnapshot(sim);
    expect(snapshot.formatVersion).toBe(3);
    expect(snapshot.tick).toBe(33);
    expect(snapshot.population).toBe(50);
    expect(snapshot.deaths).toBe(0);
    expect(snapshot.births).toBe(0);
    expect(snapshot.reproductionSuccesses).toBe(0);
    expect(snapshot.maxGeneration).toBe(0);
    const { agents } = snapshot;
    expect(agents.ids).toHaveLength(50);
    expect(agents.x).toHaveLength(50);
    expect(agents.intentKind).toHaveLength(50);
    for (const array of [agents.strength, agents.intelligence, agents.speed]) {
      for (let i = 0; i < array.length; i++) {
        expect(array[i]).toBeGreaterThanOrEqual(0);
        expect(array[i]).toBeLessThanOrEqual(1);
      }
    }
    // Intent kinds are valid AgentIntent values (0..6).
    for (let i = 0; i < agents.intentKind.length; i++) {
      expect(agents.intentKind[i]).toBeGreaterThanOrEqual(0);
      expect(agents.intentKind[i]).toBeLessThanOrEqual(6);
    }
    for (const value of [
      snapshot.averages.intelligence,
      snapshot.averages.strength,
      snapshot.averages.speed,
      snapshot.averages.fertility,
      snapshot.averages.socialTendency,
    ]) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    // Average age is in in-game hours (not normalized), so it must be finite & >= 0.
    expect(snapshot.averages.age).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(snapshot.averages.age)).toBe(true);
    for (const value of [
      snapshot.averages.hunger,
      snapshot.averages.thirst,
      snapshot.averages.energy,
      snapshot.averages.health,
    ]) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
    // Trait distributions cover the whole [0,1] range with the expected bins.
    for (const dist of [snapshot.distributions.intelligence, snapshot.distributions.strength,
      snapshot.distributions.speed, snapshot.distributions.fertility]) {
      expect(dist).toHaveLength(10);
      expect(dist.reduce((a, b) => a + b, 0)).toBe(50);
    }
    expect(snapshot.resources.food).toBeGreaterThanOrEqual(0);
    expect(snapshot.resources.food).toBeLessThanOrEqual(1);
    expect(snapshot.resources.water).toBeGreaterThanOrEqual(0);
    expect(snapshot.resources.water).toBeLessThanOrEqual(1);
  });

  it('extracts full details for one agent on demand', () => {
    const sim = Simulation.create(1337, DEFAULT_SIMULATION_CONFIG);
    const details = buildAgentDetails(sim, 0);
    expect(details).not.toBeNull();
    expect(details!.entityId).toBe(0);
    expect(typeof details!.intent).toBe('string');
    expect(Number.isFinite(details!.targetX)).toBe(true);
    expect(Number.isFinite(details!.targetY)).toBe(true);
    for (const value of [details!.health, details!.hunger, details!.thirst, details!.energy]) {
      expect(Number.isFinite(value)).toBe(true);
    }
    for (const value of [
      details!.intelligence,
      details!.strength,
      details!.speed,
      details!.fertility,
      details!.socialTendency,
    ]) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    // AI debug table exposes exactly the seven candidate actions.
    expect(details!.aiUtilities).toHaveLength(7);
    expect(details!.aiUtilities.map((row) => row.action)).toEqual([
      'Rest',
      'Wander',
      'SeekFood',
      'SeekWater',
      'Eat',
      'Drink',
      'SeekPartner',
    ]);
    for (const row of details!.aiUtilities) {
      expect(row.utility).toBeGreaterThanOrEqual(0);
      expect(row.utility).toBeLessThanOrEqual(1);
    }
    expect(Array.isArray(details!.memoryFood)).toBe(true);
    expect(Array.isArray(details!.memoryWater)).toBe(true);
    expect(buildAgentDetails(sim, 999_999)).toBeNull();
  });
});

describe('determinism self-check routine', () => {
  it(
    'verifies same-seed runs and save/load continuation for several seeds',
    () => {
      for (const seed of [1, 1337, 99_999]) {
        const result = runDeterminismCheck(seed, 300);
        expect(result.seed).toBe(seed);
        expect(result.ticks).toBe(300);
        expect(result.sameSeedMatch, `same-seed mismatch for seed ${seed}`).toBe(true);
        expect(result.restoreContinuationMatch, `restore mismatch for seed ${seed}`).toBe(true);
      }
    },
    60_000,
  );
});

describe('canonicalJson', () => {
  it('is independent of key insertion order', () => {
    const a = { b: 1, a: { z: [1, 2], y: 'x' } };
    const b = { a: { y: 'x', z: [1, 2] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });
});
