/**
 * Group system (Phase 4) — emergent community detection and membership.
 *
 * Groups are DERIVED structures, never a gameplay object created by a fixed
 * rule. Every `groups.detectionIntervalTicks` ticks (one in-game day by
 * default — clustering is periodic, never per tick):
 *
 *   1. Build a social graph edge between two agents when a relationship is
 *      positive enough (score >= edgeScoreThreshold) AND they are spatially
 *      close (<= maxMemberDistanceTiles) — social connectivity combined with
 *      geographic proximity.
 *   2. Find connected components (union-find, deterministic). Components of
 *      at least `minSize` agents are candidate clusters.
 *   3. Reconcile clusters with existing groups:
 *        - a cluster that best-matches a group CONTINUES it (stable IDs),
 *        - a group whose members land in several clusters SPLITS: the best-
 *          matching fragment keeps the ID, the others become new groups
 *          carrying parentId + generation (historical continuity),
 *        - groups whose fragments end up in one cluster MERGE: the older
 *          group survives and the younger dissolves,
 *        - a cluster with no group ties must be seen in TWO consecutive runs
 *          before it founds a new group (hysteresis against flapping).
 *   4. Membership is a per-agent utility decision (join/leave thresholds from
 *      config) — nobody is forced into a group and isolated agents stay
 *      isolated.
 *   5. Group stats refresh: members, territory center/radius, measured
 *      cohesion, resource access, stability counter.
 *
 * Determinism: allocation-order iteration, ascending member order, union-find
 * with union-by-size (ties keep the lower root), overlap matching with fixed
 * tie-breaks (ratio desc, then lower cluster index / lower group id). No
 * randomness anywhere.
 */

import type { TickContext } from '../tick-context';
import type { EntityId, SimulationEcs } from '../../ecs';
import type { GroupRecord, GroupRegistry } from '../../social/group-registry';
import { clamp01 } from '../../ai/utility';
import { distanceFactorSquared } from '../../ai/considerations';

/** Minimum overlap ratio for a cluster to claim a group's identity. */
const CLUSTER_MATCH_RATIO = 1 / 3;

/** Minimum shared members for an unclaimed cluster to count as a split. */
const SPLIT_MIN_FORMER_MEMBERS = 2;

interface Cluster {
  /** Member entity ids, ascending. */
  readonly members: readonly EntityId[];
  /** Deterministic signature (joined member ids) for the pending hysteresis. */
  readonly signature: string;
}

// --- union-find over the per-run compact index ------------------------------

function ufFind(scratch: GroupRegistry['scratch'], i: number): number {
  let root = i;
  while (scratch.ufParent[root] !== root) root = scratch.ufParent[root];
  // Path halving (deterministic — fixed traversal order).
  let current = i;
  while (scratch.ufParent[current] !== root) {
    const next = scratch.ufParent[current];
    scratch.ufParent[current] = root;
    current = next;
  }
  return root;
}

function ufUnion(scratch: GroupRegistry['scratch'], a: number, b: number): void {
  const ra = ufFind(scratch, a);
  const rb = ufFind(scratch, b);
  if (ra === rb) return;
  // Union by size; exact ties keep the lower root index as the root.
  let parent = ra;
  let child = rb;
  if (scratch.ufSize[ra] < scratch.ufSize[rb] || (scratch.ufSize[ra] === scratch.ufSize[rb] && ra > rb)) {
    parent = rb;
    child = ra;
  }
  scratch.ufParent[child] = parent;
  scratch.ufSize[parent] += scratch.ufSize[child];
}

function ensureCompactCapacity(scratch: GroupRegistry['scratch'], entity: EntityId): void {
  if (entity < scratch.compactOf.length) return;
  let capacity = scratch.compactOf.length;
  while (capacity <= entity) capacity *= 2;
  const compactOf = new Int32Array(capacity);
  compactOf.set(scratch.compactOf);
  scratch.compactOf = compactOf;
  const compactStamp = new Uint32Array(capacity);
  compactStamp.set(scratch.compactStamp);
  scratch.compactStamp = compactStamp;
}

function ensureUfCapacity(scratch: GroupRegistry['scratch'], count: number): void {
  if (count <= scratch.ufParent.length) return;
  let capacity = scratch.ufParent.length;
  while (capacity < count) capacity *= 2;
  const ufParent = new Int32Array(capacity);
  ufParent.set(scratch.ufParent);
  scratch.ufParent = ufParent;
  const ufSize = new Int32Array(capacity);
  ufSize.set(scratch.ufSize);
  scratch.ufSize = ufSize;
}

