import { describe, expect, it } from 'vitest';
import { AgentIntent, MemoryStore, ResourceType } from '../src/simulation-core/ai';
import { updateMemory } from '../src/simulation-core/simulation/systems/memory-system';
import { makeContext, spawnAgent } from './helpers';

describe('agent memory', () => {
  it('observes new locations and updates existing ones in place', () => {
    const mini = makeContext(1, 16);
    const { ctx } = mini;
    const entity = spawnAgent(mini, 4, 4);
    const memory = ctx.ecs.memory;

    expect(memory.countFor(entity)).toBe(0);
    expect(memory.observe(entity, ResourceType.Food, 5, 5, 0.6, 1).created).toBe(true);
    expect(memory.countFor(entity)).toBe(1);
    // Re-observing the same location updates the value rather than duplicating.
    const slot = memory.find(entity, ResourceType.Food, 5, 5);
    expect(memory.observe(entity, ResourceType.Food, 5, 5, 0.9, 2).created).toBe(false);
    expect(memory.countFor(entity)).toBe(1);
    expect(memory.find(entity, ResourceType.Food, 5, 5)).toBe(slot);
    expect(memory.entryValue(slot)).toBeCloseTo(0.9, 5);
  });

  it('enforces a per-agent capacity and evicts the weakest entry', () => {
    const mini = makeContext(2, 16);
    const { ctx } = mini;
    const entity = spawnAgent(mini, 4, 4);
    const memory = ctx.ecs.memory;
    const capacity = ctx.config.memory.capacity;

    for (let i = 0; i < capacity + 5; i++) {
      memory.observe(entity, ResourceType.Food, (i % 8) + 1, Math.floor(i / 8) + 1, 0.1 + i * 0.01, i);
    }
    expect(memory.countFor(entity)).toBe(capacity);
    // The lowest-valued entry (the first, value 0.1) was evicted.
    expect(memory.find(entity, ResourceType.Food, 1, 1)).toBe(-1);
  });

  it('decays every entry each tick and prunes forgotten memories', () => {
    const mini = makeContext(3, 16);
    const { ctx } = mini;
    const entity = spawnAgent(mini, 4, 4);
    const memory = ctx.ecs.memory;
    // A just-barely-remembered location.
    memory.observe(entity, ResourceType.Water, 7, 7, 0.2, 0);

    for (let i = 0; i < 2000; i++) updateMemory(ctx);

    expect(memory.find(entity, ResourceType.Water, 7, 7)).toBe(-1);
    expect(memory.countFor(entity)).toBe(0);
  });

  it('smarter agents forget slower', () => {
    const dumbMini = makeContext(4, 16);
    const smartMini = makeContext(5, 16);
    const dumb = spawnAgent(dumbMini, 4, 4, { intelligence: 0.1 });
    const smart = spawnAgent(smartMini, 4, 4, { intelligence: 0.9 });
    dumbMini.ctx.ecs.memory.observe(dumb, ResourceType.Food, 8, 8, 0.8, 0);
    smartMini.ctx.ecs.memory.observe(smart, ResourceType.Food, 8, 8, 0.8, 0);

    for (let i = 0; i < 100; i++) {
      updateMemory(dumbMini.ctx);
      updateMemory(smartMini.ctx);
    }

    const dumbValue = dumbMini.ctx.ecs.memory.entryValue(
      dumbMini.ctx.ecs.memory.find(dumb, ResourceType.Food, 8, 8),
    );
    const smartValue = smartMini.ctx.ecs.memory.entryValue(
      smartMini.ctx.ecs.memory.find(smart, ResourceType.Food, 8, 8),
    );
    expect(smartValue).toBeGreaterThan(dumbValue);
  });

  it('serializes and restores memory losslessly', () => {
    const mini = makeContext(6, 16);
    const { ctx } = mini;
    const entity = spawnAgent(mini, 4, 4);
    const memory = ctx.ecs.memory;
    memory.observe(entity, ResourceType.Food, 3, 3, 0.5, 1);
    memory.observe(entity, ResourceType.Water, 9, 9, 0.7, 2);

    const restored = new MemoryStore(ctx.config.memory.capacity);
    restored.restore(memory.serialize());

    expect(restored.countFor(entity)).toBe(2);
    expect(restored.entryValue(restored.find(entity, ResourceType.Food, 3, 3))).toBeCloseTo(0.5, 6);
    expect(restored.entryValue(restored.find(entity, ResourceType.Water, 9, 9))).toBeCloseTo(0.7, 6);
  });
});

describe('intent sanity', () => {
  it('enumerates the six candidate actions', () => {
    expect(AgentIntent.Rest).toBe(0);
    expect(AgentIntent.Wander).toBe(1);
    expect(AgentIntent.SeekFood).toBe(2);
    expect(AgentIntent.SeekWater).toBe(3);
    expect(AgentIntent.Eat).toBe(4);
    expect(AgentIntent.Drink).toBe(5);
  });
});
