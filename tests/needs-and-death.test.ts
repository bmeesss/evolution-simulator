import { describe, expect, it } from 'vitest';
import { AgentIntent } from '../src/simulation-core/ai';
import { updateNeeds } from '../src/simulation-core/simulation/systems/needs-system';
import { updateDeaths } from '../src/simulation-core/simulation/systems/death-system';
import { makeContext, spawnAgent } from './helpers';

describe('needs dynamics', () => {
  it('increases hunger and thirst and drains energy when active', () => {
    const mini = makeContext(1, 16);
    const { ctx, config } = mini;
    const entity = spawnAgent(mini, 4, 4, { hunger: 0, thirst: 0, energy: 100 });
    const needs = ctx.ecs.needs;
    const slot = needs.index[entity];

    updateNeeds(ctx);

    expect(needs.columns.hunger[slot]).toBeCloseTo(config.needs.hungerPerHour * ctx.dtHours, 6);
    expect(needs.columns.thirst[slot]).toBeCloseTo(config.needs.thirstPerHour * ctx.dtHours, 6);
    expect(needs.columns.energy[slot]).toBeLessThan(100);
  });

  it('regenerates energy while resting (no active drain)', () => {
    const mini = makeContext(2, 16);
    const { ctx } = mini;
    const entity = spawnAgent(mini, 4, 4, { energy: 50 });
    ctx.ecs.intent.columns.kind[ctx.ecs.intent.index[entity]] = AgentIntent.Rest;
    const needs = ctx.ecs.needs;
    const slot = needs.index[entity];
    const before = needs.columns.energy[slot];

    updateNeeds(ctx);

    expect(needs.columns.energy[slot]).toBeGreaterThan(before);
  });

  it('clamps all needs to the 0..100 scale', () => {
    const mini = makeContext(3, 16);
    const { ctx } = mini;
    const entity = spawnAgent(mini, 4, 4, { hunger: 99.99, thirst: 99.99, energy: 0.01 });
    const needs = ctx.ecs.needs;
    const slot = needs.index[entity];

    for (let i = 0; i < 10; i++) updateNeeds(ctx);

    expect(needs.columns.hunger[slot]).toBe(100);
    expect(needs.columns.thirst[slot]).toBe(100);
    expect(needs.columns.energy[slot]).toBe(0);
  });

  it('critical hunger and thirst damage health', () => {
    const mini = makeContext(4, 16);
    const { ctx, config } = mini;
    const entity = spawnAgent(mini, 4, 4, { hunger: 95, thirst: 95, health: 100 });
    const health = ctx.ecs.health;
    const slot = health.index[entity];

    updateNeeds(ctx);

    expect(health.columns.current[slot]).toBeLessThan(100);
    expect(health.columns.current[slot]).toBeCloseTo(
      100 - config.needs.healthDrainPerHourCritical * ctx.dtHours,
      6,
    );
  });

  it('does not damage health when needs are met', () => {
    const mini = makeContext(5, 16);
    const { ctx } = mini;
    const entity = spawnAgent(mini, 4, 4, { hunger: 10, thirst: 10, health: 100 });
    const health = ctx.ecs.health;
    const slot = health.index[entity];

    for (let i = 0; i < 10; i++) updateNeeds(ctx);

    expect(health.columns.current[slot]).toBe(100);
  });
});

describe('death system', () => {
  it('kills agents at zero health, detaches components and records the event', () => {
    const mini = makeContext(6, 16);
    const { ctx, events } = mini;
    const survivor = spawnAgent(mini, 2, 2, { health: 100 });
    const doomed = spawnAgent(mini, 10, 10, { health: 0 });
    const before = ctx.ecs.entities.aliveCount;

    const killed = updateDeaths(ctx);

    expect(killed).toBe(1);
    expect(ctx.ecs.entities.aliveCount).toBe(before - 1);
    expect(ctx.ecs.entities.isAlive(doomed)).toBe(false);
    expect(ctx.ecs.entities.isAlive(survivor)).toBe(true);
    expect(ctx.ecs.health.index[doomed]).toBe(-1);
    expect(events.recent(50).some((e) => e.type === 'agent_died')).toBe(true);
  });
});