// --- membership utilities (bounded, documented, no randomness) ---------------

export interface GroupJoinFactors {
  socialTendency: number;
  loneliness: number;
  /** Average relationship score toward the (frozen) member set. */
  averageScoreToMembers: number;
  stableRuns: number;
  distanceToCenterSquared: number;
  maxDistance: number;
}

/**
 * JoinGroup utility: social drive × relationship to members × group stability
 * × distance factor. Bounded [0, 1]; an agent joins when it reaches the
 * configured join threshold.
 *
 * The multiplicative form keeps hermits (low socialTendency + low loneliness)
 * and estranged agents (negative bonds) out of groups while letting typical
 * cluster members — who already share positive bonds and proximity, which is
 * what made them a detected community in the first place — join. A brand-new
 * group is only mildly discounted (the two-run detection hysteresis already
 * guards against flapping; the discount exists so established groups attract
 * slightly better than unproven ones).
 */
export function groupJoinUtility(factors: GroupJoinFactors): number {
  const drive = (0.35 + 0.65 * clamp01(factors.socialTendency)) * (0.7 + 0.3 * clamp01(factors.loneliness / 100));
  const relationshipFactor = clamp01(0.3 + 0.7 * clamp01(factors.averageScoreToMembers));
  const stabilityFactor = 0.8 + (0.2 * Math.min(factors.stableRuns, 5)) / 5;
  const maxDistanceSquared = factors.maxDistance * factors.maxDistance;
  const distance = distanceFactorSquared(factors.distanceToCenterSquared, maxDistanceSquared);
  return drive * relationshipFactor * stabilityFactor * distance;
}

export interface GroupLeaveFactors {
  averageScoreToMembers: number;
  distanceToCenter: number;
  maxDistance: number;
  memberCount: number;
  preferredSize: number;
  cohesion: number;
}

/**
 * LeaveGroup utility: the worst of bond deterioration, spatial drift,
 * crowding and low cohesion. Bounded [0, 1]; leaving requires reaching the
 * (deliberately higher) leave threshold — hysteresis against join/leave
 * flapping.
 *
 * The spatial tether is intentionally generous (drift only pressures a member
 * beyond 2 × maxMemberDistanceTiles from the group's center): bonded agents
 * routinely forage dozens of tiles apart and reconverge on shared patches, so
 * momentary dispersal must not break membership — sustained drift must.
 */
export function groupLeaveUtility(factors: GroupLeaveFactors): number {
  const deterioration = clamp01(-factors.averageScoreToMembers / 0.5) * 0.6;
  const tether = factors.maxDistance * 2;
  const distance = clamp01(factors.distanceToCenter / tether - 0.25) * 0.8;
  const crowding =
    clamp01((factors.memberCount - factors.preferredSize) / Math.max(1, factors.preferredSize)) * 0.7;
  const lowCohesion = (1 - clamp01(factors.cohesion)) * 0.8;
  return Math.max(deterioration, distance, crowding, lowCohesion);
}

/** Average relationship score from `entity` toward a member set (0 if none). */
function averageScoreTowardMembers(
  ecs: SimulationEcs,
  entity: EntityId,
  members: ReadonlySet<EntityId>,
): number {
  const relationships = ecs.relationships;
  let sum = 0;
  let count = 0;
  for (let e = relationships.headOf(entity); e !== -1; e = relationships.nextOf(e)) {
    const target = relationships.targetOf(e);
    if (!members.has(target)) continue;
    sum += relationships.scoreOf(e);
    count++;
  }
  return count === 0 ? 0 : sum / count;
}

// --- group statistics ---------------------------------------------------------

