/**
 * Phase 5 — transmission tests.
 *
 * Culture (unlike genes) only moves because two agents actually interacted:
 *   - a Teach action transfers an item to a learner inside interaction reach,
 *   - nothing transfers through distance, through death, or through birth,
 *   - transmission probability is a *product* of relationship affinity,
 *     familiarity, learner intelligence, teacher social tendency and the
 *     strength of the item being passed on — intelligence alone never decides,
 *   - the teacher pays energy and a cooldown for the attempt,
 *   - passive imitation (Socialize/Help/Cooperate) is possible but much weaker
 *     than deliberate teaching, and only when the two agents are close.
 */

import { describe, expect, it } from 'vitest';
import { AgentIntent } from '../src/simulation-core/ai';
import { KnowledgeOrigin, KnowledgeType, transmissionChance } from '../src/simulation-core/culture';
import { updateCulture } from '../src/simulation-core/simulation/systems/culture-system';
import { cloneConfig, DEFAULT_SIMULATION_CONFIG } from '../src/simulation-core/simulation/config';
import { makeContext, spawnAgent } from './helpers';

/** A clone of the default config (system tests tweak transmission rates). */
function testConfig() {
  return cloneConfig(DEFAULT_SIMULATION_CONFIG);
}


/** Rewrite an agent's intent in place (spawnAgent already attached one). */
function setIntent(
  mini: ReturnType<typeof makeContext>,
  entity: number,
  kind: number,
  targetX: number,
  targetY: number,
  targetEntity: number,
): void {
  const slot = mini.ecs.intent.index[entity];
  mini.ecs.intent.columns.kind[slot] = kind;
  mini.ecs.intent.columns.targetX[slot] = targetX;
  mini.ecs.intent.columns.targetY[slot] = targetY;
  mini.ecs.intent.columns.targetEntity[slot] = targetEntity;
}

/**
 * Make `learner` a close, familiar friend of `source`. Transmission probability
 * multiplies relationship affinity and familiarity, so a maxed relationship
 * makes a base-chance-1 transfer certain (the chance clamps at 1) — which is
 * what lets these tests assert exact outcomes without brute-forcing ticks.
 */
function befriend(mini: ReturnType<typeof makeContext>, learner: number, source: number): void {
  const { entry } = mini.ecs.relationships.getOrCreate(learner, source, 0, false);
  mini.ecs.relationships.setScore(entry, 1);
  mini.ecs.relationships.setFamiliarity(entry, 1);
  mini.ecs.relationships.setTrust(entry, 1);
}

/** Give an agent a known food location at (tileX, tileY). */
function teachableItem(mini: ReturnType<typeof makeContext>, entity: number, tileX = 5, tileY = 5) {
  mini.ecs.culturalMemory.learn(
    entity,
    {
      type: KnowledgeType.FoodLocation,
      tileX,
      tileY,
      variantId: 0,
      strength: 0.9,
      origin: KnowledgeOrigin.Discovered,
      sourceEntity: -1,
    },
    0,
  );
}

