/**
 * Phase 5 — cultural memory store tests.
 *
 * The store is the foundation of the whole culture layer, so these tests pin
 * the properties everything else depends on:
 *   - items are added, refreshed in place and reinforced (never duplicated),
 *   - strength decays and items are forgotten (nothing is permanent),
 *   - per-agent capacity is a hard bound enforced by weakest-eviction,
 *   - lookups are exact (type + tile + variant) and bounded,
 *   - the store round-trips through serialization with identical state,
 *   - death/removal leaves no dead references behind.
 */

import { describe, expect, it } from 'vitest';
import { KnowledgeOrigin, KnowledgeType, NormId } from '../src/simulation-core/culture';
import { makeContext, spawnAgent } from './helpers';

describe('cultural memory store', () => {
  it('adds items, refreshes equal items in place and reinforces strength', () => {
    const mini = makeContext(1, 16);
    const entity = spawnAgent(mini, 4, 4);
    const store = mini.ecs.culturalMemory;

    const first = store.learn(
      entity,
      {
        type: KnowledgeType.FoodLocation,
        tileX: 7,
        tileY: 8,
        variantId: 0,
        strength: 0.4,
        origin: KnowledgeOrigin.Discovered,
        sourceEntity: -1,
      },
      10,
    );
    expect(first.created).toBe(true);
    expect(store.countFor(entity)).toBe(1);
    expect(store.find(entity, KnowledgeType.FoodLocation, 7, 8, 0)).toBe(first.entry);
    expect(store.strengthOf(entity, KnowledgeType.FoodLocation, 7, 8, 0)).toBeCloseTo(0.4, 5);

    // Re-learning the same item does not add a slot: it strengthens what is
    // there (repeated exposure is how knowledge becomes confident).
    const again = store.learn(
      entity,
      {
        type: KnowledgeType.FoodLocation,
        tileX: 7,
        tileY: 8,
        variantId: 0,
        strength: 0.8,
        origin: KnowledgeOrigin.Taught,
        sourceEntity: 3,
      },
      11,
    );
    expect(again.created).toBe(false);
    expect(store.countFor(entity)).toBe(1);
    expect(store.entryStrength(again.entry)).toBeCloseTo(0.8, 5);

    // Re-learning already counted as one reinforcement (that is what "repeated
    // exposure strengthens knowledge" means); an explicit reinforce adds another.
    expect(store.entryReinforceCount(again.entry)).toBe(1);
    store.reinforce(again.entry, 0.5, 12);
    expect(store.entryStrength(again.entry)).toBeCloseTo(0.9, 5);
    expect(store.entryReinforceCount(again.entry)).toBe(2);

    // A different tile IS a different item ("food here" vs "food there").
    store.learn(
      entity,
      {
        type: KnowledgeType.FoodLocation,
        tileX: 9,
        tileY: 8,
        variantId: 0,
        strength: 0.3,
        origin: KnowledgeOrigin.Discovered,
        sourceEntity: -1,
      },
      13,
    );
    expect(store.countFor(entity)).toBe(2);

    // Techniques/norms are distinguished by variant, locations by tile.
    store.learn(
      entity,
      {
        type: KnowledgeType.ForagingTechnique,
        tileX: -1,
        tileY: -1,
        variantId: 2,
        strength: 0.5,
        origin: KnowledgeOrigin.Discovered,
        sourceEntity: -1,
      },
      14,
    );
    expect(store.bestOfType(entity, KnowledgeType.ForagingTechnique)).toEqual({
      strength: 0.5,
      variant: 2,
      tileX: -1,
      tileY: -1,
    });
    expect(store.countOfType(entity, KnowledgeType.SocialNorm)).toBe(0);
  });

  it('weakens (contradiction) and forgets items (nothing is permanent)', () => {
    const mini = makeContext(2, 16);
    const entity = spawnAgent(mini, 4, 4);
    const store = mini.ecs.culturalMemory;
    const { entry } = store.learn(
      entity,
      {
        type: KnowledgeType.WaterLocation,
        tileX: 3,
        tileY: 3,
        variantId: 0,
        strength: 0.6,
        origin: KnowledgeOrigin.Discovered,
        sourceEntity: -1,
      },
      0,
    );

    store.weaken(entry, 0.5);
    expect(store.entryStrength(entry)).toBeCloseTo(0.3, 5);
    // Weakness can never take strength below zero.
    store.weaken(entry, 5);
    expect(store.entryStrength(entry)).toBe(0);
    expect(store.strengthOf(entity, KnowledgeType.WaterLocation, 3, 3, 0)).toBe(0);

    // The item is still remembered (strength 0), and explicit forgetting works.
    expect(store.has(entity)).toBe(true);
    store.removeEntry(entity, entry);
    expect(store.countFor(entity)).toBe(0);
    expect(store.has(entity)).toBe(false);
    // Forgetting twice is safe (no dangling reference).
    store.removeEntry(entity, entry);
    expect(store.countFor(entity)).toBe(0);
  });

  it('bounds per-agent memory by capacity and evicts the weakest item', () => {
    const mini = makeContext(3, 16);
    const entity = spawnAgent(mini, 4, 4);
    const store = mini.ecs.culturalMemory;
    const capacity = mini.config.culture.memory.capacity;

    for (let i = 0; i < capacity + 12; i++) {
      store.learn(
        entity,
        {
          type: KnowledgeType.FoodLocation,
          tileX: i % 8,
          tileY: Math.floor(i / 8),
          variantId: 0,
          strength: 0.1 + (i % 7) * 0.1,
          origin: KnowledgeOrigin.Discovered,
          sourceEntity: -1,
        },
        i,
      );
    }
    expect(store.countFor(entity)).toBe(capacity);
    // Exactly `capacity` items are stored no matter how much is learned.
    let counted = 0;
    for (let e = store.headOf(entity); e !== -1; e = store.nextOf(e)) counted++;
    expect(counted).toBe(capacity);
    // The very weakest item (strength 0.1) is the one that was dropped.
    expect(store.find(entity, KnowledgeType.FoodLocation, 0, 0, 0)).toBe(-1);
  });

  it('keeps norms and techniques apart and sums total strength', () => {
    const mini = makeContext(4, 16);
    const entity = spawnAgent(mini, 4, 4);
    const store = mini.ecs.culturalMemory;
    for (const norm of [NormId.HelpOthers, NormId.AvoidConflict]) {
      store.learn(
        entity,
        {
          type: KnowledgeType.SocialNorm,
          tileX: -1,
          tileY: -1,
          variantId: norm,
          strength: 0.5,
          origin: KnowledgeOrigin.Imitated,
          sourceEntity: 7,
        },
        0,
      );
    }
    expect(store.countOfType(entity, KnowledgeType.SocialNorm)).toBe(2);
    expect(store.bestStrengthOfType(entity, KnowledgeType.SocialNorm)).toBeCloseTo(0.5, 5);
    expect(store.totalStrength(entity)).toBeCloseTo(1, 5);
    expect(store.countOfType(entity, KnowledgeType.WaterLocation)).toBe(0);
  });

  it('serializes and restores the exact chain, including metadata', () => {
    const mini = makeContext(5, 16);
    const a = spawnAgent(mini, 4, 4);
    const b = spawnAgent(mini, 5, 4);
    const store = mini.ecs.culturalMemory;
    const { entry } = store.learn(
      a,
      {
        type: KnowledgeType.ForagingTechnique,
        tileX: -1,
        tileY: -1,
        variantId: 1,
        strength: 0.7,
        origin: KnowledgeOrigin.Taught,
        sourceEntity: b,
      },
      5,
    );
    store.reinforce(entry, 0.2, 9);
    store.learn(
      b,
      {
        type: KnowledgeType.FoodLocation,
        tileX: 2,
        tileY: 1,
        variantId: 0,
        strength: 0.25,
        origin: KnowledgeOrigin.Discovered,
        sourceEntity: -1,
      },
      6,
    );

    const saved = store.serialize();
    const restored = makeContext(5, 16).ecs.culturalMemory;
    restored.restore(saved);

    expect(restored.serialize()).toEqual(saved);
    expect(restored.countFor(a)).toBe(1);
    expect(restored.entryStrength(restored.find(a, KnowledgeType.ForagingTechnique, -1, -1, 1))).toBeCloseTo(
      store.entryStrength(entry),
      5,
    );
    expect(restored.entryOrigin(restored.find(a, KnowledgeType.ForagingTechnique, -1, -1, 1))).toBe(
      KnowledgeOrigin.Taught,
    );
    expect(restored.entrySource(restored.find(a, KnowledgeType.ForagingTechnique, -1, -1, 1))).toBe(b);
  });

  it('removes every item for an agent and keeps carrier bookkeeping exact', () => {
    const mini = makeContext(6, 16);
    const a = spawnAgent(mini, 4, 4);
    const b = spawnAgent(mini, 5, 4);
    const store = mini.ecs.culturalMemory;
    for (const entity of [a, b]) {
      store.learn(
        entity,
        {
          type: KnowledgeType.WaterLocation,
          tileX: 1,
          tileY: 1,
          variantId: 0,
          strength: 0.5,
          origin: KnowledgeOrigin.Discovered,
          sourceEntity: -1,
        },
        0,
      );
    }
    expect(store.carrierIds()).toHaveLength(2);
    store.removeAll(a);
    expect(store.countFor(a)).toBe(0);
    expect(store.carrierIds()).toHaveLength(1);
    expect(store.carrierIds()[0]).toBe(b);
    // A removed agent's slots are reusable: learning again must not leak slots.
    store.learn(
      a,
      {
        type: KnowledgeType.WaterLocation,
        tileX: 4,
        tileY: 4,
        variantId: 0,
        strength: 0.5,
        origin: KnowledgeOrigin.Discovered,
        sourceEntity: -1,
      },
      1,
    );
    expect(store.countFor(a)).toBe(1);
    expect(store.carrierIds()).toHaveLength(2);
  });
});