/** Recompute a group's territory, cohesion and resource access from members. */
function refreshGroupStats(group: GroupRecord, ctx: TickContext): void {
  const { ecs, config, world } = ctx;
  const position = ecs.position;
  const members = group.members;
  const count = members.length;
  if (count === 0) return;

  let sumX = 0;
  let sumY = 0;
  for (const member of members) {
    const slot = position.index[member];
    if (slot < 0) continue;
    sumX += position.columns.x[slot];
    sumY += position.columns.y[slot];
  }
  group.centerX = sumX / count;
  group.centerY = sumY / count;

  let maxDistance = 0;
  let sumDistance = 0;
  for (const member of members) {
    const slot = position.index[member];
    if (slot < 0) continue;
    const dx = position.columns.x[slot] - group.centerX;
    const dy = position.columns.y[slot] - group.centerY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance > maxDistance) maxDistance = distance;
    sumDistance += distance;
  }
  const territoryCap = config.social.groups.maxTerritoryRadiusTiles;
  group.radius = Math.min(territoryCap, maxDistance);

  // Cohesion: 0.5 × social bond + 0.3 × spatial tightness + 0.2 × how many
  // member pairs actually know each other. Measured from real data only.
  const memberSet = new Set(members);
  const relationships = ecs.relationships;
  let bondSum = 0;
  let bondMembers = 0;
  let intraEntries = 0;
  for (const member of members) {
    let memberBondSum = 0;
    let memberBondCount = 0;
    for (let e = relationships.headOf(member); e !== -1; e = relationships.nextOf(e)) {
      const target = relationships.targetOf(e);
      if (!memberSet.has(target) || target === member) continue;
      intraEntries++;
      const score = relationships.scoreOf(e);
      if (score > 0) memberBondSum += score;
      memberBondCount++;
    }
    if (memberBondCount > 0) {
      bondSum += memberBondSum / memberBondCount;
      bondMembers++;
    }
  }
  const socialBond = bondMembers === 0 ? 0 : bondSum / bondMembers;
  const averageDistance = sumDistance / count;
  const spatial = group.radius <= 0 ? 1 : clamp01(1 - averageDistance / group.radius);
  const pairCount = (count * (count - 1)) / 2;
  const interactionDensity = pairCount === 0 ? 0 : clamp01(intraEntries / pairCount);
  group.cohesion = clamp01(0.5 * socialBond + 0.3 * spatial + 0.2 * interactionDensity);
  group.stableRuns++;

  // Resource access within the (capped) territory circle — informational.
  const minX = Math.max(0, Math.floor(group.centerX - group.radius));
  const maxX = Math.min(world.width - 1, Math.ceil(group.centerX + group.radius));
  const minY = Math.max(0, Math.floor(group.centerY - group.radius));
  const maxY = Math.min(world.height - 1, Math.ceil(group.centerY + group.radius));
  const radiusSq = group.radius * group.radius;
  let foodSum = 0;
  let waterSum = 0;
  let tiles = 0;
  for (let ty = minY; ty <= maxY; ty++) {
    for (let tx = minX; tx <= maxX; tx++) {
      const dx = tx - group.centerX;
      const dy = ty - group.centerY;
      if (group.radius > 0 && dx * dx + dy * dy > radiusSq) continue;
      const index = world.tileIndex(tx, ty);
      foodSum += world.food[index];
      waterSum += world.water[index];
      tiles++;
    }
  }
  group.foodAccess = tiles === 0 ? 0 : foodSum / tiles;
  group.waterAccess = tiles === 0 ? 0 : waterSum / tiles;
}

// --- the system ----------------------------------------------------------------

