/**
 * Phase 4 — social targeting / confront utility tests.
 *
 * findSocialTargets is the bounded one-walk social perception pass. These
 * tests drive it directly with controlled agents and relationships to verify
 * the confront/avoid/socialize targeting rules:
 *
 *   - confront requires real hostility (gate), competition, adulthood and a
 *     strength edge; kinship dampens it; no single factor makes it dominate,
 *   - avoid (threat) grows with proximity, hostility and distrust,
 *   - hostile agents are not attractive socialize/cooperate targets.
 */

import { describe, expect, it } from 'vitest';
import { makeContext, spawnAgent, type MiniContext } from './helpers';
import { findSocialTargets, socialTargets } from '../src/simulation-core/ai/social-targeting';
import { selectIntents } from '../src/simulation-core/ai/utility-ai';
import { AgentIntent } from '../src/simulation-core/ai/intents';
import type { EntityId } from '../src/simulation-core/ecs';

/** Run findSocialTargets for `self` against one rival with the given case. */
function runCase(
  mini: MiniContext,
  self: EntityId,
  rival: EntityId,
  score: number,
  hungerUrgency: number,
  selfStrength: number,
  selfSocialTendency: number,
  isAdult: boolean,
  trust = 0,
): void {
  const rel = mini.ecs.relationships;
  const { entry } = rel.getOrCreate(self, rival, 1, false);
  rel.setScore(entry, score);
  rel.setTrust(entry, trust);
  rel.setFamiliarity(entry, 0.5);

  const selfSlot = mini.ecs.position.index[self];
  mini.ctx.socialIndex.rebuild(mini.ecs);
  findSocialTargets(
    self,
    mini.ecs.position.columns.x[selfSlot],
    mini.ecs.position.columns.y[selfSlot],
    hungerUrgency,
    selfStrength,
    selfSocialTendency,
    isAdult,
    mini.ecs,
    mini.config,
    mini.ctx.socialIndex,
    100,
  );
}

describe('confront targeting', () => {
  it('requires real hostility: neutral or mildly annoyed agents are never targets', () => {
    const mini = makeContext(21);
    const a = spawnAgent(mini, 10, 10, { strength: 0.9, socialTendency: 0.1 });
    const b = spawnAgent(mini, 10.5, 10, { strength: 0.2 });

    runCase(mini, a, b, 0.3, 0.95, 0.9, 0.1, true); // friendly + starving
    expect(socialTargets.confrontId).toBe(-1);
    expect(socialTargets.confrontScore).toBe(0);

    runCase(mini, a, b, -0.05, 0.95, 0.9, 0.1, true); // annoyed, above the gate
    expect(socialTargets.confrontId).toBe(-1);
  });

  it('high hostility + competition + strength edge -> a meaningful confront score', () => {
    const mini = makeContext(21);
    const a = spawnAgent(mini, 10, 10, { strength: 0.9, socialTendency: 0.1 });
    const b = spawnAgent(mini, 10.5, 10, { strength: 0.2 });

    runCase(mini, a, b, -0.6, 0.95, 0.9, 0.1, true);
    expect(socialTargets.confrontId).toBe(b);
    expect(socialTargets.confrontScore).toBeGreaterThan(0.15); // can beat Rest/Wander
  });

  it('competition matters: a full stomach defuses confrontation', () => {
    const mini = makeContext(21);
    const a = spawnAgent(mini, 10, 10, { strength: 0.9, socialTendency: 0.1 });
    const b = spawnAgent(mini, 10.5, 10, { strength: 0.2 });

    runCase(mini, a, b, -0.6, 0.95, 0.9, 0.1, true);
    const hungry = socialTargets.confrontScore;

    runCase(mini, a, b, -0.6, 0.1, 0.9, 0.1, true); // same grudge, no hunger
    expect(socialTargets.confrontId).toBe(b); // still the target...
    expect(socialTargets.confrontScore).toBeLessThan(hungry); // ...but much weaker
    // Roughly parity with idling: no confident aggression without a stake.
    expect(socialTargets.confrontScore).toBeLessThan(0.25);
  });

  it('an unfavorable strength matchup reduces confront utility', () => {
    const mini = makeContext(21);
    const strong = spawnAgent(mini, 10, 10, { strength: 0.95, socialTendency: 0.1 });
    const weak = spawnAgent(mini, 10.5, 10, { strength: 0.1 });
    const average = spawnAgent(mini, 11, 11, { strength: 0.5 });

    // Weak agent facing a strong rival vs facing an even rival.
    runCase(mini, weak, strong, -0.6, 0.95, 0.1, 0.1, true);
    const versusStronger = socialTargets.confrontScore;
    runCase(mini, weak, average, -0.6, 0.95, 0.1, 0.1, true);
    const versusEven = socialTargets.confrontScore;
    expect(versusStronger).toBeLessThan(versusEven);

    // The strong agent has the appetite the weak one lacks.
    runCase(mini, strong, weak, -0.6, 0.95, 0.95, 0.1, true);
    expect(socialTargets.confrontScore).toBeGreaterThan(versusStronger);
  });

  it('juveniles never confront, regardless of hostility', () => {
    const mini = makeContext(21);
    const juvenile = spawnAgent(mini, 10, 10, { strength: 0.9, socialTendency: 0.1 });
    const rival = spawnAgent(mini, 10.5, 10, { strength: 0.2 });
    runCase(mini, juvenile, rival, -0.6, 0.95, 0.9, 0.1, false);
    expect(socialTargets.confrontId).toBe(-1);
  });

  it('kinship heavily dampens confrontation between relatives', () => {
    const kinCase = makeContext(22);
    const parent = spawnAgent(kinCase, 10, 10, { strength: 0.9, socialTendency: 0.1 });
    const child = spawnAgent(kinCase, 10.5, 10, { strength: 0.2, parentA: parent });
    runCase(kinCase, parent, child, -0.6, 0.95, 0.9, 0.1, true);
    const kinScore = socialTargets.confrontScore;

    const strangerCase = makeContext(23);
    const a = spawnAgent(strangerCase, 10, 10, { strength: 0.9, socialTendency: 0.1 });
    const b = spawnAgent(strangerCase, 10.5, 10, { strength: 0.2 });
    runCase(strangerCase, a, b, -0.6, 0.95, 0.9, 0.1, true);
    const strangerScore = socialTargets.confrontScore;

    expect(kinScore).toBeLessThan(strangerScore);
    expect(kinScore).toBeGreaterThan(0); // dampened, not magically immune
  });

  it('socialTendency alone does not create confront targets', () => {
    // Low social tendency raises aggression, but without hostility there is
    // nothing to confront: no "loners attack everyone" rule.
    const mini = makeContext(21);
    const loner = spawnAgent(mini, 10, 10, { strength: 0.9, socialTendency: 0 });
    const stranger = spawnAgent(mini, 10.5, 10, { strength: 0.2 });
    runCase(mini, loner, stranger, 0, 0.95, 0.9, 0, true);
    expect(socialTargets.confrontId).toBe(-1);
    expect(socialTargets.confrontScore).toBe(0);
  });
});

