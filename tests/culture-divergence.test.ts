/**
 * Phase 5 — cultural divergence tests.
 *
 * Divergence is the consequence of geography and networks, never of an
 * assignment: two groups of agents that never meet develop different knowledge,
 * and the moment they DO meet, items cross through the interaction and the two
 * cultures start to converge. These tests build both situations explicitly and
 * assert the aggregates — and that isolation is a hard wall unless two agents
 * are actually in reach of each other.
 */

import { describe, expect, it } from 'vitest';
import { AgentIntent } from '../src/simulation-core/ai';
import {
  KnowledgeOrigin,
  KnowledgeType,
  culturalSimilarity,
  summarizeCulture,
  techniqueVariantForTerrain,
} from '../src/simulation-core/culture';
import { TerrainType } from '../src/simulation-core/world';
import { updateCulture } from '../src/simulation-core/simulation/systems/culture-system';
import { interactWithResources } from '../src/simulation-core/simulation/systems/resource-system';
import { cloneConfig, DEFAULT_SIMULATION_CONFIG } from '../src/simulation-core/simulation/config';
import { makeContext, spawnAgent, type MiniContext } from './helpers';

interface Cluster {
  readonly members: number[];
}

/** Two tight clusters, far apart: only within-cluster contact is possible. */
function makeClusters(seed: number): { mini: MiniContext; a: Cluster; b: Cluster } {
  const mini = makeContext(seed, 48);
  const a: number[] = [];
  const b: number[] = [];
  for (let i = 0; i < 6; i++) {
    const dx = (i % 3) * 0.3;
    const dy = Math.floor(i / 3) * 0.3;
    a.push(spawnAgent(mini, 5 + dx, 5 + dy, { intelligence: 1 }));
    b.push(spawnAgent(mini, 40 + dx, 40 + dy, { intelligence: 1 }));
  }
  return { mini, a: { members: a }, b: { members: b } };
}

function setIntent(mini: MiniContext, entity: number, kind: number, target: number): void {
  const slot = mini.ecs.intent.index[entity];
  mini.ecs.intent.columns.kind[slot] = kind;
  mini.ecs.intent.columns.targetEntity[slot] = target;
}

