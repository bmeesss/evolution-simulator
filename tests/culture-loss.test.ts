/**
 * Phase 5 — cultural loss tests.
 *
 * Culture is not permanent: items decay when unused, they are forgotten when
 * they fade, they disappear with their holder, and bounded memory evicts the
 * weakest item when an agent learns too much. These tests also check that loss
 * leaves no dangling references behind (a removed holder must not linger in the
 * carrier bookkeeping).
 */

import { describe, expect, it } from 'vitest';
import { AgentIntent } from '../src/simulation-core/ai';
import { KnowledgeOrigin, KnowledgeType, SignalMeaning } from '../src/simulation-core/culture';
import { interactWithResources } from '../src/simulation-core/simulation/systems/resource-system';
import { updateCulture } from '../src/simulation-core/simulation/systems/culture-system';
import { updateDeaths } from '../src/simulation-core/simulation/systems/death-system';
import { cloneConfig, DEFAULT_SIMULATION_CONFIG } from '../src/simulation-core/simulation/config';
import { makeContext, spawnAgent, type MiniContext } from './helpers';

function learn(mini: MiniContext, entity: number, type: number, tileX: number, tileY: number, variantId: number, strength: number, origin: number = KnowledgeOrigin.Discovered): void {
  mini.ecs.culturalMemory.learn(
    entity,
    { type, tileX, tileY, variantId, strength, origin, sourceEntity: -1 },
    0,
  );
}

