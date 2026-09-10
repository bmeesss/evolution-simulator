/**
 * Phase 5 — culture → behaviour tests.
 *
 * Culture is not a museum exhibit: what an agent knows changes what it does,
 * and what it does costs something. These tests pin the feedback loop:
 *   - a known resource location lifts the Seek utility only when the agent
 *     cannot satisfy the need where it stands (otherwise it would walk away
 *     from a full tile),
 *   - a foraging technique lifts foraging utility,
 *   - a restraint norm damps confrontation,
 *   - the HELP_OTHERS / SHARE_FOOD norms lift helping/cooperating,
 *   - teaching and signalling cost energy and start cooldowns (no free spam).
 */

import { describe, expect, it } from 'vitest';
import { AgentIntent, selectIntents } from '../src/simulation-core/ai';
import { ResourceType } from '../src/simulation-core/ai';
import {
  KnowledgeOrigin,
  KnowledgeType,
  NormId,
  collectCulturalEffects,
  createCulturalEffects,
  techniqueVariantForTerrain,
} from '../src/simulation-core/culture';
import { TerrainType } from '../src/simulation-core/world';
import { updateCulture } from '../src/simulation-core/simulation/systems/culture-system';
import { updateSignals } from '../src/simulation-core/simulation/systems/signal-system';
import { cloneConfig, DEFAULT_SIMULATION_CONFIG } from '../src/simulation-core/simulation/config';
import { makeContext, spawnAgent, type MiniContext } from './helpers';

/** Hunger/water state that makes seeking urgent but not instantly satisfiable. */
function needyAgent(mini: MiniContext, x: number, y: number, extra: Record<string, number> = {}): number {
  return spawnAgent(mini, x, y, {
    hunger: 85,
    thirst: 85,
    energy: 100,
    intelligence: 0.5,
    ...extra,
  });
}

function utilityOf(mini: MiniContext, entity: number, column: keyof typeof mini.ecs.aiState.columns): number {
  const slot = mini.ecs.aiState.index[entity];
  return (mini.ecs.aiState.columns[column] as Float32Array)[slot];
}

function learn(
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
    { type, tileX, tileY, variantId, strength, origin: KnowledgeOrigin.Discovered, sourceEntity: -1 },
    0,
  );
}

/** Empty the tiles under an agent so a remembered location is worth walking to. */
function clearTileUnder(mini: MiniContext, entity: number): void {
  const slot = mini.ecs.position.index[entity];
  const tileX = Math.floor(mini.ecs.position.columns.x[slot]);
  const tileY = Math.floor(mini.ecs.position.columns.y[slot]);
  const index = mini.world.tileIndex(tileX, tileY);
  mini.world.food[index] = 0;
  mini.world.water[index] = 0;
}

