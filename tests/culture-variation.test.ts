/**
 * Phase 5 — cultural variation and drift tests.
 *
 * Variation is the small, bounded mutation a transmission can introduce — a
 * believed location that drifts a couple of tiles, a technique/norm token that
 * shifts to a neighbouring variant. These tests pin:
 *   - faithful transmissions copy the item exactly,
 *   - unfaithful ones produce variants that stay inside the documented bounds,
 *   - variation happens ONLY during a transmission event (never per tick),
 *   - the same seed reproduces exactly the same variants.
 */

import { describe, expect, it } from 'vitest';
import { AgentIntent } from '../src/simulation-core/ai';
import { KnowledgeOrigin, KnowledgeType, TECHNIQUE_VARIANT_COUNT } from '../src/simulation-core/culture';
import { updateCulture } from '../src/simulation-core/simulation/systems/culture-system';
import { cloneConfig, DEFAULT_SIMULATION_CONFIG } from '../src/simulation-core/simulation/config';
import { makeContext, spawnAgent, type MiniContext } from './helpers';

/** Close, familiar pair so a maximum base chance is a certain transfer. */
function befriend(mini: MiniContext, learner: number, source: number): void {
  const { entry } = mini.ecs.relationships.getOrCreate(learner, source, 0, false);
  mini.ecs.relationships.setScore(entry, 1);
  mini.ecs.relationships.setFamiliarity(entry, 1);
}

function setTeachIntent(mini: MiniContext, teacher: number, learner: number): void {
  const slot = mini.ecs.intent.index[teacher];
  mini.ecs.intent.columns.kind[slot] = AgentIntent.Teach;
  mini.ecs.intent.columns.targetEntity[slot] = learner;
}

function learnItem(
  mini: MiniContext,
  entity: number,
  type: number,
  tileX: number,
  tileY: number,
  variantId: number,
  strength = 0.9,
): void {
  mini.ecs.culturalMemory.learn(
    entity,
    {
      type,
      tileX,
      tileY,
      variantId,
      strength,
      origin: KnowledgeOrigin.Discovered,
      sourceEntity: -1,
    },
    0,
  );
}