export function updateGroups(ctx: TickContext): void {
  const { ecs, config, events, tick, groups } = ctx;
  const groupConfig = config.social.groups;
  if (tick === 0 || tick % groupConfig.detectionIntervalTicks !== 0) return;

  const entities = ecs.entities;
  const relationships = ecs.relationships;
  const position = ecs.position;
  const socialStore = ecs.social;
  const scratch = groups.scratch;

  // --- 0. Drop dead members from every group ---------------------------------
  for (const group of groups.groups) {
    if (group.members.some((member) => !entities.isAlive(member))) {
      group.members = group.members.filter((member) => entities.isAlive(member));
    }
  }

  // --- 1. Compact alive agents + union-find over social+spatial edges --------
  scratch.runStamp++;
  const stamp = scratch.runStamp;
  scratch.compactEntities.length = 0;
  const aliveCount = entities.aliveCount;
  ensureUfCapacity(scratch, aliveCount);
  for (let k = 0; k < aliveCount; k++) {
    const entity = entities.aliveIds[k];
    ensureCompactCapacity(scratch, entity);
    scratch.compactOf[entity] = k;
    scratch.compactStamp[entity] = stamp;
    scratch.compactEntities.push(entity);
    scratch.ufParent[k] = k;
    scratch.ufSize[k] = 1;
  }

  const maxDistanceSq = groupConfig.maxMemberDistanceTiles * groupConfig.maxMemberDistanceTiles;
  const edgeThreshold = groupConfig.edgeScoreThreshold;
  for (let k = 0; k < aliveCount; k++) {
    const a = scratch.compactEntities[k];
    const aSlot = position.index[a];
    if (aSlot < 0) continue;
    const ax = position.columns.x[aSlot];
    const ay = position.columns.y[aSlot];
    for (let e = relationships.headOf(a); e !== -1; e = relationships.nextOf(e)) {
      const b = relationships.targetOf(e);
      if (b === a || b < 0 || b >= scratch.compactStamp.length || scratch.compactStamp[b] !== stamp) continue;
      if (relationships.scoreOf(e) < edgeThreshold) continue;
      const bSlot = position.index[b];
      if (bSlot < 0) continue;
      const dx = position.columns.x[bSlot] - ax;
      const dy = position.columns.y[bSlot] - ay;
      if (dx * dx + dy * dy > maxDistanceSq) continue;
      ufUnion(scratch, k, scratch.compactOf[b]);
    }
  }

  // --- 2. Collect clusters (size >= minSize), ordered by smallest member ----
  const byRoot = new Map<number, EntityId[]>();
  for (let k = 0; k < aliveCount; k++) {
    const root = ufFind(scratch, k);
    let list = byRoot.get(root);
    if (!list) {
      list = [];
      byRoot.set(root, list);
    }
    list.push(scratch.compactEntities[k]);
  }
  const clusters: Cluster[] = [];
  for (const list of byRoot.values()) {
    if (list.length < groupConfig.minSize) continue;
    clusters.push({ members: [...list].sort((a, b) => a - b), signature: list.join(',') });
  }
  // Cluster order: ascending smallest member id (deterministic).
  clusters.sort((a, b) => a.members[0] - b.members[0]);
  const clusterOfEntity = new Map<EntityId, number>();
  for (let c = 0; c < clusters.length; c++) {
    for (const member of clusters[c].members) clusterOfEntity.set(member, c);
  }

  // --- 3. Match clusters against existing groups -----------------------------
  // Frozen member sets (start of run) — evaluation inputs never change while
  // membership is being applied.
  const frozenMembers = new Map<number, Set<EntityId>>();
  for (const group of groups.groups) {
    frozenMembers.set(group.id, new Set(group.members));
  }

  // claims[c] = groups with overlap ratio >= 1/3.
  const claims: Array<Array<{ group: GroupRecord; overlap: number; ratio: number }>> = clusters.map(() => []);
  for (let c = 0; c < clusters.length; c++) {
    const members = clusters[c].members;
    for (const group of groups.groups) {
      const set = frozenMembers.get(group.id)!;
      let overlap = 0;
      for (const member of members) {
        if (set.has(member)) overlap++;
      }
      if (overlap === 0) continue;
      const ratio = overlap / Math.min(members.length, Math.max(1, group.members.length));
      if (ratio >= CLUSTER_MATCH_RATIO) {
        claims[c].push({ group, overlap, ratio });
      }
    }
  }

  // Winning cluster per group: max ratio, tie -> lower cluster index.
  const winningClusterOf = new Map<number, number>();
  const winningRatioOf = new Map<number, number>();
  for (let c = 0; c < clusters.length; c++) {
    for (const claim of claims[c]) {
      const currentRatio = winningRatioOf.get(claim.group.id);
      if (currentRatio === undefined || claim.ratio > currentRatio) {
        winningClusterOf.set(claim.group.id, c);
        winningRatioOf.set(claim.group.id, claim.ratio);
      }
    }
  }

  // The group each cluster ends up continuing/creating (id or null).
  const clusterGroupId: Array<number | null> = clusters.map(() => null);
  const nextPending = new Set<string>();
  const atCapacity = (): boolean => groups.groupCount >= groupConfig.maxGroups;

  for (let c = 0; c < clusters.length; c++) {
    const cluster = clusters[c];
    const myClaims = claims[c];

    // (a) Continue: collect the groups this cluster wins.
    const wonGroups: GroupRecord[] = [];
    for (const claim of myClaims) {
      if (winningClusterOf.get(claim.group.id) === c) wonGroups.push(claim.group);
    }
    if (wonGroups.length > 0) {
      // Merge resolution: several won groups fuse; the older one survives.
      let survivor = wonGroups[0];
      for (const candidate of wonGroups) {
        if (
          candidate.createdTick < survivor.createdTick ||
          (candidate.createdTick === survivor.createdTick && candidate.id < survivor.id)
        ) {
          survivor = candidate;
        }
      }
      for (const merged of wonGroups) {
        if (merged === survivor) continue;
        events.record('group_merged', {
          groupId: survivor.id,
          detail: `group #${merged.id} merged into group #${survivor.id}`,
        });
      }
      clusterGroupId[c] = survivor.id;
      continue;
    }

    // (b) Split: the cluster lost its claim but carries a real fragment of a
    // group — it becomes that group's offspring (historical continuity).
    if (myClaims.length > 0) {
      let best = myClaims[0];
      for (const claim of myClaims) {
        if (claim.overlap > best.overlap || (claim.overlap === best.overlap && claim.group.id < best.group.id)) {
          best = claim;
        }
      }
      if (best.overlap >= SPLIT_MIN_FORMER_MEMBERS && !atCapacity()) {
        const parent = best.group;
        const record = groups.create(tick, [], parent.id, parent.generation + 1);
        clusterGroupId[c] = record.id;
        events.record('group_split', {
          groupId: parent.id,
          detail: `group #${parent.id} split: new group #${record.id} (${best.overlap} former members)`,
        });
        continue;
      }
      // Fragment too small to count as a split: fall through to the fresh path.
    }

    // (c) Fresh community: requires two consecutive runs (hysteresis).
    if (!atCapacity() && groups.pendingSignatures.has(cluster.signature)) {
      const record = groups.create(tick, [], -1, 0);
      clusterGroupId[c] = record.id;
      events.record('group_created', {
        groupId: record.id,
        detail: `seed members: ${cluster.members.slice(0, 4).join(', ')}`,
      });
    } else {
      nextPending.add(cluster.signature);
    }
  }

  // Provisional centers for brand-new groups (their territory is unknown).
  for (let c = 0; c < clusters.length; c++) {
    const groupId = clusterGroupId[c];
    if (groupId === null) continue;
    const group = groups.get(groupId);
    if (!group || group.stableRuns > 0 || group.members.length > 0) continue;
    let sumX = 0;
    let sumY = 0;
    let count = 0;
    for (const member of clusters[c].members) {
      const slot = position.index[member];
      if (slot < 0) continue;
      sumX += position.columns.x[slot];
      sumY += position.columns.y[slot];
      count++;
    }
    if (count > 0) {
      group.centerX = sumX / count;
      group.centerY = sumY / count;
    }
  }

  // --- 4. Membership: per-agent utility decisions -----------------------------
  const joinThreshold = groupConfig.joinThreshold;
  const leaveThreshold = groupConfig.leaveThreshold;
  const maxDistance = groupConfig.maxMemberDistanceTiles;

  // Leave-utility check for one member against its (frozen) group. Returns
  // true (and applies the leave) when the member's bonds, distance, crowding
  // or cohesion cross the leave threshold.
  const considerLeaving = (entity: EntityId, socialSlot: number, group: GroupRecord, memberSet: ReadonlySet<EntityId>): boolean => {
    const posSlot = position.index[entity];
    const dx = posSlot >= 0 ? position.columns.x[posSlot] - group.centerX : 0;
    const dy = posSlot >= 0 ? position.columns.y[posSlot] - group.centerY : 0;
    const leaveUtility = groupLeaveUtility({
      averageScoreToMembers: averageScoreTowardMembers(ecs, entity, memberSet),
      distanceToCenter: Math.sqrt(dx * dx + dy * dy),
      maxDistance,
      memberCount: group.members.length,
      preferredSize: groupConfig.preferredSize,
      cohesion: group.cohesion,
    });
    if (leaveUtility < leaveThreshold) return false;
    groups.removeMember(entity, group.id);
    socialStore.columns.groupId[socialSlot] = -1;
    return true;
  };

  for (let k = 0; k < aliveCount; k++) {
    const entity = scratch.compactEntities[k];
    const socialSlot = socialStore.index[entity];
    if (socialSlot < 0) continue;
    const clusterIndex = clusterOfEntity.get(entity);
    const targetGroupId = clusterIndex === undefined ? null : clusterGroupId[clusterIndex];
    const currentGroupId = socialStore.columns.groupId[socialSlot];

    // Leaving first. Membership is utility-gated: a member leaves when its
    // own bonds/distance/crowding/cohesion cross the leave threshold, or when
    // it now belongs to a different detected community. Missing a single
    // cluster detection (temporary foraging dispersal) never ejects anyone —
    // group identity survives dispersal-and-reconverge cycles.
    let leftGroupId = -1;
    let leaveReason = '';
    if (currentGroupId >= 0) {
      const group = groups.get(currentGroupId);
      if (!group) {
        socialStore.columns.groupId[socialSlot] = -1; // stale reference guard
      } else if (targetGroupId === currentGroupId) {
        const memberSet = frozenMembers.get(currentGroupId)!;
        if (considerLeaving(entity, socialSlot, group, memberSet)) {
          leftGroupId = currentGroupId;
          leaveReason = `bonds weakened in group #${currentGroupId}`;
        }
      } else if (targetGroupId !== null) {
        // The agent's detected community continues as a different group:
        // transfer out (the join step below may immediately re-seat it).
        groups.removeMember(entity, currentGroupId);
        socialStore.columns.groupId[socialSlot] = -1;
        leftGroupId = currentGroupId;
        leaveReason = `moved on from group #${currentGroupId}`;
      } else {
        // No detected community around this agent this run: stay unless the
        // leave utility (sustained drift, decayed bonds, crowding) fires.
        const memberSet = frozenMembers.get(currentGroupId)!;
        if (considerLeaving(entity, socialSlot, group, memberSet)) {
          leftGroupId = currentGroupId;
          leaveReason = `drifted from group #${currentGroupId}`;
        }
      }
    }

    // Joining the community's group (if any). An agent that just left that
    // exact group does not re-join in the same run.
    if (
      targetGroupId !== null &&
      targetGroupId !== leftGroupId &&
      socialStore.columns.groupId[socialSlot] !== targetGroupId
    ) {
      const group = groups.get(targetGroupId);
      if (group) {
        // Relationship input: the group's frozen members for continuing
        // groups, the founding cluster for brand-new groups.
        const isNew = group.stableRuns === 0 && group.members.length === 0;
        const relationshipSet =
          isNew && clusterIndex !== undefined
            ? new Set(clusters[clusterIndex].members)
            : frozenMembers.get(targetGroupId) ?? new Set(group.members);
        const genomeSlot = ecs.genome.index[entity];
        const socialTendency = genomeSlot >= 0 ? ecs.genome.columns.socialTendency[genomeSlot] : 0.5;
        const posSlot = position.index[entity];
        const dx = posSlot >= 0 ? position.columns.x[posSlot] - group.centerX : 0;
        const dy = posSlot >= 0 ? position.columns.y[posSlot] - group.centerY : 0;
        const joinUtility = groupJoinUtility({
          socialTendency,
          loneliness: socialStore.columns.loneliness[socialSlot],
          averageScoreToMembers: averageScoreTowardMembers(ecs, entity, relationshipSet),
          stableRuns: group.stableRuns,
          distanceToCenterSquared: dx * dx + dy * dy,
          maxDistance,
        });
        if (joinUtility >= joinThreshold) {
          group.members.push(entity);
          socialStore.columns.groupId[socialSlot] = group.id;
          socialStore.columns.groupJoinTick[socialSlot] = tick;
          const fromDetail = leftGroupId >= 0 ? ` (from group #${leftGroupId})` : '';
          events.record('group_joined', {
            entityId: entity,
            groupId: group.id,
            detail: `joined group #${group.id}${fromDetail}`,
          });
          leftGroupId = -1; // transfer — the leave event is suppressed
        }
      }
    }

    if (leftGroupId >= 0) {
      events.record('group_left', { entityId: entity, groupId: leftGroupId, detail: leaveReason });
    }
  }

  // --- 5. Refresh stats, remove empty groups, swap pending signatures --------
  for (const group of [...groups.groups]) {
    if (group.members.length === 0) {
      groups.remove(group.id);
      continue;
    }
    if (group.members.length === 1) {
      // A single survivor is not a community: the lone member leaves and the
      // group winds down (members die or drift out until only one remains).
      const lone = group.members[0];
      const loneSlot = socialStore.index[lone];
      groups.removeMember(lone, group.id);
      if (loneSlot >= 0) socialStore.columns.groupId[loneSlot] = -1;
      events.record('group_left', {
        entityId: lone,
        groupId: group.id,
        detail: `group #${group.id} shrank below a viable size`,
      });
      groups.remove(group.id);
      continue;
    }
    refreshGroupStats(group, ctx);
  }
  groups.pendingSignatures.clear();
  for (const signature of nextPending) groups.pendingSignatures.add(signature);
}
