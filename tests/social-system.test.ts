/**
 * Phase 4 — social interaction system tests.
 *
 * Each social intent (Socialize / Help / Cooperate / Confront) is exercised
 * in a controlled, deterministic scenario: two agents, fixed positions, a
 * hand-set intent. Assertions are structural (state moved in the documented
 * direction, bounded) — never exact whole-run outcomes.
 */

import { describe, expect, it } from 'vitest';
import { makeContext, spawnAgent, type MiniContext } from './helpers';
import { updateSocialInteractions } from '../src/simulation-core/simulation/systems/social-system';
import { interactWithResources } from '../src/simulation-core/simulation/systems/resource-system';
import { seedKinRelationships, kinshipBetween, KinshipType } from '../src/simulation-core/social';
import { AgentIntent } from '../src/simulation-core/ai/intents';
import type { EntityId } from '../src/simulation-core/ecs';

/** Run one social-interaction tick with the given intent for `self`. */
function socialize(mini: MiniContext, self: EntityId, target: EntityId, kind: number): void {
  const intentSlot = mini.ecs.intent.index[self];
  mini.ecs.intent.columns.kind[intentSlot] = kind;
  mini.ecs.intent.columns.targetEntity[intentSlot] = target;
  mini.ctx.tick++;
  updateSocialInteractions(mini.ctx);
}

function eventsOf(mini: MiniContext, type: string): number {
  return mini.events.recent(500).filter((e) => e.type === type).length;
}

describe('relationship store', () => {
  it('creates directed entries on demand and clamps all bounded values', () => {
    const mini = makeContext(3);
    const a = spawnAgent(mini, 5, 5);
    const b = spawnAgent(mini, 6, 6);
    const rel = mini.ecs.relationships;
    expect(rel.find(a, b)).toBe(-1);
    const { entry } = rel.getOrCreate(a, b, 10, false);
    expect(rel.find(a, b)).toBe(entry);
    expect(rel.find(b, a)).toBe(-1); // directed, not symmetric storage
    rel.setScore(entry, 5);
    expect(rel.scoreOf(entry)).toBe(1); // clamped to [−1, 1]
    rel.setScore(entry, -5);
    expect(rel.scoreOf(entry)).toBe(-1);
    rel.setTrust(entry, 9);
    expect(rel.trustOf(entry)).toBeLessThanOrEqual(1);
    rel.setFamiliarity(entry, 9);
    expect(rel.familiarityOf(entry)).toBeLessThanOrEqual(1);
  });

  it('enforces the per-agent capacity bound by evicting the least valuable entry', () => {
    const mini = makeContext(3);
    const capacity = mini.config.social.memory.capacity;
    const a = spawnAgent(mini, 5, 5);
    const rel = mini.ecs.relationships;
    const others: EntityId[] = [];
    for (let i = 0; i < capacity + 4; i++) {
      const other = spawnAgent(mini, 10 + (i % 5), 10 + (i % 5));
      others.push(other);
      const { entry } = rel.getOrCreate(a, other, i, false);
      // First few get strong bonds; later ones stay weak.
      if (i < 3) {
        rel.setScore(entry, 0.8);
        rel.setFamiliarity(entry, 0.9);
      }
    }
    expect(rel.countFor(a)).toBe(capacity); // never above the bound
    // The strong early bonds survived the churn; the newest entry is present;
    // and at least one of the earlier weak ones was evicted to make room.
    expect(rel.scoreOf(rel.find(a, others[0]))).toBeCloseTo(0.8);
    expect(rel.find(a, others[capacity + 3])).not.toBe(-1); // newest survives
    const remembered = new Set<number>();
    for (let e = rel.headOf(a); e !== -1; e = rel.nextOf(e)) remembered.add(rel.targetOf(e));
    const evictedWeak = others.slice(3, capacity).filter((o) => !remembered.has(o));
    expect(evictedWeak.length).toBeGreaterThan(0);
  });

  it('serializes and restores the full store (round trip equals original)', () => {
    const mini = makeContext(3);
    const a = spawnAgent(mini, 5, 5);
    const b = spawnAgent(mini, 6, 6);
    const rel = mini.ecs.relationships;
    const ab = rel.getOrCreate(a, b, 7, false).entry;
    rel.setScore(ab, 0.42);
    rel.setTrust(ab, 0.3);
    rel.setFamiliarity(ab, 0.7);
    rel.incrementPositive(ab);
    rel.setResentUntil(ab, 1234);
    const saved = rel.serialize();

    const mini2 = makeContext(4);
    const a2 = spawnAgent(mini2, 5, 5);
    const b2 = spawnAgent(mini2, 6, 6);
    mini2.ecs.relationships.restore(saved);
    const entry = mini2.ecs.relationships.find(a2, b2);
    expect(entry).not.toBe(-1);
    expect(mini2.ecs.relationships.scoreOf(entry)).toBeCloseTo(0.42);
    expect(mini2.ecs.relationships.trustOf(entry)).toBeCloseTo(0.3);
    expect(mini2.ecs.relationships.resentUntilOf(entry)).toBe(1234);
    expect(mini2.ecs.relationships.serialize()).toEqual(saved);
  });
});

