/**
 * Phase 4 — group system tests: emergent community detection and membership.
 *
 * updateGroups is driven directly in controlled scenarios: hand-built
 * relationship graphs + positions, detection runs at exact intervals.
 * Assertions are structural (groups form/persist/split/merge, membership is
 * utility-gated, IDs stable, events fired) — never exact whole-run outcomes.
 */

import { describe, expect, it } from 'vitest';
import { makeContext, spawnAgent, type MiniContext } from './helpers';
import {
  updateGroups,
  groupJoinUtility,
  groupLeaveUtility,
} from '../src/simulation-core/simulation/systems/group-system';
import type { EntityId } from '../src/simulation-core/ecs';

const DETECTION = 96; // default groups.detectionIntervalTicks

/** Create mutual bonds of `score` between all pairs of agents. */
function bondAll(mini: MiniContext, ids: EntityId[], score: number, tick = 1): void {
  const rel = mini.ecs.relationships;
  for (const a of ids) {
    for (const b of ids) {
      if (a === b) continue;
      const { entry } = rel.getOrCreate(a, b, tick, false);
      rel.setScore(entry, score);
      rel.setFamiliarity(entry, 0.6);
    }
  }
}

/** One detection run at the given tick (must be a multiple of DETECTION). */
function detect(mini: MiniContext, tick: number): void {
  mini.ctx.tick = tick;
  updateGroups(mini.ctx);
}

function eventsOf(mini: MiniContext, type: string) {
  return mini.events.recent(1000).filter((e) => e.type === type);
}

/** Spawn a small bonded cluster that should easily pass the join threshold. */
function spawnCluster(mini: MiniContext, x: number, y: number, count: number, tag: number): EntityId[] {
  const ids: EntityId[] = [];
  for (let i = 0; i < count; i++) {
    ids.push(
      spawnAgent(mini, x + (i % 2) * 1.5, y + Math.floor(i / 2) * 1.5, {
        socialTendency: 0.7,
        loneliness: 60,
      }),
    );
  }
  bondAll(mini, ids, 0.4, tag);
  return ids;
}

describe('group membership utilities', () => {
  it('join utility: bounded, and rises with social drive, bonds and stability', () => {
    const base = {
      socialTendency: 0.5,
      loneliness: 50,
      averageScoreToMembers: 0.4,
      stableRuns: 2,
      distanceToCenterSquared: 4,
      maxDistance: 14,
    };
    const u = groupJoinUtility(base);
    expect(u).toBeGreaterThan(0);
    expect(u).toBeLessThanOrEqual(1);

    // More social + more lonely + better bonds + more stable -> higher.
    expect(
      groupJoinUtility({
        ...base,
        socialTendency: 0.95,
        loneliness: 90,
        averageScoreToMembers: 0.8,
        stableRuns: 5,
      }),
    ).toBeGreaterThan(u);
    // A hermit with no bonds does not want in.
    expect(
      groupJoinUtility({ ...base, socialTendency: 0, loneliness: 0, averageScoreToMembers: -0.5 }),
    ).toBeLessThan(u);
    // Far away -> lower.
    expect(groupJoinUtility({ ...base, distanceToCenterSquared: 14 * 14 })).toBeLessThan(u);
  });

  it('leave utility: bounded, and rises with decayed bonds, drift, crowding', () => {
    const base = {
      averageScoreToMembers: 0.3,
      distanceToCenter: 5,
      maxDistance: 14,
      memberCount: 6,
      preferredSize: 12,
      cohesion: 0.6,
    };
    const u = groupLeaveUtility(base);
    expect(u).toBeGreaterThanOrEqual(0);
    expect(u).toBeLessThanOrEqual(1);
    expect(groupLeaveUtility({ ...base, averageScoreToMembers: -0.5 })).toBeGreaterThan(u); // soured
    expect(groupLeaveUtility({ ...base, distanceToCenter: 60 })).toBeGreaterThan(u); // drifted far
    expect(groupLeaveUtility({ ...base, memberCount: 40 })).toBeGreaterThan(u); // overcrowded
    // Normal foraging dispersal (well inside the tether) must NOT pressure.
    expect(groupLeaveUtility({ ...base, distanceToCenter: 18 })).toBeLessThan(0.6);
  });
});

