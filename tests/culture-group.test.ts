/**
 * Phase 5 — group culture tests.
 *
 * A group has no culture of its own: every number here is derived on demand
 * from what its MEMBERS actually know. These tests pin that derivation:
 *   - carriers/items/strength/diversity/traditions/norms/signals,
 *   - bounded summary lists (never the whole knowledge space),
 *   - similarity in [0, 1], symmetric, 1 for identical cultures, 0 for disjoint,
 *   - the same agents produce the same summary (pure function of member state).
 */

import { describe, expect, it } from 'vitest';
import {
  KnowledgeOrigin,
  KnowledgeType,
  NormId,
  SignalMeaning,
  averagePairwiseSimilarity,
  culturalSimilarity,
  summarizeCulture,
} from '../src/simulation-core/culture';
import { cloneConfig, DEFAULT_SIMULATION_CONFIG } from '../src/simulation-core/simulation/config';
import { makeContext, spawnAgent, type MiniContext } from './helpers';

/** Set up a context plus a list of member entities (no relations needed). */
function members(count: number, seed = 61) {
  const mini = makeContext(seed, 24);
  const entities: number[] = [];
  for (let i = 0; i < count; i++) entities.push(spawnAgent(mini, 2 + (i % 8), 2 + Math.floor(i / 8)));
  return { mini, entities };
}

function learn(
  mini: MiniContext,
  entity: number,
  type: number,
  tileX: number,
  tileY: number,
  variantId: number,
  strength = 0.7,
  origin: number = KnowledgeOrigin.Discovered,
): void {
  mini.ecs.culturalMemory.learn(
    entity,
    { type, tileX, tileY, variantId, strength, origin, sourceEntity: -1 },
    0,
  );
}

function summarize(mini: MiniContext, entities: readonly number[]) {
  return summarizeCulture(mini.ecs.culturalMemory, mini.ecs.signals, entities, entities.length, mini.config);
}

describe('group culture summary', () => {
  it('reports carriers, items, strength, norms and signals from member knowledge', () => {
    const { mini, entities } = members(4);
    // One item held by all four, one held by two, one held by a single agent.
    for (const entity of entities) learn(mini, entity, KnowledgeType.FoodLocation, 5, 5, 0, 0.8);
    learn(mini, entities[0], KnowledgeType.WaterLocation, 9, 9, 0, 0.6);
    learn(mini, entities[1], KnowledgeType.WaterLocation, 9, 9, 0, 0.6);
    learn(mini, entities[2], KnowledgeType.ForagingTechnique, -1, -1, 1, 0.5);
    learn(mini, entities[0], KnowledgeType.SocialNorm, -1, -1, NormId.HelpOthers, 0.5);
    mini.ecs.signals.observe(entities[0], 4, SignalMeaning.Food, 0.8, 0);
    mini.ecs.signals.observe(entities[1], 4, SignalMeaning.Food, 0.9, 0);
    mini.ecs.signals.observe(entities[2], 4, SignalMeaning.Food, 0.7, 0);
    // Below the known threshold: a half-learned association is not a convention.
    mini.ecs.signals.observe(entities[3], 4, SignalMeaning.Food, 0.1, 0);

    const summary = summarize(mini, entities);

    expect(summary.agentCount).toBe(4);
    expect(summary.carriers).toBe(4);
    // 4 food + 2 water + 1 technique + 1 norm entries across the members.
    expect(summary.entries).toBe(8);
    // 4 distinct items: food @5,5, water @9,9, technique variant 1, HelpOthers.
    expect(summary.knowledgeItems).toBe(4);
    expect(summary.normCarriers).toBe(1);
    expect(summary.signalCarriers).toBe(3);
    expect(summary.averageStrength).toBeGreaterThan(0);
    // Most widespread item first.
    expect(summary.items[0].type).toBe(KnowledgeType.FoodLocation);
    expect(summary.items[0].carriers).toBe(4);
    expect(summary.items[0].share).toBe(1);
    // A tradition is an item held by at least `traditionShare` of the members.
    const foodShare = summary.items[0];
    expect(summary.traditions.some((t) => t.key === foodShare.key)).toBe(
      foodShare.share >= mini.config.culture.summary.traditionShare,
    );
    // The learned signal convention is reported with its meaning and share.
    expect(summary.signals).toHaveLength(1);
    expect(summary.signals[0].token).toBe(4);
    expect(summary.signals[0].meaning).toBe(SignalMeaning.Food);
    expect(summary.signals[0].carriers).toBe(3);
    expect(summary.signals[0].share).toBeCloseTo(0.75, 5);
    // Diversity falls to zero when everyone holds the same single item.
    const uniform = summarize(mini, [entities[3]]);
    expect(uniform.diversity).toBe(0);
    expect(summary.diversity).toBeGreaterThan(0);
  });

  it('returns an empty summary for an empty group and bounded lists for a rich one', () => {
    const { mini, entities } = members(3);
    const empty = summarize(mini, []);
    expect(empty.agentCount).toBe(0);
    expect(empty.carriers).toBe(0);
    expect(empty.knowledgeItems).toBe(0);
    expect(empty.items).toEqual([]);
    expect(empty.traditions).toEqual([]);
    expect(empty.signals).toEqual([]);
    expect(empty.diversity).toBe(0);

    // Every member learns many different items: the summary lists stay bounded.
    for (const entity of entities) {
      for (let i = 0; i < mini.config.culture.memory.capacity; i++) {
        learn(mini, entity, KnowledgeType.FoodLocation, i % 10, Math.floor(i / 10), 0, 0.5);
      }
    }
    const summary = summarize(mini, entities);
    expect(summary.knowledgeItems).toBeGreaterThan(mini.config.culture.summary.maxItems);
    expect(summary.items.length).toBeLessThanOrEqual(mini.config.culture.summary.maxItems);
    expect(summary.traditions.length).toBeLessThanOrEqual(mini.config.culture.summary.maxTraditions);
  });

  it('is a pure function of the members’ current knowledge', () => {
    const { mini, entities } = members(3);
    learn(mini, entities[0], KnowledgeType.FoodLocation, 3, 3, 0);
    learn(mini, entities[1], KnowledgeType.FoodLocation, 3, 3, 0);
    const first = summarize(mini, entities);
    const second = summarize(mini, entities);
    expect(second).toEqual(first);

    // Removing a member changes the summary because the member list changed —
    // nothing is cached per group.
    const smaller = summarize(mini, [entities[0]]);
    expect(smaller.agentCount).toBe(1);
    expect(smaller.carriers).toBe(1);
    expect(smaller.items[0].share).toBe(1);
  });
});