describe('kinship', () => {
  it('recognizes parent/child and sibling pairs from lineage, not friendship', () => {
    const mini = makeContext(5);
    const parentA = spawnAgent(mini, 5, 5);
    const parentB = spawnAgent(mini, 6, 5);
    const child = spawnAgent(mini, 5.5, 5.5, { parentA, parentB });
    const stranger = spawnAgent(mini, 20, 20);
    const ecs = mini.ecs;
    expect(kinshipBetween(parentA, child, ecs)).toBe(KinshipType.ParentChild);
    expect(kinshipBetween(child, parentA, ecs)).toBe(KinshipType.ParentChild);
    expect(kinshipBetween(parentB, child, ecs)).toBe(KinshipType.ParentChild);
    expect(kinshipBetween(parentA, stranger, ecs)).toBe(KinshipType.None);

    const sibling = spawnAgent(mini, 6, 6, { parentA, parentB });
    expect(kinshipBetween(child, sibling, ecs)).toBe(KinshipType.Sibling);
    expect(kinshipBetween(parentA, parentB, ecs)).toBe(KinshipType.None); // mates are not kin
  });

  it('seeds parent/child relationships with a bond bias (not hardcoded friendship)', () => {
    const mini = makeContext(5);
    const parentA = spawnAgent(mini, 5, 5);
    const parentB = spawnAgent(mini, 6, 5);
    const child = spawnAgent(mini, 5.5, 5.5, { parentA, parentB });
    const kin = mini.config.social.kinship;
    seedKinRelationships(mini.ecs, child, parentA, parentB, kin.baseScore, kin.baseTrust, kin.baseFamiliarity, 10);

    const rel = mini.ecs.relationships;
    const childToParent = rel.find(child, parentA);
    expect(childToParent).not.toBe(-1);
    // A bias, not a maximum: seeded positive but well below bonded friends.
    expect(rel.scoreOf(childToParent)).toBeGreaterThan(0);
    expect(rel.scoreOf(childToParent)).toBeLessThan(1);
    expect(rel.trustOf(childToParent)).toBeGreaterThan(0);
    expect(rel.kinOf(childToParent)).toBe(true);
    // Both parents are seeded, both directions.
    expect(rel.find(child, parentB)).not.toBe(-1);
    expect(rel.find(parentA, child)).not.toBe(-1);
    expect(rel.find(parentB, child)).not.toBe(-1);
  });
});

