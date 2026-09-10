/**
 * Kin awareness (Phase 4) — recognizing direct kin from lineage data.
 *
 * Phase 3 already stores each agent's parents in the `lineage` component.
 * This module answers "how are A and B related?" from that data alone:
 *   - ParentChild: one is the parent of the other
 *   - Sibling: they share at least one parent
 *   - None: not direct kin (no ancestry walk — the spec explicitly avoids a
 *     full genealogy graph)
 *
 * Kinship is a BIAS, never a rule: kin-tinted relationships start warmer
 * (seeded at birth) and social utilities apply documented kin multipliers,
 * but conflict can still push a kin relationship negative. Nothing here
 * forces family members to like each other.
 *
 * Cheap O(1) array reads — usable inside hot AI loops.
 */

import type { EntityId, SimulationEcs } from '../ecs';

export const KinshipType = {
  None: 0,
  ParentChild: 1,
  Sibling: 2,
} as const;

export type KinshipType = (typeof KinshipType)[keyof typeof KinshipType];

/**
 * Classify the direct kinship between two entities. The founding generation
 * uses -1 sentinels for absent parents, so any check involving a founder
 * without recorded parents returns None.
 */
export function kinshipBetween(a: EntityId, b: EntityId, ecs: SimulationEcs): KinshipType {
  if (a === b) return KinshipType.None;
  const lin = ecs.lineage;
  const aSlot = lin.index[a];
  const bSlot = lin.index[b];
  if (aSlot < 0 || bSlot < 0) return KinshipType.None;
  const aA = lin.columns.parentA[aSlot];
  const aB = lin.columns.parentB[aSlot];
  const bA = lin.columns.parentA[bSlot];
  const bB = lin.columns.parentB[bSlot];
  if (aA === b || aB === b || bA === a || bB === a) return KinshipType.ParentChild;
  if (aA >= 0 && (aA === bA || aA === bB)) return KinshipType.Sibling;
  if (aB >= 0 && (aB === bA || aB === bB)) return KinshipType.Sibling;
  return KinshipType.None;
}

/** True when the two entities are direct kin (parent/child or sibling). */
export function areKin(a: EntityId, b: EntityId, ecs: SimulationEcs): boolean {
  return kinshipBetween(a, b, ecs) !== KinshipType.None;
}

/**
 * Seed the parent↔child relationships at birth: the child knows its parents
 * and the parents know the child, with warm-but-modest starting values from
 * config.social.kinship. Sibling bonds are NOT pre-seeded — siblings
 * recognize each other on contact (the kin flag is set when their
 * relationship is created via kinshipBetween).
 */
export function seedKinRelationships(
  ecs: SimulationEcs,
  child: EntityId,
  parentA: EntityId,
  parentB: EntityId,
  baseScore: number,
  baseTrust: number,
  baseFamiliarity: number,
  tick: number,
): void {
  const relationships = ecs.relationships;
  for (const parent of [parentA, parentB]) {
    if (parent < 0) continue;
    for (const [self, other] of [
      [child, parent],
      [parent, child],
    ] as Array<[EntityId, EntityId]>) {
      const { entry } = relationships.getOrCreate(self, other, tick, true);
      relationships.setScore(entry, baseScore);
      relationships.setTrust(entry, baseTrust);
      relationships.setFamiliarity(entry, baseFamiliarity);
    }
  }
}
