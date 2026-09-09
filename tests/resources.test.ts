import { describe, expect, it } from 'vitest';
import { AgentIntent, ResourceType } from '../src/simulation-core/ai';
import { interactWithResources } from '../src/simulation-core/simulation/systems/resource-system';
import { regenerateResources } from '../src/simulation-core/simulation/systems/regeneration-system';
import { makeContext, spawnAgent } from './helpers';

describe('resource spatial index', () => {
  it('finds food and water tiles within perception', () => {
    const mini = makeContext(1, 32);
    const { ctx, world, config } = mini;
    const index = ctx.resourceIndex;
    // Plant a known food tile and a known water tile.
    const foodIdx = world.tileIndex(10, 10);
    const waterIdx = world.tileIndex(20, 20);
    world.food[foodIdx] = 0.9;
    world.water[waterIdx] = 0.9;
    index.rebuild(world, config.resources.minFoodToEat, config.resources.minWaterToDrink);

    let foundFood = false;
    let foundWater = false;
    for (let c = 0; c < index.cols && !foundFood; c++) {
      for (let r = 0; r < index.rows && !foundFood; r++) {
        for (let idx = index.foodHead[index.cellIndex(c, r)]; idx !== -1; idx = index.foodNext[idx]) {
          if (idx === foodIdx) foundFood = true;
        }
      }
    }
    for (let c = 0; c < index.cols && !foundWater; c++) {
      for (let r = 0; r < index.rows && !foundWater; r++) {
        for (let idx = index.waterHead[index.cellIndex(c, r)]; idx !== -1; idx = index.waterNext[idx]) {
          if (idx === waterIdx) foundWater = true;
        }
      }
    }
    expect(foundFood).toBe(true);
    expect(foundWater).toBe(true);
  });

  it('reuses its buffers across rebuilds (no growth per tick)', () => {
    const mini = makeContext(2, 32);
    const { ctx, world, config } = mini;
    const index = ctx.resourceIndex;
    const before = index.foodHead.length;
    index.rebuild(world, config.resources.minFoodToEat, config.resources.minWaterToDrink);
    index.rebuild(world, config.resources.minFoodToEat, config.resources.minWaterToDrink);
    expect(index.foodHead.length).toBe(before);
  });
});

describe('food & water consumption', () => {
  it('eating consumes food, relieves hunger and never goes negative', () => {
    const mini = makeContext(3, 24);
    const { ctx, world, config, events } = mini;
    const x = 12;
    const y = 12;
    const idx = world.tileIndex(x, y);
    world.food[idx] = 0.3;
    const entity = spawnAgent(mini, x, y, { hunger: 90, intent: AgentIntent.Eat });

    interactWithResources(ctx);

    expect(world.food[idx]).toBeGreaterThanOrEqual(0);
    expect(world.food[idx]).toBeCloseTo(0.3 - config.resources.eatAmount, 6);
    expect(ctx.ecs.needs.columns.hunger[ctx.ecs.needs.index[entity]]).toBeLessThan(90);
    expect(ctx.ecs.memory.find(entity, ResourceType.Food, x, y)).toBeGreaterThanOrEqual(0);
    expect(events.recent(50).some((e) => e.type === 'agent_ate')).toBe(true);
  });

  it('drinking consumes water, relieves thirst and never goes negative', () => {
    const mini = makeContext(4, 24);
    const { ctx, world, config, events } = mini;
    const x = 6;
    const y = 6;
    const idx = world.tileIndex(x, y);
    world.water[idx] = 0.25;
    const entity = spawnAgent(mini, x, y, { thirst: 88, intent: AgentIntent.Drink });

    interactWithResources(ctx);

    expect(world.water[idx]).toBeGreaterThanOrEqual(0);
    expect(world.water[idx]).toBeCloseTo(0.25 - config.resources.drinkAmount, 6);
    expect(ctx.ecs.needs.columns.thirst[ctx.ecs.needs.index[entity]]).toBeLessThan(88);
    expect(ctx.ecs.memory.find(entity, ResourceType.Water, x, y)).toBeGreaterThanOrEqual(0);
    expect(events.recent(50).some((e) => e.type === 'agent_drank')).toBe(true);
  });

  it('emits resource_depleted when a tile is emptied', () => {
    const mini = makeContext(5, 24);
    const { ctx, world, config, events } = mini;
    const x = 10;
    const y = 10;
    const idx = world.tileIndex(x, y);
    world.food[idx] = config.resources.eatAmount * 0.9; // one bite empties it
    spawnAgent(mini, x, y, { hunger: 90, intent: AgentIntent.Eat });

    interactWithResources(ctx);

    expect(world.food[idx]).toBe(0);
    expect(events.recent(50).some((e) => e.type === 'resource_depleted')).toBe(true);
  });

  it('a depleted tile cannot go below zero and punishes memory', () => {
    const mini = makeContext(6, 24);
    const { ctx, world } = mini;
    const x = 8;
    const y = 8;
    const idx = world.tileIndex(x, y);
    world.food[idx] = 0;
    const entity = spawnAgent(mini, x, y, { hunger: 90, intent: AgentIntent.Eat });
    // Seed a strong memory of this now-empty location.
    ctx.ecs.memory.observe(entity, ResourceType.Food, x, y, 0.9, 0);

    interactWithResources(ctx);

    expect(world.food[idx]).toBe(0); // never negative
    const entry = ctx.ecs.memory.find(entity, ResourceType.Food, x, y);
    expect(ctx.ecs.memory.entryValue(entry)).toBeLessThan(0.9);
  });
});

describe('resource regeneration', () => {
  it('regenerates food and water toward their caps without exceeding them', () => {
    const mini = makeContext(7, 24);
    const { ctx, world } = mini;
    const foodIdx = world.tileIndex(4, 4);
    const waterIdx = world.tileIndex(18, 18);
    world.food[foodIdx] = 0;
    world.water[waterIdx] = 0;
    world.foodCap[foodIdx] = 0.6; // fixed targets so the test is terrain-independent
    world.waterCap[waterIdx] = 0.6;
    const foodCap = world.foodCap[foodIdx];
    const waterCap = world.waterCap[waterIdx];

    for (let i = 0; i < 1000; i++) regenerateResources(ctx);

    expect(world.food[foodIdx]).toBeGreaterThan(0);
    expect(world.food[foodIdx]).toBeLessThanOrEqual(foodCap);
    expect(world.water[waterIdx]).toBeGreaterThan(0);
    expect(world.water[waterIdx]).toBeLessThanOrEqual(waterCap);
  });

  it('grows monotonically toward the cap and saturates exactly there', () => {
    const mini = makeContext(8, 24);
    const { ctx, world } = mini;
    const idx = world.tileIndex(14, 14);
    world.food[idx] = 0;
    world.foodCap[idx] = 0.5;
    const cap = world.foodCap[idx];
    let previous = 0;
    for (let i = 0; i < 10000; i++) {
      regenerateResources(ctx);
      expect(world.food[idx]).toBeGreaterThanOrEqual(previous);
      expect(world.food[idx]).toBeLessThanOrEqual(cap);
      previous = world.food[idx];
    }
    expect(world.food[idx]).toBeCloseTo(cap, 3);
  });
});