describe('socialize intent', () => {
  it('forms a mutual relationship and relieves loneliness when in reach', () => {
    const mini = makeContext(7);
    const a = spawnAgent(mini, 10, 10, { loneliness: 80 });
    const b = spawnAgent(mini, 10.5, 10, { loneliness: 80 });
    socialize(mini, a, b, AgentIntent.Socialize);

    const rel = mini.ecs.relationships;
    const ab = rel.find(a, b);
    const ba = rel.find(b, a);
    expect(ab).not.toBe(-1);
    expect(ba).not.toBe(-1);
    expect(rel.scoreOf(ab)).toBeGreaterThan(0);
    expect(rel.scoreOf(ba)).toBeGreaterThan(0);
    expect(rel.positiveCountOf(ab)).toBe(1);

    // First contact fired the social_interaction event and the counter.
    expect(eventsOf(mini, 'social_interaction')).toBe(1);
    expect(mini.ctx.socialStats.socialInteractionEvents).toBe(1);

    // Loneliness dropped for both — more for the initiator.
    const aSocial = mini.ecs.social.index[a];
    const bSocial = mini.ecs.social.index[b];
    const aDrop = 80 - mini.ecs.social.columns.loneliness[aSocial];
    const bDrop = 80 - mini.ecs.social.columns.loneliness[bSocial];
    expect(aDrop).toBeGreaterThan(0);
    expect(bDrop).toBeGreaterThan(0);
    expect(aDrop).toBeGreaterThanOrEqual(bDrop);
  });

  it('does nothing when the target is out of interaction reach', () => {
    const mini = makeContext(7);
    const a = spawnAgent(mini, 10, 10, { loneliness: 80 });
    const b = spawnAgent(mini, 20, 20);
    socialize(mini, a, b, AgentIntent.Socialize);
    expect(mini.ecs.relationships.find(a, b)).toBe(-1);
    expect(eventsOf(mini, 'social_interaction')).toBe(0);
    const aSocial = mini.ecs.social.index[a];
    expect(mini.ecs.social.columns.loneliness[aSocial]).toBe(80);
  });

  it('close co-presence alone builds familiarity without any interaction', () => {
    const mini = makeContext(7);
    const a = spawnAgent(mini, 10, 10);
    const b = spawnAgent(mini, 10.5, 10);
    const rel = mini.ecs.relationships;
    const ab = rel.getOrCreate(a, b, 1, false).entry;
    rel.setFamiliarity(ab, 0);
    const far = spawnAgent(mini, 11, 10);
    const af = rel.getOrCreate(a, far, 1, false).entry;
    rel.setFamiliarity(af, 0);
    mini.ecs.position.columns.x[mini.ecs.position.index[far]] = 20; // move far away
    mini.ecs.position.columns.y[mini.ecs.position.index[far]] = 20;

    mini.ctx.tick++;
    updateSocialInteractions(mini.ctx);
    expect(rel.familiarityOf(ab)).toBeGreaterThan(0);
    expect(rel.familiarityOf(af)).toBe(0);
  });
});

describe('help intent (reciprocity core)', () => {
  it('transfers energy cost to the helper and health/energy to the needy target', () => {
    const mini = makeContext(9);
    const helper = spawnAgent(mini, 10, 10, { energy: 90, health: 90 });
    const needy = spawnAgent(mini, 10.5, 10, { energy: 20, health: 40 });
    const helperEnergyBefore = 90;
    socialize(mini, helper, needy, AgentIntent.Help);

    const needyHealthSlot = mini.ecs.health.index[needy];
    const needyNeedsSlot = mini.ecs.needs.index[needy];
    const helperNeedsSlot = mini.ecs.needs.index[helper];
    expect(mini.ecs.health.columns.current[needyHealthSlot]).toBeGreaterThan(40);
    expect(mini.ecs.needs.columns.energy[needyNeedsSlot]).toBeGreaterThan(20);
    expect(mini.ecs.needs.columns.energy[helperNeedsSlot]).toBeLessThan(helperEnergyBefore); // real cost

    expect(eventsOf(mini, 'helped_agent')).toBe(1);
    expect(mini.ctx.socialStats.helpEvents).toBe(1);

    // Reciprocity: the helped agent's regard/trust grows faster than the
    // helper's own view of the relationship.
    const rel = mini.ecs.relationships;
    const helpedView = rel.find(needy, helper); // needy -> helper
    const helperView = rel.find(helper, needy);
    expect(rel.trustOf(helpedView)).toBeGreaterThan(rel.trustOf(helperView));
    expect(rel.scoreOf(helpedView)).toBeGreaterThan(rel.scoreOf(helperView));
  });

  it('is a wasted trip when the target is comfortable (opportunity cost)', () => {
    const mini = makeContext(9);
    const helper = spawnAgent(mini, 10, 10, { energy: 90 });
    const comfy = spawnAgent(mini, 10.5, 10, { energy: 90, health: 90 });
    socialize(mini, helper, comfy, AgentIntent.Help);
    const helperNeedsSlot = mini.ecs.needs.index[helper];
    expect(mini.ecs.needs.columns.energy[helperNeedsSlot]).toBe(90); // no cost
    expect(eventsOf(mini, 'helped_agent')).toBe(0);
    expect(mini.ecs.relationships.find(helper, comfy)).toBe(-1);
  });
});