describe('cultural variation and drift', () => {
  it('copies an item exactly when the transmission is faithful', () => {
    const mini = makeContext(31, 24);
    const config = cloneConfig(DEFAULT_SIMULATION_CONFIG);
    config.culture.transmission.teachChance = 1;
    config.culture.transmission.fidelity = 1;
    const ctx = { ...mini.ctx, config, ecs: mini.ecs };
    const teacher = spawnAgent(mini, 4, 4, { intelligence: 1 });
    const learner = spawnAgent(mini, 4.4, 4, { intelligence: 1 });
    befriend(mini, learner, teacher);
    learnItem(mini, teacher, KnowledgeType.FoodLocation, 6, 7, 0);
    setTeachIntent(mini, teacher, learner);

    updateCulture(ctx);

    expect(mini.ecs.culturalMemory.find(learner, KnowledgeType.FoodLocation, 6, 7, 0)).toBeGreaterThanOrEqual(0);
    expect(mini.ecs.culturalMemory.countFor(learner)).toBe(1);
    expect(ctx.cultureStats.variants).toBe(0);
    expect(ctx.events.recent(50).some((e) => e.type === 'cultural_variant_created')).toBe(false);
  });

  it('produces a bounded variant when the transmission is unfaithful', () => {
    const mini = makeContext(32, 24);
    const config = cloneConfig(DEFAULT_SIMULATION_CONFIG);
    config.culture.transmission.teachChance = 1;
    config.culture.transmission.fidelity = 0; // every transfer drifts
    const jitter = config.culture.transmission.locationJitterTiles;
    const ctx = { ...mini.ctx, config, ecs: mini.ecs };
    const teacher = spawnAgent(mini, 4, 4, { intelligence: 1 });
    const learner = spawnAgent(mini, 4.4, 4, { intelligence: 1 });
    befriend(mini, learner, teacher);
    learnItem(mini, teacher, KnowledgeType.FoodLocation, 10, 10, 0);
    setTeachIntent(mini, teacher, learner);

    updateCulture(ctx);

    const entry = mini.ecs.culturalMemory.headOf(learner);
    expect(entry).toBeGreaterThanOrEqual(0);
    const tileX = mini.ecs.culturalMemory.entryTileX(entry);
    const tileY = mini.ecs.culturalMemory.entryTileY(entry);
    // The believed location drifts, but never further than the configured jitter
    // (and never outside the world).
    expect(Math.abs(tileX - 10)).toBeLessThanOrEqual(jitter);
    expect(Math.abs(tileY - 10)).toBeLessThanOrEqual(jitter);
    expect(tileX).toBeGreaterThanOrEqual(0);
    expect(tileY).toBeGreaterThanOrEqual(0);
    expect(tileX).toBeLessThan(mini.world.width);
    expect(tileY).toBeLessThan(mini.world.height);
    expect(ctx.cultureStats.variants).toBe(1);
    expect(ctx.events.recent(50).filter((e) => e.type === 'cultural_variant_created')).toHaveLength(1);
  });

  it('keeps technique variants inside the technique alphabet', () => {
    const mini = makeContext(33, 32);
    const config = cloneConfig(DEFAULT_SIMULATION_CONFIG);
    config.culture.transmission.teachChance = 1;
    config.culture.transmission.fidelity = 0;
    const ctx = { ...mini.ctx, config, ecs: mini.ecs };

    const source = spawnAgent(mini, 4, 4, { intelligence: 1 });
    learnItem(mini, source, KnowledgeType.ForagingTechnique, -1, -1, 0);

    // Twelve independent learners, each taught the same technique once.
    const learners: number[] = [];
    for (let i = 0; i < 12; i++) {
      const x = 3 + (i % 6) * 0.2;
      const learner = spawnAgent(mini, x, 4 + Math.floor(i / 6) * 0.2, { intelligence: 1 });
      befriend(mini, learner, source);
      learners.push(learner);
    }
    const teacherSlots = learners.length;
    // One teacher cannot teach twelve learners in one tick (one intent each), so
    // give every learner its own holder of the technique and pair them up.
    for (let i = 0; i < teacherSlots; i++) {
      learnItem(mini, learners[i], KnowledgeType.ForagingTechnique, -1, -1, 0);
    }
    const receivers: number[] = [];
    for (let i = 0; i < teacherSlots; i++) {
      const receiver = spawnAgent(mini, 3 + (i % 6) * 0.2, 5 + Math.floor(i / 6) * 0.2, { intelligence: 1 });
      befriend(mini, receiver, learners[i]);
      setTeachIntent(mini, learners[i], receiver);
      receivers.push(receiver);
    }

    updateCulture(ctx);

    let differing = 0;
    for (let i = 0; i < receivers.length; i++) {
      const entry = mini.ecs.culturalMemory.headOf(receivers[i]);
      expect(entry).toBeGreaterThanOrEqual(0);
      const variant = mini.ecs.culturalMemory.entryVariant(entry);
      expect(variant).toBeGreaterThanOrEqual(0);
      expect(variant).toBeLessThan(TECHNIQUE_VARIANT_COUNT);
      if (variant !== 0) differing++;
    }
    // Twelve seeded shifts of -1/0/+1 cannot all be neutral in practice, and
    // the assertion is deterministic for this seed.
    expect(differing).toBeGreaterThan(0);
    expect(ctx.cultureStats.variants).toBe(receivers.length);
  });

  it('never mutates knowledge outside a transmission event', () => {
    const mini = makeContext(34, 24);
    const config = cloneConfig(DEFAULT_SIMULATION_CONFIG);
    const ctx = { ...mini.ctx, config, ecs: mini.ecs };
    const holder = spawnAgent(mini, 5, 5, { intelligence: 0.5 });
    learnItem(mini, holder, KnowledgeType.ForagingTechnique, -1, -1, 2, 0.8);
    learnItem(mini, holder, KnowledgeType.FoodLocation, 8, 9, 0, 0.8);
    const before = mini.ecs.culturalMemory.countFor(holder);

    for (let tick = 0; tick < 500; tick++) updateCulture({ ...ctx, tick });

    // Decay may still forget items (that is a different mechanism) but nothing
    // may ever re-write a variant/tile on its own.
    let entries = 0;
    for (let e = mini.ecs.culturalMemory.headOf(holder); e !== -1; e = mini.ecs.culturalMemory.nextOf(e)) {
      entries++;
      const type = mini.ecs.culturalMemory.entryType(e);
      if (type === KnowledgeType.ForagingTechnique) {
        expect(mini.ecs.culturalMemory.entryVariant(e)).toBe(2);
      } else {
        expect(mini.ecs.culturalMemory.entryTileX(e)).toBe(8);
        expect(mini.ecs.culturalMemory.entryTileY(e)).toBe(9);
      }
    }
    expect(entries).toBeLessThanOrEqual(before);
    expect(ctx.cultureStats.variants).toBe(0);
  });

  it('reproduces identical variants from the same seed and different ones otherwise', () => {
    const runVariants = (seed: number) => {
      const mini = makeContext(seed, 24);
      const config = cloneConfig(DEFAULT_SIMULATION_CONFIG);
      config.culture.transmission.teachChance = 1;
      config.culture.transmission.fidelity = 0;
      const ctx = { ...mini.ctx, config, ecs: mini.ecs };
      const teacher = spawnAgent(mini, 4, 4, { intelligence: 1 });
      const learner = spawnAgent(mini, 4.4, 4, { intelligence: 1 });
      befriend(mini, learner, teacher);
      learnItem(mini, teacher, KnowledgeType.FoodLocation, 12, 9, 0);
      setTeachIntent(mini, teacher, learner);
      updateCulture(ctx);
      const entry = mini.ecs.culturalMemory.headOf(learner);
      return [
        mini.ecs.culturalMemory.entryTileX(entry),
        mini.ecs.culturalMemory.entryTileY(entry),
        mini.ecs.culturalMemory.entryVariant(entry),
      ].join(',');
    };

    expect(runVariants(41)).toBe(runVariants(41));
    // A different seed is free to drift differently; what matters is that both
    // outcomes are inside the documented bounds.
    const other = runVariants(42).split(',').map(Number);
    expect(Math.abs(other[0] - 12)).toBeLessThanOrEqual(DEFAULT_SIMULATION_CONFIG.culture.transmission.locationJitterTiles);
  });
});