describe('group formation (emergent, not a proximity rule)', () => {
  it('a bonded, nearby cluster becomes a group after the two-run hysteresis', () => {
    const mini = makeContext(5, 48);
    const cluster = spawnCluster(mini, 8, 8, 4, 1);

    detect(mini, DETECTION); // first observation: pending only
    expect(mini.groups.groupCount).toBe(0);
    expect(mini.ecs.social.columns.groupId[mini.ecs.social.index[cluster[0]]]).toBe(-1);

    detect(mini, DETECTION * 2); // second observation: group forms and agents join
    expect(mini.groups.groupCount).toBe(1);
    const group = mini.groups.groups[0];
    expect(group.members.length).toBe(4);
    expect(group.parentId).toBe(-1);
    expect(group.generation).toBe(0);
    expect(group.cohesion).toBeGreaterThan(0);
    expect(group.cohesion).toBeLessThanOrEqual(1);
    expect(eventsOf(mini, 'group_created')).toHaveLength(1);
    expect(eventsOf(mini, 'group_joined')).toHaveLength(4);
    for (const member of cluster) {
      expect(mini.ecs.social.columns.groupId[mini.ecs.social.index[member]]).toBe(group.id);
    }
  });

  it('proximity alone never creates a group (no social bonds -> no community)', () => {
    const mini = makeContext(5, 48);
    spawnCluster(mini, 8, 8, 4, 1);
    mini.ecs.relationships['restore']({ entities: [], entries: [] }); // strip all bonds

    detect(mini, DETECTION);
    detect(mini, DETECTION * 2);
    detect(mini, DETECTION * 3);
    expect(mini.groups.groupCount).toBe(0);
    expect(eventsOf(mini, 'group_created')).toHaveLength(0);
  });

  it('bonded but distant agents do not form one group', () => {
    const mini = makeContext(5, 48);
    const near = spawnCluster(mini, 4, 4, 3, 1);
    const far = spawnCluster(mini, 40, 40, 3, 2);
    const all = [...near, ...far];
    bondAll(mini, all, 0.4, 3); // even fully bonded, 36+ tiles apart

    detect(mini, DETECTION);
    detect(mini, DETECTION * 2);
    // Two separate communities, not one sprawling group.
    expect(mini.groups.groupCount).toBe(2);
    const sizes = mini.groups.groups.map((g) => g.members.length).sort();
    expect(sizes).toEqual([3, 3]);
  });

  it('detection runs only at the configured interval', () => {
    const mini = makeContext(5, 48);
    spawnCluster(mini, 8, 8, 4, 1);
    detect(mini, DETECTION + 1); // not a multiple: no-op
    expect(mini.groups.groupCount).toBe(0);
    detect(mini, 0); // tick 0: no-op by contract
    expect(mini.groups.groupCount).toBe(0);
  });
});