describe('cooperation intent', () => {
  it('progresses a session per tick and completes it with bonds + forage bonus', () => {
    const mini = makeContext(11);
    const a = spawnAgent(mini, 10, 10, { energy: 100 });
    const b = spawnAgent(mini, 10.5, 10, { energy: 100 });
    const cooperation = mini.config.social.cooperation;
    for (let t = 0; t < cooperation.durationTicks; t++) {
      socialize(mini, a, b, AgentIntent.Cooperate);
    }

    expect(eventsOf(mini, 'cooperation_started')).toBe(1);
    expect(eventsOf(mini, 'cooperation_completed')).toBe(1);
    expect(mini.ctx.socialStats.cooperationEvents).toBe(1);

    const rel = mini.ecs.relationships;
    const ab = rel.find(a, b);
    expect(ab).not.toBe(-1);
    expect(rel.scoreOf(ab)).toBeGreaterThanOrEqual(cooperation.scoreGain - 1e-6);
    expect(rel.trustOf(ab)).toBeGreaterThan(0);

    // Foraging efficiency granted to both (more to the initiator).
    const aSocial = mini.ecs.social.index[a];
    const bSocial = mini.ecs.social.index[b];
    expect(mini.ecs.social.columns.forageBonusTicks[aSocial]).toBeGreaterThanOrEqual(
      cooperation.partnerForageBonusTicks,
    );
    expect(mini.ecs.social.columns.forageBonusTicks[bSocial]).toBeGreaterThanOrEqual(
      cooperation.partnerForageBonusTicks,
    );

    // Session cleared; the pair is on cooldown (no immediate re-session).
    expect(mini.ecs.social.columns.cooperationTarget[aSocial]).toBe(-1);
    expect(rel.pairCooldownUntilOf(ab)).toBeGreaterThan(mini.ctx.tick);
  });

  it('charges a per-tick energy cost while the session runs', () => {
    const mini = makeContext(11);
    const a = spawnAgent(mini, 10, 10, { energy: 100 });
    const b = spawnAgent(mini, 10.5, 10, { energy: 100 });
    const before = mini.ecs.needs.columns.energy[mini.ecs.needs.index[a]];
    socialize(mini, a, b, AgentIntent.Cooperate);
    const after = mini.ecs.needs.columns.energy[mini.ecs.needs.index[a]];
    // Float32 storage tolerates a small epsilon on the per-tick cost.
    expect(before - after).toBeGreaterThanOrEqual(mini.config.social.cooperation.energyCostPerTick - 0.01);
    expect(after).toBeLessThan(before);
  });

  it('clears an abandoned session when the partner is gone', () => {
    const mini = makeContext(11);
    const a = spawnAgent(mini, 10, 10);
    const b = spawnAgent(mini, 10.5, 10);
    socialize(mini, a, b, AgentIntent.Cooperate);
    const aSocial = mini.ecs.social.index[a];
    expect(mini.ecs.social.columns.cooperationTarget[aSocial]).toBe(b);

    mini.ecs.intent.columns.targetEntity[mini.ecs.intent.index[a]] = -1; // partner lost
    mini.ctx.tick++;
    updateSocialInteractions(mini.ctx);
    expect(mini.ecs.social.columns.cooperationTarget[aSocial]).toBe(-1);
    expect(mini.ecs.social.columns.cooperationTicks[aSocial]).toBe(0);
  });
});