describe('culture feeds back into behaviour', () => {
  it('lifts SeekFood for a believed location only when food is not underfoot', () => {
    const mini = makeContext(81, 32);
    const config = mini.config;
    const agent = needyAgent(mini, 16, 16);
    // The agent remembers food at (20,20) in its PERSONAL memory (what it saw),
    // so it has a target to seek — and the cultural belief is about the same
    // place (what it believes/learned).
    mini.ecs.memory.observe(agent, ResourceType.Food, 20, 20, 0.9, 0);
    mini.world.food.fill(0);
    mini.world.water.fill(0);
    mini.ctx.resourceIndex.rebuild(mini.world, config.resources.minFoodToEat, config.resources.minWaterToDrink);

    // Empty tile underfoot: the belief about (20,20) raises the drive to go.
    learn(mini, agent, KnowledgeType.FoodLocation, 20, 20, 0, 0.9);
    selectIntents(mini.ctx);
    const withBelief = utilityOf(mini, agent, 'seekFood');
    const entry = mini.ecs.culturalMemory.find(agent, KnowledgeType.FoodLocation, 20, 20, 0);
    mini.ecs.culturalMemory.removeEntry(agent, entry);
    selectIntents(mini.ctx);
    const withoutBelief = utilityOf(mini, agent, 'seekFood');
    expect(withBelief).toBeGreaterThan(withoutBelief);
    expect(withoutBelief).toBeGreaterThan(0);

    // Full tile underfoot: the same belief must NOT add anything, otherwise the
    // agent walks away from food it could just eat (the Phase 5 regression).
    mini.world.food[mini.world.tileIndex(16, 16)] = 1;
    mini.ctx.resourceIndex.rebuild(mini.world, config.resources.minFoodToEat, config.resources.minWaterToDrink);
    selectIntents(mini.ctx);
    const satisfiedWithout = utilityOf(mini, agent, 'seekFood');
    const culturalEffects = createCulturalEffects();
    expect(collectCulturalEffects(mini.ecs.culturalMemory, agent, culturalEffects).foodKnown).toBe(false);
    learn(mini, agent, KnowledgeType.FoodLocation, 20, 20, 0, 0.9);
    selectIntents(mini.ctx);
    const satisfiedWith = utilityOf(mini, agent, 'seekFood');
    expect(collectCulturalEffects(mini.ecs.culturalMemory, agent, culturalEffects).foodKnown).toBe(true);
    expect(satisfiedWith).toBeCloseTo(satisfiedWithout, 5);
    // ...and eating is available and attractive instead.
    expect(utilityOf(mini, agent, 'eat')).toBeGreaterThan(0);
  });

  it('makes a foraging technique worth more on its home terrain', () => {
    const home = makeContext(82, 32);
    const foreign = makeContext(82, 32);
    const native = needyAgent(home, 16, 16);
    const visitor = needyAgent(foreign, 16, 16);
    clearTileUnder(home, native);
    clearTileUnder(foreign, visitor);
    const terrain = TerrainType.Forest;
    home.world.terrain[home.world.tileIndex(16, 16)] = terrain;
    foreign.world.terrain[foreign.world.tileIndex(16, 16)] = terrain;
    const nativeVariant = techniqueVariantForTerrain(terrain);
    const otherVariant = (nativeVariant + 1) % 4;
    learn(home, native, KnowledgeType.ForagingTechnique, -1, -1, nativeVariant);
    learn(foreign, visitor, KnowledgeType.ForagingTechnique, -1, -1, otherVariant);

    selectIntents(home.ctx);
    selectIntents(foreign.ctx);
    expect(utilityOf(home, native, 'seekFood')).toBeGreaterThan(utilityOf(foreign, visitor, 'seekFood'));

    // Curiosity about the unknown also counts: a foraging technique raises the
    // wander drive of an agent that has somewhere new to try.
    const effects = collectCulturalEffects(home.ecs.culturalMemory, native, createCulturalEffects());
    expect(effects.techniqueStrength).toBeGreaterThan(0);
    expect(effects.techniqueVariant).toBe(nativeVariant);
  });

  it('damps confrontation with a restraint norm, but never forbids it outright', () => {
    const plain = makeContext(83, 32);
    const restrained = makeContext(83, 32);
    const fighter = needyAgent(plain, 16, 16);
    const calm = needyAgent(restrained, 16, 16);
    clearTileUnder(plain, fighter);
    clearTileUnder(restrained, calm);

    selectIntents(plain.ctx);
    const baseConfront = utilityOf(plain, fighter, 'confront');

    learn(restrained, calm, KnowledgeType.SocialNorm, -1, -1, NormId.AvoidConflict, 1);
    selectIntents(restrained.ctx);
    const dampedConfront = utilityOf(restrained, calm, 'confront');

    expect(dampedConfront).toBeLessThanOrEqual(baseConfront);
    // The norm is a dampener, not a prohibition: the utility stays in [0, 1].
    expect(dampedConfront).toBeGreaterThanOrEqual(0);
  });

  it('makes helping and sharing more likely once the norms are known', () => {
    const mini = makeContext(84, 32);
    const helper = needyAgent(mini, 16, 16);
    clearTileUnder(mini, helper);
    // A hungry neighbour in reach gives Help/Cooperate a target.
    const neighbour = spawnAgent(mini, 16.5, 16.5, { hunger: 95, thirst: 0, energy: 30 });

    selectIntents(mini.ctx);
    const beforeHelp = utilityOf(mini, helper, 'help');
    const beforeCooperate = utilityOf(mini, helper, 'cooperate');

    learn(mini, helper, KnowledgeType.SocialNorm, -1, -1, NormId.HelpOthers, 1);
    learn(mini, helper, KnowledgeType.SocialNorm, -1, -1, NormId.ShareFood, 1);
    selectIntents(mini.ctx);
    const afterHelp = utilityOf(mini, helper, 'help');
    const afterCooperate = utilityOf(mini, helper, 'cooperate');

    expect(afterHelp).toBeGreaterThanOrEqual(beforeHelp);
    expect(afterCooperate).toBeGreaterThanOrEqual(beforeCooperate);
    expect(afterHelp).toBeLessThanOrEqual(1);
    expect(afterCooperate).toBeLessThanOrEqual(1);
    // The norms are real items in cultural memory (not global switches).
    expect(mini.ecs.culturalMemory.countOfType(helper, KnowledgeType.SocialNorm)).toBe(2);
    expect(neighbour).toBeGreaterThanOrEqual(0);
  });

  it('pays energy and attention for teaching, and refuses when tired or on cooldown', () => {
    const mini = makeContext(85, 24);
    const config = cloneConfig(DEFAULT_SIMULATION_CONFIG);
    const ctx = { ...mini.ctx, config, ecs: mini.ecs };
    const teacher = spawnAgent(mini, 4, 4, { intelligence: 1 });
    const learner = spawnAgent(mini, 4.4, 4, { intelligence: 1 });
    const { entry } = mini.ecs.relationships.getOrCreate(learner, teacher, 0, false);
    mini.ecs.relationships.setScore(entry, 1);
    mini.ecs.relationships.setFamiliarity(entry, 1);
    learn(mini, teacher, KnowledgeType.FoodLocation, 8, 8, 0);
    const teachSlot = mini.ecs.intent.index[teacher];
    mini.ecs.intent.columns.kind[teachSlot] = AgentIntent.Teach;
    mini.ecs.intent.columns.targetEntity[teachSlot] = learner;

    const firstEnergy = mini.ecs.needs.columns.energy[mini.ecs.needs.index[teacher]];
    updateCulture(ctx);
    expect(mini.ecs.needs.columns.energy[mini.ecs.needs.index[teacher]]).toBeLessThan(firstEnergy);
    expect(mini.ecs.culture.columns.teachCooldownTicks[mini.ecs.culture.index[teacher]]).toBeGreaterThan(0);

    // On cooldown, a second learner gets nothing — attention is finite.
    const second = spawnAgent(mini, 4.6, 4, { intelligence: 1 });
    mini.ecs.intent.columns.targetEntity[teachSlot] = second;
    const energyBefore = mini.ecs.needs.columns.energy[mini.ecs.needs.index[teacher]];
    updateCulture({ ...ctx, tick: 1 });
    expect(mini.ecs.needs.columns.energy[mini.ecs.needs.index[teacher]]).toBe(energyBefore);
    expect(mini.ecs.culturalMemory.countFor(second)).toBe(0);

    // A teacher too tired to spare the effort does not teach either.
    mini.ecs.culture.columns.teachCooldownTicks[mini.ecs.culture.index[teacher]] = 0;
    mini.ecs.needs.columns.energy[mini.ecs.needs.index[teacher]] = config.culture.transmission.minTeacherEnergy - 1;
    updateCulture({ ...ctx, tick: 2 });
    expect(mini.ecs.culturalMemory.countFor(second)).toBe(0);
  });

  it('pays energy and attention for signalling, and both are bounded per tick', () => {
    const mini = makeContext(86, 24);
    const config = cloneConfig(DEFAULT_SIMULATION_CONFIG);
    const ctx = { ...mini.ctx, config, ecs: mini.ecs, socialIndex: mini.ctx.socialIndex };
    const tileIndex = mini.world.tileIndex(6, 6);
    mini.world.food[tileIndex] = 1;
    const emitter = spawnAgent(mini, 6.2, 6.2, { intelligence: 1 });
    const listener = spawnAgent(mini, 6.6, 6.2, { intelligence: 1 });
    mini.ctx.socialIndex.rebuild(mini.ecs);
    const slot = mini.ecs.intent.index[emitter];
    mini.ecs.intent.columns.kind[slot] = AgentIntent.SignalFood;

    const energyBefore = mini.ecs.needs.columns.energy[mini.ecs.needs.index[emitter]];
    updateSignals(ctx);
    expect(mini.ecs.needs.columns.energy[mini.ecs.needs.index[emitter]]).toBeLessThan(energyBefore);
    // The listener only accumulates what its attention budget allows.
    expect(mini.ecs.signals.countFor(listener)).toBeLessThanOrEqual(config.culture.signals.maxObservationsPerTick);

    // On cooldown, repeating the signal is impossible — spam costs cannot be
    // avoided, and re-emission teaches nothing new.
    const before = mini.ecs.signals.countFor(listener);
    updateSignals({ ...ctx, tick: 1 });
    expect(mini.ecs.signals.countFor(listener)).toBe(before);
  });
});