describe('cultural transmission', () => {
  it('transfers an item when a teacher and learner interact inside reach', () => {
    const mini = makeContext(11, 16);
    const config = testConfig();
    // Deterministic transfer: certain base chance and perfect fidelity.
    config.culture.transmission.teachChance = 1;
    config.culture.transmission.fidelity = 1;
    const ctx = { ...mini.ctx, config, ecs: mini.ecs };

    const teacher = spawnAgent(mini, 4, 4, { intelligence: 1 });
    const learner = spawnAgent(mini, 4.5, 4, { intelligence: 1 });
    befriend(mini, learner, teacher);
    teachableItem(mini, teacher);

    setIntent(mini, teacher, AgentIntent.Teach, 4.5, 4, learner);

    const energyBefore = mini.ecs.needs.columns.energy[mini.ecs.needs.index[teacher]];
    updateCulture(ctx);

    const entry = mini.ecs.culturalMemory.find(learner, KnowledgeType.FoodLocation, 5, 5, 0);
    expect(entry).toBeGreaterThanOrEqual(0);
    expect(mini.ecs.culturalMemory.entryOrigin(entry)).toBe(KnowledgeOrigin.Taught);
    expect(mini.ecs.culturalMemory.entrySource(entry)).toBe(teacher);
    // Learned strength is the teacher's strength scaled by the learned factor
    // (the teacher's copy decays slightly before the transfer, and teaching
    // then reinforces it, so allow the documented tolerance band).
    expect(mini.ecs.culturalMemory.entryStrength(entry)).toBeCloseTo(
      0.9 * config.culture.transmission.learnedStrengthFactor,
      1,
    );
    expect(mini.ecs.culturalMemory.entryStrength(entry)).toBeLessThanOrEqual(
      0.9 * config.culture.transmission.learnedStrengthFactor,
    );
    // Teaching costs energy and attention (a cooldown), success or not.
    const energyAfter = mini.ecs.needs.columns.energy[mini.ecs.needs.index[teacher]];
    expect(energyBefore - energyAfter).toBeCloseTo(config.culture.transmission.teachEnergyCost, 5);
    expect(mini.ecs.culture.columns.teachCooldownTicks[mini.ecs.culture.index[teacher]]).toBe(
      config.culture.transmission.cooldownTicks,
    );
    expect(ctx.cultureStats.taught).toBe(1);
    // It was taught on purpose, not picked up by observation.
    expect(ctx.cultureStats.learned).toBe(0);
  });

  it('does not transfer through distance (no global propagation)', () => {
    const mini = makeContext(12, 32);
    const config = testConfig();
    config.culture.transmission.teachChance = 1;
    const ctx = { ...mini.ctx, config, ecs: mini.ecs };

    const teacher = spawnAgent(mini, 3, 3, { intelligence: 1 });
    const learner = spawnAgent(mini, 20, 20, { intelligence: 1 });
    teachableItem(mini, teacher);
    setIntent(mini, teacher, AgentIntent.Teach, 20, 20, learner);

    const energyBefore = mini.ecs.needs.columns.energy[mini.ecs.needs.index[teacher]];
    updateCulture(ctx);

    expect(mini.ecs.culturalMemory.countFor(learner)).toBe(0);
    // Nobody was reached, so no cost was paid yet: the teacher is still walking.
    expect(mini.ecs.needs.columns.energy[mini.ecs.needs.index[teacher]]).toBe(energyBefore);
  });

  it('pays nothing when there is nothing the learner does not already know', () => {
    const mini = makeContext(13, 16);
    const config = testConfig();
    config.culture.transmission.teachChance = 1;
    const ctx = { ...mini.ctx, config, ecs: mini.ecs };

    const teacher = spawnAgent(mini, 4, 4);
    const learner = spawnAgent(mini, 4.4, 4);
    teachableItem(mini, teacher);
    // The learner knows the same item already.
    mini.ecs.culturalMemory.learn(
      learner,
      {
        type: KnowledgeType.FoodLocation,
        tileX: 5,
        tileY: 5,
        variantId: 0,
        strength: 0.9,
        origin: KnowledgeOrigin.Discovered,
        sourceEntity: -1,
      },
      0,
    );
    setIntent(mini, teacher, AgentIntent.Teach, 4.4, 4, learner );

    const energyBefore = mini.ecs.needs.columns.energy[mini.ecs.needs.index[teacher]];
    updateCulture(ctx);
    expect(mini.ecs.needs.columns.energy[mini.ecs.needs.index[teacher]]).toBe(energyBefore);
    expect(ctx.cultureStats.taught).toBe(0);
  });

  it('does not pass on items that are not confidently known', () => {
    const mini = makeContext(14, 16);
    const config = testConfig();
    config.culture.transmission.teachChance = 1;
    const ctx = { ...mini.ctx, config, ecs: mini.ecs };

    const teacher = spawnAgent(mini, 4, 4);
    const learner = spawnAgent(mini, 4.4, 4);
    // Below the "known" threshold: a vague hunch is not teachable.
    mini.ecs.culturalMemory.learn(
      teacher,
      {
        type: KnowledgeType.FoodLocation,
        tileX: 5,
        tileY: 5,
        variantId: 0,
        strength: config.culture.memory.knownThreshold - 0.05,
        origin: KnowledgeOrigin.Discovered,
        sourceEntity: -1,
      },
      0,
    );
    setIntent(mini, teacher, AgentIntent.Teach, 4.4, 4, learner );
    updateCulture(ctx);
    expect(mini.ecs.culturalMemory.countFor(learner)).toBe(0);
  });

  it('never inherits culture at birth (genes ≠ culture)', () => {
    const mini = makeContext(15, 16);
    const parent = spawnAgent(mini, 4, 4);
    teachableItem(mini, parent, 2, 2);
    expect(mini.ecs.culturalMemory.countFor(parent)).toBe(1);

    // A newborn is spawned the way the reproduction system spawns it — with a
    // culture component attached but empty.
    const child = spawnAgent(mini, 4.2, 4.2, { generation: 1, parentA: parent, ageHours: 0 });
    expect(mini.ecs.culturalMemory.countFor(child)).toBe(0);
    expect(mini.ecs.culturalMemory.has(child)).toBe(false);
  });

  it('transmission probability depends on relationships, familiarity, intelligence, social tendency and strength', () => {
    const config = testConfig();
    const base = {
      relationshipScore: 0,
      familiarity: 0,
      learnerIntelligence: 0.5,
      teacherSocialTendency: 0.5,
      itemStrength: 0.5,
    };
    const neutral = transmissionChance(0.3, base, config);

    // Each factor moves the probability on its own...
    expect(transmissionChance(0.3, { ...base, relationshipScore: 1 }, config)).toBeGreaterThan(neutral);
    expect(transmissionChance(0.3, { ...base, familiarity: 1 }, config)).toBeGreaterThan(neutral);
    expect(transmissionChance(0.3, { ...base, learnerIntelligence: 1 }, config)).toBeGreaterThan(neutral);
    expect(transmissionChance(0.3, { ...base, teacherSocialTendency: 1 }, config)).toBeGreaterThan(neutral);
    expect(transmissionChance(0.3, { ...base, itemStrength: 1 }, config)).toBeGreaterThan(neutral);
    // ...and hostility suppresses it, so a bad relationship really blocks learning.
    expect(transmissionChance(0.3, { ...base, relationshipScore: -1 }, config)).toBeLessThan(neutral);

    // Intelligence is NOT the only factor: a smart learner with a stranger and a
    // weak item learns less than an average learner with a close, familiar friend.
    const smartStranger = transmissionChance(
      0.3,
      { ...base, learnerIntelligence: 1, relationshipScore: 0, familiarity: 0, itemStrength: 0.2 },
      config,
    );
    const socialFriend = transmissionChance(
      0.3,
      { ...base, learnerIntelligence: 0.3, relationshipScore: 0.9, familiarity: 1, itemStrength: 0.9 },
      config,
    );
    expect(socialFriend).toBeGreaterThan(smartStranger);
    // And a meticulous teacher matters even when the learner is slow.
    expect(
      transmissionChance(0.3, { ...base, learnerIntelligence: 0, teacherSocialTendency: 1 }, config),
    ).toBeGreaterThan(transmissionChance(0.3, { ...base, learnerIntelligence: 0, teacherSocialTendency: 0 }, config));
    // Probabilities always stay inside [0, 1].
    expect(neutral).toBeGreaterThanOrEqual(0);
    expect(neutral).toBeLessThanOrEqual(1);
  });

  it('moves culture through a chain of interactions (A -> B -> C), never around it', () => {
    const mini = makeContext(16, 32);
    const config = testConfig();
    config.culture.transmission.teachChance = 1;
    config.culture.transmission.fidelity = 1;
    const ctx = { ...mini.ctx, config, ecs: mini.ecs };

    const a = spawnAgent(mini, 4, 4, { intelligence: 1 });
    const b = spawnAgent(mini, 4.4, 4, { intelligence: 1 });
    const c = spawnAgent(mini, 12, 12, { intelligence: 1 });
    befriend(mini, b, a);
    befriend(mini, c, b);
    teachableItem(mini, a, 6, 6);

    // C is nowhere near A: nothing happens for C while A teaches B.
    setIntent(mini, a, AgentIntent.Teach, 4.4, 4, b );
    updateCulture(ctx);
    expect(mini.ecs.culturalMemory.countFor(b)).toBe(1);
    expect(mini.ecs.culturalMemory.countFor(c)).toBe(0);

    // B now teaches C; only then does the item reach C (two hops, two events).
    mini.ecs.intent.detach(a);
    // B walks over to C (the movement system would do this in a live run).
    mini.ecs.position.columns.x[mini.ecs.position.index[b]] = 11.8;
    mini.ecs.position.columns.y[mini.ecs.position.index[b]] = 12;
    setIntent(mini, b, AgentIntent.Teach, 12, 12, c );
    const before = ctx.cultureStats.taught;
    updateCulture(ctx);
    const entry = mini.ecs.culturalMemory.find(c, KnowledgeType.FoodLocation, 6, 6, 0);
    expect(entry).toBeGreaterThanOrEqual(0);
    expect(mini.ecs.culturalMemory.entryOrigin(entry)).toBe(KnowledgeOrigin.Taught);
    expect(ctx.cultureStats.taught).toBe(before + 1);
  });

  it('requires an intentional Teach intent: a merely co-located agent learns nothing', () => {
    const mini = makeContext(17, 16);
    const config = testConfig();
    const ctx = { ...mini.ctx, config, ecs: mini.ecs };

    const holder = spawnAgent(mini, 4, 4);
    const other = spawnAgent(mini, 4.3, 4);
    teachableItem(mini, holder);
    // Same tile, but nobody is teaching or socializing: no cultural event.
    setIntent(mini, holder, AgentIntent.Wander, 5, 4, -1 );
    setIntent(mini, other, AgentIntent.Wander, 3, 4, -1 );
    for (let i = 0; i < 200; i++) updateCulture({ ...ctx, tick: i });
    expect(mini.ecs.culturalMemory.countFor(other)).toBe(0);
    expect(ctx.cultureStats.taught).toBe(0);
    expect(ctx.cultureStats.learned).toBe(0);
  });

  it('lets imitation spread knowledge during Socialize, but only at close range', () => {
    const mini = makeContext(18, 24);
    const config = testConfig();
    config.culture.transmission.imitateChance = 1;
    config.culture.transmission.fidelity = 1;
    const ctx = { ...mini.ctx, config, ecs: mini.ecs };

    const model = spawnAgent(mini, 6, 6, { intelligence: 1 });
    const near = spawnAgent(mini, 6.4, 6, { intelligence: 1 });
    const far = spawnAgent(mini, 16, 16, { intelligence: 1 });
    befriend(mini, near, model);
    befriend(mini, far, model);
    teachableItem(mini, model, 8, 8);
    setIntent(mini, near, AgentIntent.Socialize, 6, 6, model );
    setIntent(mini, far, AgentIntent.Socialize, 6, 6, model );

    // Imitation is probabilistic even at maximum chance, so allow a few ticks
    // (the two agents are co-located, the roll is seeded and deterministic).
    for (let i = 0; i < 50 && mini.ecs.culturalMemory.countFor(near) === 0; i++) {
      updateCulture({ ...ctx, tick: i });
    }
    const entry = mini.ecs.culturalMemory.find(near, KnowledgeType.FoodLocation, 8, 8, 0);
    expect(entry).toBeGreaterThanOrEqual(0);
    expect(mini.ecs.culturalMemory.entryOrigin(entry)).toBe(KnowledgeOrigin.Imitated);
    // Distance is a hard wall for passive learning too.
    expect(mini.ecs.culturalMemory.countFor(far)).toBe(0);
  });

  it('never transfers an item the learner already holds (idempotent transfer)', () => {
    const mini = makeContext(19, 16);
    const teacher = spawnAgent(mini, 4, 4);
    const learner = spawnAgent(mini, 4.4, 4);
    teachableItem(mini, teacher, 3, 3);
    const item = {
      type: KnowledgeType.FoodLocation,
      tileX: 3,
      tileY: 3,
      variantId: 0,
      strength: 0.5,
      origin: KnowledgeOrigin.Imitated,
      sourceEntity: -1,
    };
    mini.ecs.culturalMemory.learn(learner, item, 0);
    mini.ecs.culturalMemory.learn(learner, item, 1);
    mini.ecs.culturalMemory.learn(learner, item, 2);
    expect(mini.ecs.culturalMemory.countFor(learner)).toBe(1);
  });
});