describe('cultural loss', () => {
  it('decays unused knowledge and forgets it, recording the loss', () => {
    const mini = makeContext(51, 24);
    const config = cloneConfig(DEFAULT_SIMULATION_CONFIG);
    // Fast decay so the test can watch an item fade inside a few hundred ticks.
    config.culture.memory.baseDecayPerHour = 2;
    config.culture.memory.forgetThreshold = 0.34;
    const ctx = { ...mini.ctx, config, ecs: mini.ecs };
    const holder = spawnAgent(mini, 4, 4, { intelligence: 0 });
    learn(mini, holder, KnowledgeType.FoodLocation, 9, 9, 0, 0.9);
    expect(mini.ecs.culturalMemory.countFor(holder)).toBe(1);

    for (let tick = 0; tick < 20 && mini.ecs.culturalMemory.countFor(holder) > 0; tick++) {
      updateCulture({ ...ctx, tick });
    }

    expect(mini.ecs.culturalMemory.countFor(holder)).toBe(0);
    expect(ctx.cultureStats.lost).toBe(1);
    expect(ctx.events.recent(50).filter((e) => e.type === 'knowledge_lost')).toHaveLength(1);
    // Re-learning after a loss works (no tombstone, no dead reference).
    learn(mini, holder, KnowledgeType.FoodLocation, 9, 9, 0, 0.9);
    expect(mini.ecs.culturalMemory.countFor(holder)).toBe(1);
  });

  it('keeps knowledge alive while it keeps being useful', () => {
    const mini = makeContext(52, 24);
    const config = cloneConfig(DEFAULT_SIMULATION_CONFIG);
    // Slower decay than the forget test: reinforcement must be able to win.
    config.culture.memory.baseDecayPerHour = 0.2;
    const ctx = { ...mini.ctx, config, ecs: mini.ecs };
    const holder = spawnAgent(mini, 6, 6, { intelligence: 0 });
    // A food item exactly under the agent's feet: it is "used" every tick the
    // agent tries to eat, which reinforces instead of decaying.
    mini.world.food[mini.world.tileIndex(6, 6)] = 1;
    learn(mini, holder, KnowledgeType.FoodLocation, 6, 6, 0, 0.5);
    const slot = mini.ecs.intent.index[holder];
    mini.ecs.intent.columns.kind[slot] = AgentIntent.Eat;

    // The resource system actually performs the meal (and stamps lastForageTick),
    // the culture system then credits the knowledge that made it happen. The
    // patch is topped up each tick so the item never meets emptiness — the only
    // reason it is forgotten would be disuse.
    for (let tick = 0; tick < 40; tick++) {
      mini.world.food[mini.world.tileIndex(6, 6)] = 1;
      const tickCtx = { ...ctx, tick };
      interactWithResources(tickCtx);
      updateCulture(tickCtx);
    }

    expect(mini.ecs.culturalMemory.countFor(holder)).toBeGreaterThanOrEqual(1);
    expect(mini.ecs.culturalMemory.find(holder, KnowledgeType.FoodLocation, 6, 6, 0)).toBeGreaterThanOrEqual(0);
    expect(mini.ecs.culturalMemory.strengthOf(holder, KnowledgeType.FoodLocation, 6, 6, 0)).toBeGreaterThan(0.5);
    expect(ctx.cultureStats.lost).toBe(0);
  });

  it('loses all of a dead agent’s knowledge and signal associations', () => {
    const mini = makeContext(53, 24);
    const { ctx, events } = mini;
    const doomed = spawnAgent(mini, 4, 4, { health: 0 });
    const survivor = spawnAgent(mini, 8, 8, { health: 100 });
    learn(mini, doomed, KnowledgeType.FoodLocation, 5, 5, 0, 0.8);
    learn(mini, doomed, KnowledgeType.ForagingTechnique, -1, -1, 1, 0.8);
    mini.ecs.signals.observe(doomed, 3, SignalMeaning.Food, 0.7, 0);
    learn(mini, survivor, KnowledgeType.WaterLocation, 2, 2, 0, 0.8);

    expect(mini.ecs.culturalMemory.carrierIds()).toHaveLength(2);
    expect(mini.ecs.signals.holderIds()).toHaveLength(1);

    const killed = updateDeaths(ctx);

    expect(killed).toBe(1);
    expect(mini.ecs.culturalMemory.countFor(doomed)).toBe(0);
    expect(mini.ecs.signals.countFor(doomed)).toBe(0);
    expect(mini.ecs.culture.index[doomed]).toBe(-1);
    // The dead agent is gone from the carrier bookkeeping, and the survivor's
    // knowledge is untouched.
    expect(mini.ecs.culturalMemory.carrierIds()).toEqual([survivor]);
    expect(mini.ecs.signals.holderIds()).toEqual([]);
    expect(mini.ecs.culturalMemory.countFor(survivor)).toBe(1);
    expect(events.recent(50).some((e) => e.type === 'agent_died')).toBe(true);
  });

  it('evicts the weakest item when an agent exceeds its cultural memory capacity', () => {
    const mini = makeContext(54, 24);
    const config = cloneConfig(DEFAULT_SIMULATION_CONFIG);
    const ctx = { ...mini.ctx, config, ecs: mini.ecs };
    const holder = spawnAgent(mini, 4, 4, { intelligence: 0 });
    const capacity = config.culture.memory.capacity;

    // Fill memory with increasingly strong items; the weakest must fall out.
    for (let i = 0; i < capacity; i++) {
      learn(mini, holder, KnowledgeType.FoodLocation, i % 6, Math.floor(i / 6), 0, 0.2 + i * 0.05);
    }
    expect(mini.ecs.culturalMemory.countFor(holder)).toBe(capacity);
    learn(mini, holder, KnowledgeType.FoodLocation, 20, 20, 0, 0.9);

    expect(mini.ecs.culturalMemory.countFor(holder)).toBe(capacity);
    expect(mini.ecs.culturalMemory.find(holder, KnowledgeType.FoodLocation, 0, 0, 0)).toBe(-1);
    expect(mini.ecs.culturalMemory.find(holder, KnowledgeType.FoodLocation, 20, 20, 0)).toBeGreaterThanOrEqual(0);
    // Maintenance still runs cleanly over an evicted chain.
    for (let tick = 0; tick < 10; tick++) updateCulture({ ...ctx, tick });
    expect(mini.ecs.culturalMemory.countFor(holder)).toBeLessThanOrEqual(capacity);
  });

  it('forgets knowledge whose holder never uses it and never teaches it', () => {
    const mini = makeContext(55, 24);
    const config = cloneConfig(DEFAULT_SIMULATION_CONFIG);
    config.culture.memory.baseDecayPerHour = 2;
    config.culture.memory.forgetThreshold = 0.34;
    const ctx = { ...mini.ctx, config, ecs: mini.ecs };
    const holder = spawnAgent(mini, 12, 12, { intelligence: 0 });
    learn(mini, holder, KnowledgeType.ForagingTechnique, -1, -1, 2, 0.9, KnowledgeOrigin.Taught);

    for (let tick = 0; tick < 20; tick++) updateCulture({ ...ctx, tick });

    expect(mini.ecs.culturalMemory.countFor(holder)).toBe(0);
    expect(ctx.cultureStats.lost).toBe(1);
  });
});