describe('avoid (threat) targeting', () => {
  it('a feared, distrusted rival nearby produces a real avoid score', () => {
    const mini = makeContext(25);
    const weakling = spawnAgent(mini, 10, 10, { strength: 0.1 });
    const bully = spawnAgent(mini, 10.5, 10, { strength: 0.9 });
    runCase(mini, weakling, bully, -0.5, 0.5, 0.1, 0.5, true, 0);
    expect(socialTargets.threatId).toBe(bully);
    expect(socialTargets.avoidScore).toBeGreaterThan(0.1);
  });

  it('trusted company is not threatening', () => {
    const mini = makeContext(25);
    const a = spawnAgent(mini, 10, 10, { strength: 0.1 });
    const friend = spawnAgent(mini, 10.5, 10, { strength: 0.9 });
    runCase(mini, a, friend, 0.7, 0.5, 0.1, 0.5, true, 0.8);
    expect(socialTargets.threatId).toBe(-1);
    expect(socialTargets.avoidScore).toBe(0);
  });
});

describe('hostility blocks positive social targeting', () => {
  it('a deeply hostile agent is not an attractive socialize or cooperate target', () => {
    const mini = makeContext(27);
    const a = spawnAgent(mini, 10, 10, { socialTendency: 0.9 });
    const enemy = spawnAgent(mini, 10.5, 10, { socialTendency: 0.9 });

    // Friendly first: the enemy is a valid socialize target while neutral.
    runCase(mini, a, enemy, 0, 0.3, 0.5, 0.9, true);
    const neutralSocialize = socialTargets.socializeScore;

    // After a deep grudge, no amount of loneliness makes the enemy attractive.
    runCase(mini, a, enemy, -0.5, 0.3, 0.5, 0.9, true);
    expect(socialTargets.socializeId).toBe(-1);
    expect(socialTargets.socializeScore).toBe(0);
    expect(socialTargets.cooperateId).toBe(-1);
    expect(socialTargets.socializeScore).toBeLessThan(neutralSocialize);
  });

  it('a mild grudge merely cools the relationship, it does not freeze it', () => {
    const mini = makeContext(27);
    const a = spawnAgent(mini, 10, 10, { socialTendency: 0.9 });
    const acquaintance = spawnAgent(mini, 10.5, 10, { socialTendency: 0.9 });
    runCase(mini, a, acquaintance, -0.1, 0.3, 0.5, 0.9, true);
    // -0.1 is above the -0.25 affinity collapse: still socializable,
    // just less attractive than a friend.
    expect(socialTargets.socializeId).toBe(acquaintance);
    expect(socialTargets.socializeScore).toBeGreaterThan(0);
    expect(socialTargets.socializeScore).toBeLessThan(0.4);
  });
});

describe('utility AI integration (selected intents reflect hostility)', () => {
  it('a well-fed, comfortable agent with a deep grudge and an edge may confront', () => {
    // Drive the full selectIntents on a hand-built context: a starving,
    // hostile adult with a strength edge next to a well-fed rival -> the
    // contested scrap is worth fighting for.
    const mini = makeContext(29, 24);
    const strong = spawnAgent(mini, 12, 12, {
      strength: 0.95,
      socialTendency: 0.05,
      hunger: 92,
      ageHours: 72, // adults only confront
      intent: AgentIntent.Rest,
    });
    const rival = spawnAgent(mini, 12.5, 12, { strength: 0.1, hunger: 40, ageHours: 72 });
    const rel = mini.ecs.relationships;
    const out = rel.getOrCreate(strong, rival, 1, false).entry;
    rel.setScore(out, -0.5);
    rel.setFamiliarity(out, 0.5);

    // No food or water anywhere: the only thing on this agent's mind is the
    // rival standing on the empty scrap it still remembers.
    mini.world.food.fill(0);
    mini.world.water.fill(0);

    mini.ctx.tick = 5;
    selectIntents(mini.ctx);
    const intentSlot = mini.ecs.intent.index[strong];
    expect(mini.ecs.intent.columns.kind[intentSlot]).toBe(AgentIntent.Confront);
    expect(mini.ecs.intent.columns.targetEntity[intentSlot]).toBe(rival);
  });
});
