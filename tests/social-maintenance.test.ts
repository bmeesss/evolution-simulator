/**
 * Phase 4 — social maintenance tests: the slow dynamics of the social layer.
 *
 * updateSocialState is exercised directly in controlled scenarios: loneliness
 * rise (personality-scaled), forage-bonus countdown, familiarity decay,
 * hostility healing (grudges fade but never overshoot into goodwill),
 * bounded pruning and dead-agent reference cleanup.
 */

import { describe, expect, it } from 'vitest';
import { makeContext, spawnAgent } from './helpers';
import { updateSocialState } from '../src/simulation-core/simulation/systems/social-maintenance';
import { updateSocialInteractions } from '../src/simulation-core/simulation/systems/social-system';
import { AgentIntent } from '../src/simulation-core/ai/intents';
import type { EntityId } from '../src/simulation-core/ecs';
import type { MiniContext } from './helpers';

/** Advance the social state by `ticks` maintenance ticks. */
function advance(mini: MiniContext, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    mini.ctx.tick++;
    updateSocialState(mini.ctx);
  }
}

describe('loneliness dynamics', () => {
  it('rises over time for everyone, faster for social personalities', () => {
    const mini = makeContext(3);
    const social = spawnAgent(mini, 10, 10, { socialTendency: 1 });
    const loner = spawnAgent(mini, 12, 12, { socialTendency: 0 });
    advance(mini, 10);

    const socialLoneliness = mini.ecs.social.columns.loneliness[mini.ecs.social.index[social]];
    const lonerLoneliness = mini.ecs.social.columns.loneliness[mini.ecs.social.index[loner]];
    expect(socialLoneliness).toBeGreaterThan(0);
    expect(lonerLoneliness).toBeGreaterThan(0); // even loners get a little lonely
    expect(socialLoneliness).toBeGreaterThan(lonerLoneliness);
  });

  it('stays bounded at 100 (never grows unbounded)', () => {
    const mini = makeContext(3);
    const a = spawnAgent(mini, 10, 10, { socialTendency: 1, loneliness: 99 });
    advance(mini, 500);
    expect(mini.ecs.social.columns.loneliness[mini.ecs.social.index[a]]).toBeLessThanOrEqual(100);
  });
});

describe('cooperation forage bonus countdown', () => {
  it('counts down to zero and stops there', () => {
    const mini = makeContext(3);
    const a = spawnAgent(mini, 10, 10, { forageBonusTicks: 5 });
    advance(mini, 3);
    expect(mini.ecs.social.columns.forageBonusTicks[mini.ecs.social.index[a]]).toBe(2);
    advance(mini, 10);
    expect(mini.ecs.social.columns.forageBonusTicks[mini.ecs.social.index[a]]).toBe(0);
  });
});

describe('familiarity decay', () => {
  it('fades without contact, faster with more time passing', () => {
    const mini = makeContext(3);
    const a = spawnAgent(mini, 10, 10);
    const b = spawnAgent(mini, 20, 20);
    const rel = mini.ecs.relationships;
    const ab = rel.getOrCreate(a, b, 1, false).entry;
    rel.setFamiliarity(ab, 0.5);
    advance(mini, 10);
    expect(rel.familiarityOf(ab)).toBeLessThan(0.5);
    expect(rel.familiarityOf(ab)).toBeGreaterThanOrEqual(0);
  });
});

describe('hostility healing (grudges fade, never locked)', () => {
  it('a deep grudge decays toward neutral over time without new conflict', () => {
    const mini = makeContext(3);
    const a = spawnAgent(mini, 10, 10);
    const b = spawnAgent(mini, 20, 20);
    const rel = mini.ecs.relationships;
    const ab = rel.getOrCreate(a, b, 1, false).entry;
    rel.setScore(ab, -0.8);
    rel.setFamiliarity(ab, 0.5);

    advance(mini, 50);
    expect(rel.scoreOf(ab)).toBeGreaterThan(-0.8);
    expect(rel.scoreOf(ab)).toBeLessThan(0); // still hostile, but healing

    advance(mini, 5000); // far past the ~2000 ticks a full grudge needs
    // Fully healed either way: the score reached neutral, or the now-weak
    // stale entry was pruned from memory entirely (both are "no grudge").
    const healed = rel.find(a, b);
    if (healed !== -1) {
      expect(rel.scoreOf(healed)).toBeGreaterThanOrEqual(-0.001); // neutral
      expect(rel.scoreOf(healed)).toBeLessThanOrEqual(0.001); // never goodwill
    }
  });

  it('positive bonds are not decayed by time (only familiarity fades)', () => {
    const mini = makeContext(3);
    const a = spawnAgent(mini, 10, 10);
    const b = spawnAgent(mini, 20, 20);
    const rel = mini.ecs.relationships;
    const ab = rel.getOrCreate(a, b, 1, false).entry;
    rel.setScore(ab, 0.7);
    advance(mini, 200);
    expect(rel.scoreOf(ab)).toBeCloseTo(0.7);
  });
});