function befriend(mini: MiniContext, learner: number, source: number): void {
  const { entry } = mini.ecs.relationships.getOrCreate(learner, source, 0, false);
  mini.ecs.relationships.setScore(entry, 1);
  mini.ecs.relationships.setFamiliarity(entry, 1);
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

function summarizeCluster(mini: MiniContext, cluster: Cluster) {
  return summarizeCulture(mini.ecs.culturalMemory, mini.ecs.signals, cluster.members, cluster.members.length, mini.config);
}

describe('cultural divergence', () => {
  it('keeps isolated groups apart even while each spreads knowledge internally', () => {
    const { mini, a, b } = makeClusters(71);
    const config = cloneConfig(DEFAULT_SIMULATION_CONFIG);
    config.culture.transmission.teachChance = 1;
    config.culture.transmission.imitateChance = 1;
    const ctx = { ...mini.ctx, config, ecs: mini.ecs };

    // Two local discoveries: A's food patch and B's water hole. Nothing shared.
    learn(mini, a.members[0], KnowledgeType.FoodLocation, 4, 4, 0);
    learn(mini, b.members[0], KnowledgeType.WaterLocation, 42, 42, 0);
    // Everyone socializes with a neighbour inside their own cluster.
    for (const members of [a.members, b.members]) {
      for (let i = 0; i < members.length; i++) {
        const partner = members[(i + 1) % members.length];
        befriend(mini, members[i], partner);
        setIntent(mini, members[i], AgentIntent.Socialize, partner);
      }
    }

    for (let tick = 0; tick < 300; tick++) updateCulture({ ...ctx, tick });

    // Each cluster spread its own item; no item crossed the gap.
    expect(mini.ecs.culturalMemory.countFor(a.members[2])).toBeGreaterThanOrEqual(0);
    let crossCluster = 0;
    let spreadWithinA = 0;
    let spreadWithinB = 0;
    for (const entity of a.members) {
      for (let e = mini.ecs.culturalMemory.headOf(entity); e !== -1; e = mini.ecs.culturalMemory.nextOf(e)) {
        if (mini.ecs.culturalMemory.entryType(e) === KnowledgeType.WaterLocation) crossCluster++;
        if (mini.ecs.culturalMemory.entryType(e) === KnowledgeType.FoodLocation) spreadWithinA++;
      }
    }
    for (const entity of b.members) {
      for (let e = mini.ecs.culturalMemory.headOf(entity); e !== -1; e = mini.ecs.culturalMemory.nextOf(e)) {
        if (mini.ecs.culturalMemory.entryType(e) === KnowledgeType.FoodLocation) crossCluster++;
        if (mini.ecs.culturalMemory.entryType(e) === KnowledgeType.WaterLocation) spreadWithinB++;
      }
    }
    expect(crossCluster).toBe(0); // isolation is a hard wall
    expect(spreadWithinA).toBeGreaterThan(1); // but each cluster did spread internally
    expect(spreadWithinB).toBeGreaterThan(1);

    const summaryA = summarizeCluster(mini, a);
    const summaryB = summarizeCluster(mini, b);
    expect(summaryA.carriers).toBeGreaterThan(1);
    expect(summaryB.carriers).toBeGreaterThan(1);
    expect(summaryA.knowledgeItems).toBeGreaterThan(0);
    expect(summaryB.knowledgeItems).toBeGreaterThan(0);
    // Different knowledge, no shared signals: the two cultures have nothing in
    // common.
    expect(culturalSimilarity(summaryA, summaryB, mini.config)).toBeCloseTo(0, 5);
  });

  it('shares knowledge as soon as members of the two groups actually meet', () => {
    const { mini, a, b } = makeClusters(72);
    const config = cloneConfig(DEFAULT_SIMULATION_CONFIG);
    config.culture.transmission.teachChance = 1;
    config.culture.transmission.fidelity = 1;
    const ctx = { ...mini.ctx, config, ecs: mini.ecs };

    learn(mini, a.members[0], KnowledgeType.FoodLocation, 4, 4, 0);
    learn(mini, b.members[0], KnowledgeType.WaterLocation, 42, 42, 0);

    const before = culturalSimilarity(summarizeCluster(mini, a), summarizeCluster(mini, b), mini.config);
    expect(before).toBeCloseTo(0, 5);

    // Contact: A's carrier walks to B's camp and teaches one of its members.
    const learner = b.members[3];
    befriend(mini, learner, a.members[0]);
    mini.ecs.position.columns.x[mini.ecs.position.index[a.members[0]]] =
      mini.ecs.position.columns.x[mini.ecs.position.index[learner]];
    mini.ecs.position.columns.y[mini.ecs.position.index[a.members[0]]] =
      mini.ecs.position.columns.y[mini.ecs.position.index[learner]];
    setIntent(mini, a.members[0], AgentIntent.Teach, learner);
    updateCulture(ctx);

    expect(mini.ecs.culturalMemory.find(learner, KnowledgeType.FoodLocation, 4, 4, 0)).toBeGreaterThanOrEqual(0);

    // That single contact makes the two groups share one item: similarity rises
    // but stays far below "identical" (they still differ in everything else).
    const after = culturalSimilarity(summarizeCluster(mini, a), summarizeCluster(mini, b), mini.config);
    expect(after).toBeGreaterThan(before);
    expect(after).toBeGreaterThanOrEqual(0);
    expect(after).toBeLessThanOrEqual(1);
    expect(after).toBeLessThan(1);
  });

  it('derives technical traditions from the terrain the group lives on', () => {
    const mini = makeContext(73, 24);
    const config = cloneConfig(DEFAULT_SIMULATION_CONFIG);
    // Deterministic discovery: every successful forage produces the local
    // technique, and it always matches the habitat.
    config.culture.discovery.locationChancePerForage = 1;
    config.culture.discovery.techniqueChancePerForage = 1;
    config.culture.discovery.habitatMatchChance = 1;
    const ctx = { ...mini.ctx, config, ecs: mini.ecs };

    // Three foragers on forest tiles, three on sand tiles. Nothing is assigned
    // to them: before they forage, they know nothing at all.
    const forest: number[] = [];
    const sand: number[] = [];
    for (let i = 0; i < 3; i++) {
      const fx = 3 + i * 0.3;
      forest.push(spawnAgent(mini, fx, 3, { intelligence: 1 }));
      sand.push(spawnAgent(mini, fx, 20, { intelligence: 1 }));
      mini.world.terrain[mini.world.tileIndex(Math.floor(fx), 3)] = TerrainType.Forest;
      mini.world.terrain[mini.world.tileIndex(Math.floor(fx), 20)] = TerrainType.Sand;
    }
    for (const members of [forest, sand]) {
      for (const entity of members) {
        expect(mini.ecs.culturalMemory.countFor(entity)).toBe(0);
        setIntent(mini, entity, AgentIntent.Eat, -1);
      }
    }

    for (let tick = 0; tick < 20; tick++) {
      for (const members of [forest, sand]) {
        for (const entity of members) {
          const positionSlot = mini.ecs.position.index[entity];
          const tileX = Math.floor(mini.ecs.position.columns.x[positionSlot]);
          const tileY = Math.floor(mini.ecs.position.columns.y[positionSlot]);
          mini.world.food[mini.world.tileIndex(tileX, tileY)] = 1;
        }
      }
      const tickCtx = { ...ctx, tick };
      interactWithResources(tickCtx);
      updateCulture(tickCtx);
    }

    const techniqueOf = (entity: number) => mini.ecs.culturalMemory.bestOfType(entity, KnowledgeType.ForagingTechnique);
    const forestTechnique = techniqueOf(forest[0]);
    const sandTechnique = techniqueOf(sand[0]);
    expect(forestTechnique.variant).toBeGreaterThanOrEqual(0);
    expect(sandTechnique.variant).toBeGreaterThanOrEqual(0);
    // Each group's technique is the one its own terrain taught it.
    expect(forestTechnique.variant).toBe(techniqueVariantForTerrain(TerrainType.Forest));
    expect(sandTechnique.variant).toBe(techniqueVariantForTerrain(TerrainType.Sand));
    expect(forestTechnique.variant).not.toBe(sandTechnique.variant);

    // The two clusters have different traditions even though they were created
    // from identical agents in the same world — only the place differed.
    const forestSummary = summarizeCulture(mini.ecs.culturalMemory, mini.ecs.signals, forest, forest.length, config);
    const sandSummary = summarizeCulture(mini.ecs.culturalMemory, mini.ecs.signals, sand, sand.length, config);
    expect(forestSummary.traditions.length).toBeGreaterThan(0);
    expect(sandSummary.traditions.length).toBeGreaterThan(0);
    expect(culturalSimilarity(forestSummary, sandSummary, config)).toBeLessThan(1);
  });

  it('keeps similarity inside [0, 1] as contacts accumulate', () => {
    const { mini, a, b } = makeClusters(74);
    const config = cloneConfig(DEFAULT_SIMULATION_CONFIG);
    config.culture.transmission.teachChance = 1;
    const ctx = { ...mini.ctx, config, ecs: mini.ecs };
    learn(mini, a.members[0], KnowledgeType.FoodLocation, 4, 4, 0);
    learn(mini, b.members[0], KnowledgeType.WaterLocation, 42, 42, 0);

    // A series of contacts across the gap; the metric must stay a [0, 1] number
    // and never jump to "identical" from a single transfer.
    for (let i = 0; i < b.members.length; i++) {
      learn(mini, a.members[i % a.members.length], KnowledgeType.FoodLocation, 4 + i, 4, 0, 0.8);
      const learner = b.members[i];
      befriend(mini, learner, a.members[i % a.members.length]);
      const slot = mini.ecs.position.index[learner];
      mini.ecs.position.columns.x[slot] = 5;
      mini.ecs.position.columns.y[slot] = 5;
      setIntent(mini, a.members[i % a.members.length], AgentIntent.Teach, learner);
    }
    for (let tick = 0; tick < 10; tick++) updateCulture({ ...ctx, tick });

    const similarity = culturalSimilarity(summarizeCluster(mini, a), summarizeCluster(mini, b), mini.config);
    expect(similarity).toBeGreaterThanOrEqual(0);
    expect(similarity).toBeLessThanOrEqual(1);
  });
});