describe('confront intent (conflict)', () => {
  it('resolves by strength: loser hurt more, knocked back, pair on cooldown', () => {
    const mini = makeContext(13);
    const strong = spawnAgent(mini, 10, 10, { strength: 0.9, health: 80 });
    const weak = spawnAgent(mini, 10.5, 10, { strength: 0.2, health: 80 });
    const rel = mini.ecs.relationships;
    // Both directions must exist (no history -> no fight).
    const out = rel.getOrCreate(strong, weak, 1, false).entry;
    const inc = rel.getOrCreate(weak, strong, 1, false).entry;
    rel.setScore(out, -0.5);
    rel.setScore(inc, -0.5);

    const weakXBefore = mini.ecs.position.columns.x[mini.ecs.position.index[weak]];
    socialize(mini, weak, strong, AgentIntent.Confront); // the weak one starts it — strength decides

    const strongHealth = mini.ecs.health.columns.current[mini.ecs.health.index[strong]];
    const weakHealth = mini.ecs.health.columns.current[mini.ecs.health.index[weak]];
    const conflict = mini.config.social.conflict;
    expect(strongHealth).toBeCloseTo(80 - conflict.damageToWinner);
    expect(weakHealth).toBeCloseTo(80 - conflict.damage);

    // Knockback pushed the loser AWAY from the winner (winner at x=10,
    // loser at x=10.5 -> pushed to larger x).
    const weakXAfter = mini.ecs.position.columns.x[mini.ecs.position.index[weak]];
    expect(weakXAfter).toBeGreaterThan(weakXBefore);

    // Both directions sour; the event + counter fired; cooldown is active.
    expect(rel.scoreOf(out)).toBeLessThan(-0.5);
    expect(rel.scoreOf(inc)).toBeLessThan(-0.5);
    expect(eventsOf(mini, 'conflict')).toBe(1);
    expect(mini.ctx.socialStats.conflictEvents).toBe(1);
    expect(rel.pairCooldownUntilOf(out)).toBeGreaterThan(mini.ctx.tick);

    // De-escalation: a second confrontation inside the cooldown does nothing.
    const strongHealthAfterFirst = strongHealth;
    socialize(mini, weak, strong, AgentIntent.Confront);
    expect(mini.ecs.health.columns.current[mini.ecs.health.index[strong]]).toBe(strongHealthAfterFirst);
    expect(eventsOf(mini, 'conflict')).toBe(1);
  });

  it('never starts without prior relationship history', () => {
    const mini = makeContext(13);
    const a = spawnAgent(mini, 10, 10, { health: 80 });
    const b = spawnAgent(mini, 10.5, 10, { health: 80 });
    socialize(mini, a, b, AgentIntent.Confront);
    expect(eventsOf(mini, 'conflict')).toBe(0);
    expect(mini.ecs.health.columns.current[mini.ecs.health.index[a]]).toBe(80);
  });
});