describe('relationship pruning (bounded social graph)', () => {
  it('drops weak, stale, unfamiliar entries', () => {
    const mini = makeContext(3);
    const a = spawnAgent(mini, 10, 10);
    const stranger = spawnAgent(mini, 20, 20);
    const rel = mini.ecs.relationships;
    const weak = rel.getOrCreate(a, stranger, 1, false).entry;
    rel.setFamiliarity(weak, 0);
    rel.setScore(weak, 0.01);

    // Past the prune age with nothing to show for it: forgotten.
    mini.ctx.tick = mini.config.social.memory.pruneAgeTicks + 10;
    updateSocialState(mini.ctx);
    expect(rel.find(a, stranger)).toBe(-1);
  });

  it('keeps bonded entries alive far past the prune age', () => {
    const mini = makeContext(3);
    const a = spawnAgent(mini, 10, 10);
    const friend = spawnAgent(mini, 20, 20);
    const rel = mini.ecs.relationships;
    const bond = rel.getOrCreate(a, friend, 1, false).entry;
    rel.setScore(bond, 0.6);
    rel.setFamiliarity(bond, 0.7);
    rel.setLastInteractionTick(bond, 0);

    mini.ctx.tick = 5000;
    updateSocialState(mini.ctx);
    expect(rel.find(a, friend)).not.toBe(-1);
  });

  it('removes relationships that point at dead agents', () => {
    const mini = makeContext(3);
    const a = spawnAgent(mini, 10, 10);
    const doomed = spawnAgent(mini, 12, 12);
    const rel = mini.ecs.relationships;
    const ab = rel.getOrCreate(a, doomed, 1, false).entry;
    rel.setScore(ab, 0.9);
    rel.setFamiliarity(ab, 0.9);

    // Simulate the death system's cleanup path: the agent dies and every
    // store it owns is detached, then maintenance prunes dangling references.
    mini.ecs.social.detach(doomed);
    mini.ecs.position.detach(doomed);
    rel.removeAll(doomed); // outgoing references of the dead agent
    mini.ecs.entities.destroy(doomed);

    mini.ctx.tick++;
    updateSocialState(mini.ctx);
    expect(rel.find(a, doomed)).toBe(-1); // incoming reference pruned
  });
});

describe('dead agent cleanup (end of a social life)', () => {
  it('a dead group member is removed from its group and from social candidacy', () => {
    const mini = makeContext(5);
    const survivor = spawnAgent(mini, 10, 10);
    const doomed = spawnAgent(mini, 10.5, 10);
    const rel = mini.ecs.relationships;

    // The two meet and form a mutual bond.
    const intentSlot = mini.ecs.intent.index[survivor];
    mini.ecs.intent.columns.kind[intentSlot] = AgentIntent.Socialize;
    mini.ecs.intent.columns.targetEntity[intentSlot] = doomed;
    mini.ctx.tick++;
    updateSocialInteractions(mini.ctx);
    expect(rel.find(survivor, doomed)).not.toBe(-1);
    expect(rel.find(doomed, survivor)).not.toBe(-1);

    // The doomed agent joins a group (hand-registered).
    const group = mini.groups.create(10, [survivor, doomed], -1, 0);
    mini.ecs.social.columns.groupId[mini.ecs.social.index[doomed]] = group.id;
    mini.ecs.social.columns.groupId[mini.ecs.social.index[survivor]] = group.id;

    // Death cleanup, as the death system performs it.
    mini.groups.removeMember(doomed, group.id);
    mini.ecs.social.detach(doomed);
    rel.removeAll(doomed);
    mini.ecs.entities.destroy(doomed);

    // Maintenance runs; nothing dangles, membership reconciled.
    mini.ctx.tick++;
    updateSocialState(mini.ctx);
    expect(group.members).not.toContain(doomed);
    expect(group.members).toContain(survivor);
    expect(rel.find(survivor, doomed)).toBe(-1);

    // The social index only indexes live agents — the dead are never social
    // or conflict candidates again.
    mini.ctx.socialIndex.rebuild(mini.ecs);
    let sawDoomed = false;
    for (
      let c = 0, n = 0;
      c < mini.ctx.socialIndex.cols * mini.ctx.socialIndex.rows;
      c++
    ) {
      for (
        let e = mini.ctx.socialIndex.headOf(c);
        e !== -1 && n < 10000;
        e = mini.ctx.socialIndex.nextOf(e), n++
      ) {
        if (e === doomed) sawDoomed = true;
      }
    }
    expect(sawDoomed).toBe(false);
  });
});

describe('relationship store bounds under churn', () => {
  it('total entries never exceed population × capacity, even after many meetings', () => {
    const mini = makeContext(9, 20);
    const capacity = mini.config.social.memory.capacity;
    const agents: EntityId[] = [];
    for (let i = 0; i < 12; i++) {
      agents.push(spawnAgent(mini, 5 + (i % 4), 5 + (i % 4)));
    }
    // Everyone socializes with everyone (in reach): the store caps per agent.
    for (const a of agents) {
      for (const b of agents) {
        if (a === b) continue;
        const slot = mini.ecs.intent.index[a];
        mini.ecs.intent.columns.kind[slot] = AgentIntent.Socialize;
        mini.ecs.intent.columns.targetEntity[slot] = b;
        mini.ctx.tick++;
        updateSocialInteractions(mini.ctx);
      }
    }
    const rel = mini.ecs.relationships;
    let total = 0;
    for (const a of agents) total += rel.countFor(a);
    expect(total).toBeLessThanOrEqual(agents.length * capacity);
    // No duplicate edges: at most one entry per (self, target).
    for (const a of agents) {
      const seen = new Set<EntityId>();
      for (let e = rel.headOf(a); e !== -1; e = rel.nextOf(e)) {
        const target = rel.targetOf(e);
        expect(seen.has(target)).toBe(false);
        seen.add(target);
      }
    }
  });
});