describe('group persistence and lifecycle', () => {
  function formed(mini: MiniContext): { group: ReturnType<MiniContext['groups']['get']> } {
    spawnCluster(mini, 8, 8, 4, 1);
    detect(mini, DETECTION);
    detect(mini, DETECTION * 2);
    return { group: mini.groups.groups[0] };
  }

  it('a stable cluster keeps its identity across many detection runs', () => {
    const mini = makeContext(5, 48);
    const { group } = formed(mini);
    const id = group!.id;

    for (let run = 3; run <= 8; run++) detect(mini, DETECTION * run);
    expect(mini.groups.groupCount).toBe(1);
    expect(mini.groups.groups[0].id).toBe(id); // same identity
    expect(mini.groups.groups[0].members.length).toBe(4);
    expect(mini.groups.groups[0].stableRuns).toBeGreaterThanOrEqual(6);
    expect(eventsOf(mini, 'group_created')).toHaveLength(1); // no churn
    expect(eventsOf(mini, 'group_left')).toHaveLength(0);
    expect(eventsOf(mini, 'group_split')).toHaveLength(0);
    expect(eventsOf(mini, 'group_merged')).toHaveLength(0);
  });

  it('normal foraging dispersal does not break membership (anti-churn)', () => {
    const mini = makeContext(5, 48);
    const { group } = formed(mini);
    const wanderer = group!.members[0];

    // The wanderer forages 20 tiles out — beyond the cluster edge distance
    // (14) but well inside the leave tether (2 × 14): it stays a member.
    const slot = mini.ecs.position.index[wanderer];
    mini.ecs.position.columns.x[slot] += 20;
    mini.ecs.position.columns.y[slot] += 20;

    detect(mini, DETECTION * 3);
    expect(group!.members).toContain(wanderer);
    expect(mini.ecs.social.columns.groupId[mini.ecs.social.index[wanderer]]).toBe(group!.id);
    expect(eventsOf(mini, 'group_left')).toHaveLength(0);
  });

  it('sustained drift beyond the tether ends membership', () => {
    const mini = makeContext(5, 48);
    const { group } = formed(mini);
    const drifter = group!.members[0];
    const slot = mini.ecs.position.index[drifter];
    mini.ecs.position.columns.x[slot] += 40; // far past the tether
    mini.ecs.position.columns.y[slot] += 40;

    detect(mini, DETECTION * 3);
    expect(group!.members).not.toContain(drifter);
    expect(mini.ecs.social.columns.groupId[mini.ecs.social.index[drifter]]).toBe(-1);
    expect(eventsOf(mini, 'group_left')).toHaveLength(1);
  });

  it('decayed bonds end membership even at the group center', () => {
    const mini = makeContext(5, 48);
    const { group } = formed(mini);
    const estranged = group!.members[0];
    const rel = mini.ecs.relationships;
    for (let e = rel.headOf(estranged); e !== -1; e = rel.nextOf(e)) {
      rel.setScore(e, -0.6); // every bond soured
    }

    detect(mini, DETECTION * 3);
    expect(group!.members).not.toContain(estranged);
    expect(eventsOf(mini, 'group_left')).toHaveLength(1);
  });

  it('a one-member group is wound down (no zombie groups)', () => {
    const mini = makeContext(5, 48);
    const a = spawnAgent(mini, 8, 8);
    const b = spawnAgent(mini, 9, 9);
    const group = mini.groups.create(10, [a, b], -1, 0);
    mini.ecs.social.columns.groupId[mini.ecs.social.index[a]] = group.id;
    mini.ecs.social.columns.groupId[mini.ecs.social.index[b]] = group.id;

    // b dies: the death system's cleanup removes it from the group.
    mini.groups.removeMember(b, group.id);
    mini.ecs.social.detach(b);
    mini.ecs.entities.destroy(b);

    detect(mini, DETECTION); // solo survivor -> group dissolves
    expect(mini.groups.get(group.id)).toBeNull();
    expect(mini.ecs.social.columns.groupId[mini.ecs.social.index[a]]).toBe(-1);
    expect(eventsOf(mini, 'group_left')).toHaveLength(1);
  });
});

