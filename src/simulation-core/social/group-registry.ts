/**
 * GroupRegistry — persistent identity for emergent social communities.
 *
 * Groups are NOT created by a fixed rule ("10 nearby agents = tribe"). The
 * group SYSTEM (simulation/systems/group-system.ts) derives candidate
 * communities from the actual social graph (relationships + spatial
 * proximity) and reconciles them with this registry, so identity survives
 * across detection runs:
 *
 *   - a community that keeps existing keeps its group ID (stable identity),
 *   - a split keeps the larger fragment on the original ID and spawns a new
 *     group with `parentId` + `generation + 1` (historical continuity),
 *   - a merge keeps the older group and dissolves the younger one,
 *   - brand-new groups only form after the cluster has been observed in two
 *     consecutive detection runs (hysteresis against merge/split flapping).
 *
 * The registry stores bounded per-group data (members, approximate
 * territory, cohesion) and the union-find scratch used by detection. The
 * scratch is a derived cache — never serialized, rebuilt per run with a
 * stamp so it does not need clearing.
 */

import type { EntityId } from '../ecs';

/** Persistent per-group record. */
export interface GroupRecord {
  readonly id: number;
  /** Tick the group was created. */
  createdTick: number;
  /** Group it split from, or -1 for a spontaneous group. */
  readonly parentId: number;
  /** Split lineage depth (0 = spontaneous, parent.generation + 1 on split). */
  readonly generation: number;
  /** Consecutive detection runs this group has survived (hysteresis input). */
  stableRuns: number;
  /** Actual member entity IDs (kept valid when agents die). */
  members: number[];
  /** Approximate territory: activity center + radius (tiles). */
  centerX: number;
  centerY: number;
  radius: number;
  /** Measured cohesion in [0, 1] (see group-system for the formula). */
  cohesion: number;
  /** Average food/water availability within the territory (0..1). */
  foodAccess: number;
  waterAccess: number;
}

export interface SerializedGroupRecord {
  id: number;
  createdTick: number;
  parentId: number;
  generation: number;
  stableRuns: number;
  members: number[];
  centerX: number;
  centerY: number;
  radius: number;
  cohesion: number;
  foodAccess: number;
  waterAccess: number;
}

export interface SerializedGroupRegistry {
  nextGroupId: number;
  groups: SerializedGroupRecord[];
  /** Cluster signatures awaiting their second consecutive run (hysteresis). */
  pendingSignatures: string[];
}

export class GroupRegistry {
  private nextGroupId = 1;
  readonly groups: GroupRecord[] = [];
  /**
   * Signatures of clusters (from the previous detection run) that have not
   * been matched to any group yet — a new group forms once a signature
   * survives two consecutive runs.
   */
  readonly pendingSignatures = new Set<string>();

  /** Derived union-find scratch — NOT serialized (rebuilt every run). */
  readonly scratch = {
    /** entity id -> compact run index (valid only when the stamp matches). */
    compactOf: new Int32Array(1024),
    compactStamp: new Uint32Array(1024),
    /** compact index -> entity id (allocation order). */
    compactEntities: [] as number[],
    /** union-find parent/size by compact index. */
    ufParent: new Int32Array(1024),
    ufSize: new Int32Array(1024),
    /** Monotonic run stamp; bumped once per detection run. */
    runStamp: 0,
  };

  get groupCount(): number {
    return this.groups.length;
  }

  get(id: number): GroupRecord | null {
    for (const group of this.groups) {
      if (group.id === id) return group;
    }
    return null;
  }

  /** Create a new group record (the caller emits the event). */
  create(
    createdTick: number,
    members: readonly EntityId[],
    parentId: number,
    generation: number,
  ): GroupRecord {
    const record: GroupRecord = {
      id: this.nextGroupId++,
      createdTick,
      parentId,
      generation,
      stableRuns: 0,
      members: [...members],
      centerX: 0,
      centerY: 0,
      radius: 0,
      cohesion: 0,
      foodAccess: 0,
      waterAccess: 0,
    };
    this.groups.push(record);
    return record;
  }

  /** Remove a group record (disband/merge-away). Members must be cleared first. */
  remove(id: number): void {
    const index = this.groups.findIndex((group) => group.id === id);
    if (index >= 0) this.groups.splice(index, 1);
  }

  /** Remove a member from its group (leave/death). Returns the group id or -1. */
  removeMember(entity: EntityId, id: number): boolean {
    const group = this.get(id);
    if (!group) return false;
    const index = group.members.indexOf(entity);
    if (index >= 0) group.members.splice(index, 1);
    return true;
  }

  serialize(): SerializedGroupRegistry {
    return {
      nextGroupId: this.nextGroupId,
      groups: this.groups.map((group) => ({ ...group, members: [...group.members] })),
      pendingSignatures: [...this.pendingSignatures],
    };
  }

  restore(saved: SerializedGroupRegistry): void {
    this.nextGroupId = saved.nextGroupId;
    this.groups.length = 0;
    for (const record of saved.groups) {
      this.groups.push({ ...record, members: [...record.members] });
    }
    this.pendingSignatures.clear();
    for (const signature of saved.pendingSignatures) {
      this.pendingSignatures.add(signature);
    }
  }
}