describe('competition resentment (the seed of conflict)', () => {
  it('a failed forager blames a nearby competitor, not kin or absent agents', () => {
    const mini = makeContext(15);
    const a = spawnAgent(mini, 10.1, 10, { intent: AgentIntent.Eat });
    const competitor = spawnAgent(mini, 11, 10, { intent: AgentIntent.Rest });
    const far = spawnAgent(mini, 20, 20, { intent: AgentIntent.Rest });
    const idx = mini.world.tileIndex(10, 10);
    mini.world.food[idx] = 0; // stripped patch under A
    mini.ctx.socialIndex.rebuild(mini.ecs);

    interactWithResources(mini.ctx);

    const rel = mini.ecs.relationships;
    const towardCompetitor = rel.find(a, competitor);
    const towardFar = rel.find(a, far);
    expect(towardCompetitor).not.toBe(-1);
    expect(rel.scoreOf(towardCompetitor)).toBeLessThan(0);
    expect(towardFar).toBe(-1);
  });

  it('kin are blamed far more mildly than strangers', () => {
    const mini = makeContext(15);
    const parent = spawnAgent(mini, 12, 12);
    const child = spawnAgent(mini, 10.1, 10, { intent: AgentIntent.Eat, parentA: parent });
    const strangerCase = makeContext(16);
    const stranger = spawnAgent(strangerCase, 12, 12);
    const failed = spawnAgent(strangerCase, 10.1, 10, { intent: AgentIntent.Eat });

    for (const m of [mini, strangerCase] as Array<MiniContext>) {
      const idx = m.world.tileIndex(10, 10);
      m.world.food[idx] = 0;
      m.ctx.socialIndex.rebuild(m.ecs);
      interactWithResources(m.ctx);
    }

    const kinScore = mini.ecs.relationships.scoreOf(mini.ecs.relationships.find(child, parent));
    const strangerScore = strangerCase.ecs.relationships.scoreOf(
      strangerCase.ecs.relationships.find(failed, stranger),
    );
    expect(kinScore).toBeGreaterThan(strangerScore); // dampened, not immune
    expect(kinScore).toBeLessThan(0);
  });

  it('resentment is rate-limited per pair (no spiral from one contested patch)', () => {
    const mini = makeContext(15);
    const a = spawnAgent(mini, 10.1, 10, { intent: AgentIntent.Eat });
    const b = spawnAgent(mini, 11, 10, { intent: AgentIntent.Rest });
    const idx = mini.world.tileIndex(10, 10);
    mini.world.food[idx] = 0;
    mini.ctx.socialIndex.rebuild(mini.ecs);

    interactWithResources(mini.ctx);
    const afterFirst = mini.ecs.relationships.scoreOf(mini.ecs.relationships.find(a, b));

    mini.world.food[idx] = 0; // still empty next tick
    mini.ctx.tick++;
    mini.ctx.socialIndex.rebuild(mini.ecs);
    interactWithResources(mini.ctx);
    const afterSecond = mini.ecs.relationships.scoreOf(mini.ecs.relationships.find(a, b));

    expect(afterFirst).toBeLessThan(0);
    expect(afterSecond).toBeCloseTo(afterFirst); // within the cooldown window
  });

  it('hostile attribution: a repeat contest blames the same agent, deepening the grudge', () => {
    const mini = makeContext(17);
    const a = spawnAgent(mini, 10.1, 10, { intent: AgentIntent.Eat });
    const b = spawnAgent(mini, 11, 10, { intent: AgentIntent.Rest });
    const c = spawnAgent(mini, 10.4, 10.6, { intent: AgentIntent.Rest }); // nearer than B
    // First contest: nearest (C) gets blamed.
    mini.world.food[mini.world.tileIndex(10, 10)] = 0;
    mini.ctx.socialIndex.rebuild(mini.ecs);
    interactWithResources(mini.ctx);
    const rel = mini.ecs.relationships;
    expect(rel.find(a, c)).not.toBe(-1);
    expect(rel.scoreOf(rel.find(a, c))).toBeLessThan(0);

    // Second contest after the cooldown: A blames C again (already-blamed
    // agents are preferred targets), not the nearer-but-neutral B.
    mini.ctx.tick += mini.config.social.conflict.resentmentIntervalTicks + 1;
    mini.world.food[mini.world.tileIndex(10, 10)] = 0;
    mini.ctx.socialIndex.rebuild(mini.ecs);
    interactWithResources(mini.ctx);
    const towardC = rel.find(a, c);
    const towardB = rel.find(a, b);
    expect(towardC).not.toBe(-1);
    expect(towardB).toBe(-1); // never blamed: the grudge sticks to C
    expect(rel.scoreOf(towardC)).toBeLessThan(-0.1); // deepened past the hostility gate
    expect(rel.negativeCountOf(towardC)).toBe(2);
  });
});