describe('split and merge (historical continuity)', () => {
  function sixMemberGroup(mini: MiniContext): { groupA: number; aTeam: EntityId[]; bTeam: EntityId[] } {
    const aTeam = spawnCluster(mini, 8, 8, 3, 1);
    const bTeam = spawnCluster(mini, 11, 11, 3, 2);
    bondAll(mini, [...aTeam, ...bTeam], 0.4, 3);
    detect(mini, DETECTION);
    detect(mini, DETECTION * 2);
    expect(mini.groups.groupCount).toBe(1);
    return { groupA: mini.groups.groups[0].id, aTeam, bTeam };
  }

  it('a group that physically separates splits into parent + offspring', () => {
    const mini = makeContext(5, 48);
    const { groupA, aTeam, bTeam } = sixMemberGroup(mini);

    // The b-team migrates 30+ tiles away (still mutually bonded internally).
    for (let i = 0; i < bTeam.length; i++) {
      const slot = mini.ecs.position.index[bTeam[i]];
      mini.ecs.position.columns.x[slot] = 36 + i;
      mini.ecs.position.columns.y[slot] = 36 + i;
    }

    detect(mini, DETECTION * 3);
    expect(mini.groups.groupCount).toBe(2);
    const original = mini.groups.get(groupA)!;
    const offspring = mini.groups.groups.find((g) => g.id !== groupA)!;

    // Historical continuity: the offspring knows its parent.
    expect(offspring.parentId).toBe(groupA);
    expect(offspring.generation).toBe(original.generation + 1);
    expect(original.members.length).toBe(3);
    expect(offspring.members.length).toBe(3);
    for (const member of aTeam) expect(original.members).toContain(member);
    for (const member of bTeam) expect(offspring.members).toContain(member);
    expect(eventsOf(mini, 'group_split')).toHaveLength(1);
  });

  it('reunited groups merge: the older identity survives', () => {
    const mini = makeContext(5, 48);
    const { groupA, bTeam } = sixMemberGroup(mini);

    // Split first...
    for (let i = 0; i < bTeam.length; i++) {
      const slot = mini.ecs.position.index[bTeam[i]];
      mini.ecs.position.columns.x[slot] = 36 + i;
      mini.ecs.position.columns.y[slot] = 36 + i;
    }
    detect(mini, DETECTION * 3);
    expect(mini.groups.groupCount).toBe(2);
    const offspringId = mini.groups.groups.find((g) => g.id !== groupA)!.id;

    // ...then come back together.
    for (let i = 0; i < bTeam.length; i++) {
      const slot = mini.ecs.position.index[bTeam[i]];
      mini.ecs.position.columns.x[slot] = 10 + i;
      mini.ecs.position.columns.y[slot] = 10 + i;
    }
    detect(mini, DETECTION * 4);

    expect(mini.groups.groupCount).toBe(1);
    expect(mini.groups.get(groupA)).not.toBeNull(); // older survives
    expect(mini.groups.get(offspringId)).toBeNull(); // younger dissolved
    expect(mini.groups.get(groupA)!.members.length).toBe(6);
    expect(eventsOf(mini, 'group_merged')).toHaveLength(1);
  });
});

describe('group determinism and identity', () => {
  it('identical scenarios produce identical group identities, membership and events', () => {
    function run(): string {
      const mini = makeContext(11, 48);
      const cluster = spawnCluster(mini, 8, 8, 4, 1);
      detect(mini, DETECTION);
      detect(mini, DETECTION * 2);
      // Drift one member, split check, then settle back.
      const slot = mini.ecs.position.index[cluster[3]];
      mini.ecs.position.columns.x[slot] += 30;
      detect(mini, DETECTION * 3);
      mini.ecs.position.columns.x[slot] -= 30;
      detect(mini, DETECTION * 4);
      return JSON.stringify({
        registry: mini.groups.serialize(),
        memberships: cluster.map((id) => mini.ecs.social.columns.groupId[mini.ecs.social.index[id]]),
        events: mini.events.recent(1000).map((e) => `${e.tick}:${e.type}:${e.detail}`),
      });
    }
    expect(run()).toBe(run());
  });

  it('group registry round-trips through serialization with stable IDs', () => {
    const mini = makeContext(5, 48);
    spawnCluster(mini, 8, 8, 4, 1);
    detect(mini, DETECTION);
    detect(mini, DETECTION * 2);
    const saved = mini.groups.serialize();

    const mini2 = makeContext(6, 48);
    mini2.groups.restore(saved);
    expect(mini2.groups.serialize()).toEqual(saved);
    // ID allocation continues from the restored counter: no ID reuse, ever.
    const next = mini2.groups.create(999, [], -1, 0);
    expect(next.id).toBeGreaterThan(Math.max(...saved.groups.map((g) => g.id)));
  });

  it('group IDs are deterministic small integers, not random labels', () => {
    const mini = makeContext(5, 48);
    spawnCluster(mini, 8, 8, 4, 1);
    detect(mini, DETECTION);
    detect(mini, DETECTION * 2);
    const id = mini.groups.groups[0].id;
    expect(Number.isInteger(id)).toBe(true);
    expect(id).toBeGreaterThan(0);
    expect(id).toBeLessThan(1000);
  });
});