describe('cultural similarity between groups', () => {
  it('is bounded, symmetric and 1 for identical culture, 0 for disjoint', () => {
    const config = cloneConfig(DEFAULT_SIMULATION_CONFIG);
    const { mini, entities } = members(6);
    const groupA = [entities[0], entities[1], entities[2]];
    const groupB = [entities[3], entities[4], entities[5]];

    // Identical knowledge in both groups.
    for (const entity of entities) learn(mini, entity, KnowledgeType.FoodLocation, 7, 7, 0, 0.8);
    const summaryA = summarize(mini, groupA);
    const summaryB = summarize(mini, groupB);
    expect(culturalSimilarity(summaryA, summaryB, config)).toBeCloseTo(1, 5);

    // Disjoint knowledge (A knows (7,7), B knows (1,1) exclusively).
    const disjointMini = makeContext(62, 24);
    const a1 = spawnAgent(disjointMini, 2, 2);
    const a2 = spawnAgent(disjointMini, 3, 2);
    const b1 = spawnAgent(disjointMini, 4, 2);
    const b2 = spawnAgent(disjointMini, 5, 2);
    learn(disjointMini, a1, KnowledgeType.FoodLocation, 1, 1, 0, 0.8);
    learn(disjointMini, a2, KnowledgeType.FoodLocation, 1, 1, 0, 0.8);
    learn(disjointMini, b1, KnowledgeType.FoodLocation, 20, 20, 0, 0.8);
    learn(disjointMini, b2, KnowledgeType.FoodLocation, 20, 20, 0, 0.8);
    const disjointA = summarize(disjointMini, [a1, a2]);
    const disjointB = summarize(disjointMini, [b1, b2]);
    // Disjoint knowledge, and neither group uses a signal: the signal term has
    // nothing to judge, so the comparison is knowledge-only and scores 0.
    expect(culturalSimilarity(disjointA, disjointB, config)).toBeCloseTo(0, 5);
    expect(culturalSimilarity(disjointA, disjointB, config)).toBe(
      culturalSimilarity(disjointB, disjointA, config),
    );

    // Partial overlap lands strictly between the extremes.
    const partialMini = makeContext(63, 24);
    const c1 = spawnAgent(partialMini, 2, 2);
    const c2 = spawnAgent(partialMini, 3, 2);
    const d1 = spawnAgent(partialMini, 4, 2);
    const d2 = spawnAgent(partialMini, 5, 2);
    learn(partialMini, c1, KnowledgeType.FoodLocation, 4, 4, 0, 0.8);
    learn(partialMini, c2, KnowledgeType.FoodLocation, 4, 4, 0, 0.8);
    learn(partialMini, c2, KnowledgeType.WaterLocation, 12, 12, 0, 0.8);
    learn(partialMini, d1, KnowledgeType.FoodLocation, 4, 4, 0, 0.8);
    learn(partialMini, d2, KnowledgeType.FoodLocation, 4, 4, 0, 0.8);
    learn(partialMini, d2, KnowledgeType.WaterLocation, 30, 30, 0, 0.8);
    const partial = culturalSimilarity(summarize(partialMini, [c1, c2]), summarize(partialMini, [d1, d2]), config);
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThanOrEqual(1);

    // A group that knows nothing shares nothing, whether or not the other side
    // has items or signals of its own.
    const empty = summarize(disjointMini, []);
    expect(culturalSimilarity(disjointA, empty, config)).toBe(0);
    mini.ecs.signals.observe(a1, 3, SignalMeaning.Food, 0.9, 0);
    const withSignal = summarize(disjointMini, [a1, a2]);
    expect(culturalSimilarity(withSignal, empty, config)).toBe(0);
    expect(culturalSimilarity(empty, empty, config)).toBe(0);
  });

  it('drops when the two groups use different tokens for the same meaning', () => {
    const config = cloneConfig(DEFAULT_SIMULATION_CONFIG);
    const mini = makeContext(64, 24);
    const groupA: number[] = [];
    const groupB: number[] = [];
    for (let i = 0; i < 3; i++) groupA.push(spawnAgent(mini, 2 + i, 2));
    for (let i = 0; i < 3; i++) groupB.push(spawnAgent(mini, 2 + i, 4));
    // Same knowledge in both groups, so only the signal term can differ.
    for (const entity of [...groupA, ...groupB]) learn(mini, entity, KnowledgeType.FoodLocation, 6, 6, 0, 0.8);
    for (const entity of groupA) mini.ecs.signals.observe(entity, 2, SignalMeaning.Food, 0.8, 0);
    for (const entity of groupB) mini.ecs.signals.observe(entity, 2, SignalMeaning.Food, 0.8, 0);
    const agreeing = culturalSimilarity(summarize(mini, groupA), summarize(mini, groupB), config);

    // Group B switches to a different token for the same meaning.
    for (const entity of groupB) mini.ecs.signals.removeAll(entity);
    for (const entity of groupB) mini.ecs.signals.observe(entity, 11, SignalMeaning.Food, 0.8, 0);
    const disagreeing = culturalSimilarity(summarize(mini, groupA), summarize(mini, groupB), config);

    expect(agreeing).toBeCloseTo(1, 5);
    expect(disagreeing).toBeLessThan(agreeing);
    expect(disagreeing).toBeGreaterThanOrEqual(0);
  });

  it('averages pairwise similarity with a bounded number of comparisons', () => {
    const config = cloneConfig(DEFAULT_SIMULATION_CONFIG);
    const mini = makeContext(65, 24);
    const summary = summarize(mini, []);
    // One summary (or none) has no pairs: the convention is 1 (nothing to
    // disagree about), never NaN.
    expect(averagePairwiseSimilarity([summary], config)).toBe(1);
    expect(averagePairwiseSimilarity([], config)).toBe(1);

    const summaries = [];
    for (let i = 0; i < config.culture.summary.maxSimilarityGroups + 4; i++) {
      const entity = spawnAgent(mini, 2 + (i % 8), 2 + Math.floor(i / 8));
      learn(mini, entity, KnowledgeType.FoodLocation, i, 1, 0, 0.8);
      summaries.push(summarize(mini, [entity]));
    }
    const average = averagePairwiseSimilarity(summaries, config);
    expect(average).toBeGreaterThanOrEqual(0);
    expect(average).toBeLessThanOrEqual(1);
  });
});
