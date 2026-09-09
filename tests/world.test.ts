import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/simulation-core/world/world-generator';
import { World } from '../src/simulation-core/world/world';
import { TerrainType, TERRAIN_TYPES } from '../src/simulation-core/world/terrain';
import { DEFAULT_SIMULATION_CONFIG } from '../src/simulation-core/simulation/config';

describe('world generation', () => {
  it('is fully deterministic from the seed', () => {
    const a = createWorld(1337, DEFAULT_SIMULATION_CONFIG.world);
    const b = createWorld(1337, DEFAULT_SIMULATION_CONFIG.world);
    expect(a.serialize()).toEqual(b.serialize());
  });

  it('produces different worlds for different seeds', () => {
    const a = createWorld(1337, DEFAULT_SIMULATION_CONFIG.world);
    const b = createWorld(1338, DEFAULT_SIMULATION_CONFIG.world);
    let differences = 0;
    for (let i = 0; i < a.size; i++) {
      if (a.terrain[i] !== b.terrain[i]) differences++;
    }
    expect(differences).toBeGreaterThan(100);
  });

  it('respects dimensions and value ranges', () => {
    const world = createWorld(1337, DEFAULT_SIMULATION_CONFIG.world);
    expect(world.width).toBe(DEFAULT_SIMULATION_CONFIG.world.width);
    expect(world.height).toBe(DEFAULT_SIMULATION_CONFIG.world.height);
    expect(world.size).toBe(world.width * world.height);
    for (let i = 0; i < world.size; i++) {
      expect(world.food[i]).toBeGreaterThanOrEqual(0);
      expect(world.food[i]).toBeLessThanOrEqual(1);
      expect(world.water[i]).toBeGreaterThanOrEqual(0);
      expect(world.water[i]).toBeLessThanOrEqual(1);
      expect(Number.isFinite(world.temperature[i])).toBe(true);
    }
  });

  it('creates varied terrain with water and land (fixed seed)', () => {
    const world = createWorld(1337, DEFAULT_SIMULATION_CONFIG.world);
    const counts = new Map<number, number>();
    for (let i = 0; i < world.size; i++) {
      counts.set(world.terrain[i], (counts.get(world.terrain[i]) ?? 0) + 1);
    }
    // With deterministic noise and seed 1337 the 64x64 world must contain
    // several terrain types, including water and at least two land types.
    expect(counts.get(TerrainType.Water)).toBeGreaterThan(50);
    expect((counts.get(TerrainType.Grass) ?? 0) + (counts.get(TerrainType.Forest) ?? 0)).toBeGreaterThan(50);
    expect(counts.size).toBeGreaterThanOrEqual(3);
  });

  it('water tiles carry full water and no food', () => {
    const world = createWorld(1337, DEFAULT_SIMULATION_CONFIG.world);
    for (let i = 0; i < world.size; i++) {
      if (world.terrain[i] === TerrainType.Water) {
        expect(world.water[i]).toBe(1);
        expect(world.food[i]).toBe(0);
      }
    }
  });

  it('covers every terrain type across a few seeds', () => {
    const seen = new Set<number>();
    for (const seed of [1, 42, 1337, 90210]) {
      const world = createWorld(seed, DEFAULT_SIMULATION_CONFIG.world);
      for (let i = 0; i < world.size; i++) seen.add(world.terrain[i]);
    }
    expect([...seen].sort()).toEqual([...TERRAIN_TYPES].sort());
  });
});

describe('World (container)', () => {
  it('validates array lengths against dimensions', () => {
    const full = () =>
      new World({
        width: 4,
        height: 4,
        terrain: new Uint8Array(16),
        food: new Float32Array(16),
        water: new Float32Array(16),
        temperature: new Float32Array(16),
        foodCap: new Float32Array(16),
        waterCap: new Float32Array(16),
      });
    // A terrain array one short must throw; a complete set must not.
    expect(
      () =>
        new World({
          width: 4,
          height: 4,
          terrain: new Uint8Array(3),
          food: new Float32Array(16),
          water: new Float32Array(16),
          temperature: new Float32Array(16),
          foodCap: new Float32Array(16),
          waterCap: new Float32Array(16),
        }),
    ).toThrow();
    expect(() => full()).not.toThrow();
  });

  it('serializes and restores exactly', () => {
    const world = createWorld(77, { width: 24, height: 16 });
    const restored = World.fromArrays(world.serialize());
    expect(restored.serialize()).toEqual(world.serialize());
    expect(restored.tileIndex(3, 2)).toBe(2 * 24 + 3);
  });
});
