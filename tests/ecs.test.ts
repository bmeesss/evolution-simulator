import { describe, expect, it } from 'vitest';
import { ComponentStore } from '../src/simulation-core/ecs/component-store';
import { EntityRegistry } from '../src/simulation-core/ecs/entity';
import { SimulationEcs } from '../src/simulation-core/ecs/simulation-ecs';
import { Simulation } from '../src/simulation-core/simulation/simulation';
import { DEFAULT_SIMULATION_CONFIG } from '../src/simulation-core/simulation/config';

const PositionSchema = { x: Float64Array, y: Float64Array };

describe('EntityRegistry', () => {
  it('allocates monotonically increasing ids in stable order', () => {
    const registry = new EntityRegistry(4);
    const ids = [registry.create(), registry.create(), registry.create()];
    expect(ids).toEqual([0, 1, 2]);
    expect(registry.aliveCount).toBe(3);
    expect(Array.from(registry.aliveIds.subarray(0, registry.aliveCount))).toEqual([0, 1, 2]);
    for (const id of ids) expect(registry.isAlive(id)).toBe(true);
    expect(registry.isAlive(999)).toBe(false);
  });

  it('destroys entities with swap-remove and never reuses ids', () => {
    const registry = new EntityRegistry(4);
    const a = registry.create();
    const b = registry.create();
    const c = registry.create();
    registry.destroy(b);
    expect(registry.isAlive(b)).toBe(false);
    expect(registry.aliveCount).toBe(2);
    expect(Array.from(registry.aliveIds.subarray(0, registry.aliveCount)).sort()).toEqual([a, c]);
    const d = registry.create();
    expect(d).toBe(3); // id 1 is never reused
    expect(() => registry.destroy(b)).toThrow();
  });

  it('grows beyond its initial capacity', () => {
    const registry = new EntityRegistry(2);
    for (let i = 0; i < 100; i++) registry.create();
    expect(registry.aliveCount).toBe(100);
    expect(registry.isAlive(99)).toBe(true);
  });

  it('serializes and restores exactly', () => {
    const registry = new EntityRegistry(4);
    for (let i = 0; i < 10; i++) registry.create();
    registry.destroy(3);
    registry.destroy(7);
    const saved = registry.serialize();

    const restored = new EntityRegistry(2);
    restored.restore(saved);
    expect(restored.serialize()).toEqual(saved);
    expect(restored.isAlive(3)).toBe(false);
    expect(restored.create()).toBe(10);
  });
});

describe('ComponentStore', () => {
  it('attaches, reads and detaches values', () => {
    const store = new ComponentStore('position', PositionSchema, 8);
    const slot = store.attach(0, { x: 1.5, y: -2 });
    expect(slot).toBe(0);
    expect(store.has(0)).toBe(true);
    expect(store.columns.x[0]).toBe(1.5);
    expect(store.columns.y[0]).toBe(-2);
    store.detach(0);
    expect(store.has(0)).toBe(false);
    expect(store.count).toBe(0);
  });

  it('defaults unspecified columns to zero', () => {
    const store = new ComponentStore('position', PositionSchema, 8);
    store.attach(0, { x: 3 });
    expect(store.columns.y[0]).toBe(0);
  });

  it('rejects duplicate attach and detach of missing entities', () => {
    const store = new ComponentStore('position', PositionSchema, 8);
    store.attach(0);
    expect(() => store.attach(0)).toThrow();
    expect(() => store.detach(5)).toThrow();
  });

  it('swap-removes on detach and keeps the index map consistent', () => {
    const store = new ComponentStore('position', PositionSchema, 8);
    store.attach(0, { x: 10, y: 10 });
    store.attach(1, { x: 11, y: 11 });
    store.attach(2, { x: 12, y: 12 });
    store.detach(1); // middle removal: entity 2 must move into slot 1
    expect(store.count).toBe(2);
    expect(store.entityOf[0]).toBe(0);
    expect(store.entityOf[1]).toBe(2);
    expect(store.columns.x[1]).toBe(12);
    expect(store.index[2]).toBe(1);
    expect(store.index[1]).toBe(-1);
  });

  it('grows capacity transparently', () => {
    const store = new ComponentStore('position', PositionSchema, 4);
    for (let entity = 0; entity < 200; entity++) {
      store.attach(entity, { x: entity, y: -entity });
    }
    expect(store.count).toBe(200);
    for (let entity = 0; entity < 200; entity++) {
      expect(store.columns.x[store.index[entity]]).toBe(entity);
      expect(store.columns.y[store.index[entity]]).toBe(-entity);
    }
  });

  it('serializes and restores exactly', () => {
    const store = new ComponentStore('position', PositionSchema, 4);
    for (let entity = 0; entity < 30; entity++) store.attach(entity, { x: entity * 0.5, y: entity });
    store.detach(4);
    const saved = store.serialize();

    const restored = new ComponentStore('position', PositionSchema, 2);
    restored.restore(saved);
    expect(restored.serialize()).toEqual(saved);
    expect(restored.has(4)).toBe(false);
    expect(restored.count).toBe(29);
    expect(restored.attach(4)).toBe(29); // dense append after restore
    expect(restored.count).toBe(30);
  });

  it('restore rejects missing columns and duplicates', () => {
    const store = new ComponentStore('position', PositionSchema, 4);
    expect(() => store.restore({ count: 0, entityOf: [], columns: {} })).toThrow();
    expect(() =>
      store.restore({ count: 2, entityOf: [1, 1], columns: { x: [0, 0], y: [0, 0] } }),
    ).toThrow();
  });
});

describe('SimulationEcs', () => {
  it('round-trips a full ecs state (from a real simulation)', () => {
    const sim = Simulation.create(1337, DEFAULT_SIMULATION_CONFIG);
    for (let i = 0; i < 50; i++) sim.step();
    const saved = sim.ecs.serialize();

    const restored = new SimulationEcs();
    restored.restore(saved);
    expect(restored.serialize()).toEqual(saved);
  });
});
