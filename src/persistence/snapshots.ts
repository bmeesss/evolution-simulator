/**
 * Simulation snapshots: the ONLY shape in which simulation state reaches the
 * main thread each frame.
 *
 * Design goals (see ARCHITECTURE.md "Message flow"):
 *   - compact: typed arrays, only fields the renderer/UI need per frame
 *   - versioned: `formatVersion` lets later phases evolve/compact the format
 *     without breaking older consumers
 *   - buildable in O(population) with one small allocation per snapshot —
 *     snapshots are produced at a bounded rate, not per tick
 *
 * Detailed per-agent inspection (including AI utility scores, memory, lineage
 * and gene origins) uses `buildAgentDetails` on demand for ONE agent, which
 * keeps the per-frame snapshot small even with thousands of agents. Full AI
 * internals are never sent for every agent every frame.
 */

import type { Simulation } from '../simulation-core';
import type { EntityId } from '../simulation-core';
import { intentName, ResourceType, ACTION_NAMES } from '../simulation-core';
import { GENOME_KEYS } from '../simulation-core/genetics';
import type { GenomeValues } from '../simulation-core/genetics';
import { lifeStageForAge, lifeStageName } from '../simulation-core/simulation/life-stages';
import type { SimulationEvent } from '../simulation-core';

/** Bump when the snapshot layout changes incompatibly. */
export const SNAPSHOT_FORMAT_VERSION = 4;

/** Number of bins used for trait distributions (each covers 1/BIN_COUNT of [0,1]). */
export const TRAIT_DISTRIBUTION_BINS = 10;

/**
 * aiState columns in ActionKind order — the "Action | Utility" debug table is
 * built from these. MUST stay aligned with ACTION_NAMES (ai/actions).
 */
const AI_UTILITY_COLUMNS: ReadonlyArray<
  'rest' | 'wander' | 'seekFood' | 'seekWater' | 'eat' | 'drink' | 'seekPartner' | 'socialize' | 'help' | 'cooperate' | 'avoid' | 'confront'
> = [
  'rest',
  'wander',
  'seekFood',
  'seekWater',
  'eat',
  'drink',
  'seekPartner',
  'socialize',
  'help',
  'cooperate',
  'avoid',
  'confront',
];

/** How long a conflict remains visible as a red flash (ticks). */
export const CONFLICT_FLASH_TICKS = 24;

/** Maximum groups listed individually in a snapshot (aggregates cover all). */
export const MAX_GROUPS_IN_SNAPSHOT = 24;

/** Per-frame agent data for rendering (SoA, structured-clone friendly). */
export interface AgentVisualSnapshot {
  readonly ids: Uint32Array;
  readonly x: Float32Array;
  readonly y: Float32Array;
  /** Genome strength — drives rendered agent size (see rendering/agent-visuals). */
  readonly strength: Float32Array;
  /** Genome intelligence — drives rendered agent hue (see rendering/agent-visuals). */
  readonly intelligence: Float32Array;
  /** Genome speed — drives a secondary rendered ring (see rendering/agent-visuals). */
  readonly speed: Float32Array;
  /** Current intent kind (AgentIntent values) — drives the state indicator. */
  readonly intentKind: Uint8Array;
  /** Emergent group id per agent (-1 = ungrouped) — drives the group ring. */
  readonly groupId: Int32Array;
  /** Cooperation-session partner per agent (-1 = none) — draws the bond link. */
  readonly cooperationTarget: Int32Array;
  /** 1 while a recent conflict should still flash red. */
  readonly conflictFlash: Uint8Array;
}

export interface SimulationAverages {
  readonly intelligence: number;
  readonly strength: number;
  readonly speed: number;
  readonly fertility: number;
  readonly socialTendency: number;
  readonly age: number;
  readonly hunger: number;
  readonly thirst: number;
  readonly energy: number;
  readonly health: number;
}

/** Coarse resource availability (averages over all tiles, 0..1). */
export interface ResourceAvailability {
  readonly food: number;
  readonly water: number;
}

/** Trait distributions (histograms) over the current population, in [0, 1]. */
export interface TraitDistribution {
  readonly intelligence: readonly number[];
  readonly strength: readonly number[];
  readonly speed: readonly number[];
  readonly fertility: readonly number[];
}

export interface SimulationSnapshot {
  readonly formatVersion: number;
  readonly tick: number;
  readonly timeHours: number;
  readonly population: number;
  /** Cumulative deaths since the run started. */
  readonly deaths: number;
  /** Cumulative births (children created) since the run started. */
  readonly births: number;
  /** Cumulative reproduction successes (== births: one child per success). */
  readonly reproductionSuccesses: number;
  /** Highest generation among currently alive agents. */
  readonly maxGeneration: number;
  readonly averages: SimulationAverages;
  readonly resources: ResourceAvailability;
  readonly distributions: TraitDistribution;
  readonly agents: AgentVisualSnapshot;
  /** Social statistics (Phase 4). */
  readonly social: SocialSnapshotStats;
  /** Emergent group summary (Phase 4). */
  readonly groups: GroupsSnapshot;
}

/** Global social statistics derived from live state (Phase 4). */
export interface SocialSnapshotStats {
  /** Number of stored (directed) relationships. */
  readonly activeRelationships: number;
  /** Mean relationship score over all entries (−1..1). */
  readonly averageRelationshipScore: number;
  /** Mean trust over all entries (0..1). */
  readonly averageTrust: number;
  /** Cumulative counters (persisted simulation state). */
  readonly helpEvents: number;
  readonly cooperationEvents: number;
  readonly conflictEvents: number;
}

/** One group row in the snapshot (aggregates cover groups beyond the cap). */
export interface GroupSnapshotEntry {
  readonly id: number;
  readonly memberCount: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly radius: number;
  readonly cohesion: number;
  readonly createdTick: number;
  /** Split lineage: parent group id (-1 spontaneous) and generation depth. */
  readonly parentId: number;
  readonly generation: number;
}

export interface GroupsSnapshot {
  readonly count: number;
  readonly largestSize: number;
  /** Smallest size among groups that survived >= 2 detection runs. */
  readonly smallestStableSize: number;
  readonly averageSize: number;
  /** Alive agents not in any group. */
  readonly isolatedAgents: number;
  readonly averageCohesion: number;
  /** Largest groups first (tie: lower id), capped at MAX_GROUPS_IN_SNAPSHOT. */
  readonly list: readonly GroupSnapshotEntry[];
}

/** A remembered location, as shown in the agent inspector. */
export interface AgentMemoryEntryDetails {
  readonly x: number;
  readonly y: number;
  readonly value: number;
  readonly lastObservedTick: number;
}

/** One row of the selected agent's "Action | Utility" debug table. */
export interface AiUtilityEntry {
  readonly action: string;
  readonly utility: number;
}

/** Per-gene lineage/origin detail for the selected-agent inspector. */
export interface GeneOrigin {
  readonly gene: keyof GenomeValues;
  readonly value: number;
  /** Parent A's allele for this gene, or null when unknown (parent dead/founder). */
  readonly parentA: number | null;
  /** Parent B's allele for this gene, or null when unknown (parent dead/founder). */
  readonly parentB: number | null;
  /** How the value was derived: founding generation, inherited from A/B, or mutated. */
  readonly source: 'founding' | 'a' | 'b' | 'mutation';
}

/** Full inspection data for one agent (selected-agent panel). */
export interface AgentDetails {
  readonly entityId: EntityId;
  readonly x: number;
  readonly y: number;
  readonly ageHours: number;
  readonly lifeStage: string;
  readonly health: number;
  readonly hunger: number;
  readonly thirst: number;
  readonly energy: number;
  readonly intelligence: number;
  readonly strength: number;
  readonly speed: number;
  readonly fertility: number;
  readonly socialTendency: number;
  readonly intent: string;
  readonly targetX: number;
  readonly targetY: number;
  readonly generation: number;
  readonly parentA: number;
  readonly parentB: number;
  readonly sex: number;
  readonly reproductionEligible: boolean;
  readonly reproductionCooldownHours: number;
  readonly genomeOrigins: readonly GeneOrigin[];
  readonly memoryFood: readonly AgentMemoryEntryDetails[];
  readonly memoryWater: readonly AgentMemoryEntryDetails[];
  /** Base utility scores from the last AI pass (dev-only debugging). */
  readonly aiUtilities: readonly AiUtilityEntry[];
  /** Phase 4 — social inspection. */
  readonly loneliness: number;
  readonly groupId: number;
  readonly groupCohesion: number;
  readonly groupAgeTicks: number;
  /** Members of the agent's group (including itself), 0 when ungrouped. */
  readonly groupMemberCount: number;
  readonly cooperationPartner: number;
  readonly cooperationProgress: number;
  readonly cooperationDuration: number;
  readonly forageBonusActive: boolean;
  /** Strongest remembered relationships (by familiarity + |score|), bounded. */
  readonly relationships: readonly AgentRelationshipDetails[];
}

/** One remembered relationship, as shown in the agent inspector. */
export interface AgentRelationshipDetails {
  readonly target: number;
  readonly score: number;
  readonly trust: number;
  readonly familiarity: number;
  readonly kin: boolean;
  readonly positiveCount: number;
  readonly negativeCount: number;
  readonly lastInteractionTick: number;
  /** True when the remembered agent is still alive. */
  readonly alive: boolean;
}

/** How many relationships the inspector lists (bounded, top-N only). */
export const MAX_INSPECTOR_RELATIONSHIPS = 6;

/** Full inspection data for one group (Phase 4, built on demand). */
export interface GroupDetails {
  readonly id: number;
  readonly memberCount: number;
  /** Member entity ids, ascending (groups are small). */
  readonly members: readonly number[];
  readonly centerX: number;
  readonly centerY: number;
  readonly radius: number;
  readonly cohesion: number;
  readonly createdTick: number;
  readonly parentId: number;
  readonly generation: number;
  readonly stableRuns: number;
  readonly foodAccess: number;
  readonly waterAccess: number;
  readonly averageTraits: Readonly<Record<keyof GenomeValues, number>>;
  /** Strongest intra-group relationships (top-N by score). */
  readonly topRelationships: readonly GroupRelationshipDetails[];
  /** Recent group-relevant events from the bounded log. */
  readonly recentEvents: readonly SimulationEvent[];
}

/** One intra-group relationship row in the group inspector. */
export interface GroupRelationshipDetails {
  readonly a: number;
  readonly b: number;
  readonly score: number;
  readonly trust: number;
  readonly familiarity: number;
  readonly kin: boolean;
}

/** How many intra-group relationships the inspector lists. */
export const MAX_INSPECTOR_GROUP_RELATIONSHIPS = 8;

/** How many recent events the group inspector lists. */
export const MAX_INSPECTOR_GROUP_EVENTS = 10;

function emptyDistribution(): number[] {
  return new Array<number>(TRAIT_DISTRIBUTION_BINS).fill(0);
}

/** Bin index for a [0,1) trait (1.0 clamps into the top bin). */
function binFor(value: number): number {
  const bin = Math.floor(value * TRAIT_DISTRIBUTION_BINS);
  return bin >= TRAIT_DISTRIBUTION_BINS ? TRAIT_DISTRIBUTION_BINS - 1 : bin < 0 ? 0 : bin;
}

/** Build a per-frame snapshot of the simulation. */
export function buildSimulationSnapshot(sim: Simulation): SimulationSnapshot {
  const position = sim.ecs.position;
  const needs = sim.ecs.needs;
  const health = sim.ecs.health;
  const genome = sim.ecs.genome;
  const intent = sim.ecs.intent;
  const age = sim.ecs.age;
  const lineage = sim.ecs.lineage;
  const socialStore = sim.ecs.social;
  const relationships = sim.ecs.relationships;
  const count = position.count;

  const ids = new Uint32Array(count);
  const x = new Float32Array(count);
  const y = new Float32Array(count);
  const strength = new Float32Array(count);
  const intelligence = new Float32Array(count);
  const speed = new Float32Array(count);
  const intentKind = new Uint8Array(count);
  const groupId = new Int32Array(count);
  const cooperationTarget = new Int32Array(count);
  const conflictFlash = new Uint8Array(count);

  const distIntelligence = emptyDistribution();
  const distStrength = emptyDistribution();
  const distSpeed = emptyDistribution();
  const distFertility = emptyDistribution();

  let intelligenceSum = 0;
  let strengthSum = 0;
  let speedSum = 0;
  let fertilitySum = 0;
  let socialSum = 0;
  let hungerSum = 0;
  let thirstSum = 0;
  let energySum = 0;
  let healthSum = 0;
  let ageSum = 0;
  let maxGeneration = 0;
  let isolatedAgents = 0;

  for (let i = 0; i < count; i++) {
    const entity = position.entityOf[i];
    ids[i] = entity;
    x[i] = position.columns.x[i];
    y[i] = position.columns.y[i];
    const genomeSlot = genome.index[entity];
    if (genomeSlot >= 0) {
      intelligence[i] = genome.columns.intelligence[genomeSlot];
      strength[i] = genome.columns.strength[genomeSlot];
      speed[i] = genome.columns.speed[genomeSlot];
      intelligenceSum += intelligence[i];
      strengthSum += strength[i];
      speedSum += speed[i];
      fertilitySum += genome.columns.fertility[genomeSlot];
      socialSum += genome.columns.socialTendency[genomeSlot];
      distIntelligence[binFor(intelligence[i])]++;
      distStrength[binFor(strength[i])]++;
      distSpeed[binFor(speed[i])]++;
      distFertility[binFor(genome.columns.fertility[genomeSlot])]++;
    }
    const needsSlot = needs.index[entity];
    if (needsSlot >= 0) {
      hungerSum += needs.columns.hunger[needsSlot];
      thirstSum += needs.columns.thirst[needsSlot];
      energySum += needs.columns.energy[needsSlot];
    }
    const healthSlot = health.index[entity];
    if (healthSlot >= 0) healthSum += health.columns.current[healthSlot];
    const ageSlot = age.index[entity];
    if (ageSlot >= 0) ageSum += age.columns.ageHours[ageSlot];
    const lineageSlot = lineage.index[entity];
    if (lineageSlot >= 0 && lineage.columns.generation[lineageSlot] > maxGeneration) {
      maxGeneration = lineage.columns.generation[lineageSlot];
    }
    const intentSlot = intent.index[entity];
    intentKind[i] = intentSlot >= 0 ? intent.columns.kind[intentSlot] : 0;
    // Social columns (agent without a social component renders as ungrouped).
    const socialSlot = socialStore.index[entity];
    if (socialSlot >= 0) {
      const group = socialStore.columns.groupId[socialSlot];
      groupId[i] = group;
      if (group < 0) isolatedAgents++;
      cooperationTarget[i] = socialStore.columns.cooperationTarget[socialSlot];
      conflictFlash[i] =
        socialStore.columns.lastConflictTick[socialSlot] > 0 &&
        sim.tick - socialStore.columns.lastConflictTick[socialSlot] < CONFLICT_FLASH_TICKS
          ? 1
          : 0;
    } else {
      groupId[i] = -1;
      cooperationTarget[i] = -1;
      isolatedAgents++;
    }
  }

  const averages: SimulationAverages =
    count > 0
      ? {
          intelligence: intelligenceSum / count,
          strength: strengthSum / count,
          speed: speedSum / count,
          fertility: fertilitySum / count,
          socialTendency: socialSum / count,
          age: ageSum / count,
          hunger: hungerSum / count,
          thirst: thirstSum / count,
          energy: energySum / count,
          health: healthSum / count,
        }
      : {
          intelligence: 0,
          strength: 0,
          speed: 0,
          fertility: 0,
          socialTendency: 0,
          age: 0,
          hunger: 0,
          thirst: 0,
          energy: 0,
          health: 0,
        };

  // Resource availability: average food/water across all tiles.
  let foodSum = 0;
  let waterSum = 0;
  const worldSize = sim.world.size;
  for (let i = 0; i < worldSize; i++) {
    foodSum += sim.world.food[i];
    waterSum += sim.world.water[i];
  }
  const resources: ResourceAvailability =
    worldSize > 0 ? { food: foodSum / worldSize, water: waterSum / worldSize } : { food: 0, water: 0 };

  // Social statistics: derived from the live relationship store + counters.
  // Walks chains directly (no serialization, no per-entry objects).
  let relationshipCount = 0;
  let scoreSum = 0;
  let trustSum = 0;
  const aliveIds = sim.ecs.entities.aliveIds;
  const aliveCount = sim.ecs.entities.aliveCount;
  for (let k = 0; k < aliveCount; k++) {
    const entity = aliveIds[k];
    for (let e = relationships.headOf(entity); e !== -1; e = relationships.nextOf(e)) {
      relationshipCount++;
      scoreSum += relationships.scoreOf(e);
      trustSum += relationships.trustOf(e);
    }
  }
  const social: SocialSnapshotStats = {
    activeRelationships: relationshipCount,
    averageRelationshipScore: relationshipCount === 0 ? 0 : scoreSum / relationshipCount,
    averageTrust: relationshipCount === 0 ? 0 : trustSum / relationshipCount,
    helpEvents: sim.socialStats.helpEvents,
    cooperationEvents: sim.socialStats.cooperationEvents,
    conflictEvents: sim.socialStats.conflictEvents,
  };

  // Group summary: aggregates over every group, list of the largest ones.
  const allGroups = sim.groups.groups;
  let largestSize = 0;
  let smallestStableSize = Number.POSITIVE_INFINITY;
  let sizeSum = 0;
  let cohesionSum = 0;
  for (const group of allGroups) {
    sizeSum += group.members.length;
    if (group.members.length > largestSize) largestSize = group.members.length;
    if (group.stableRuns >= 2 && group.members.length < smallestStableSize) {
      smallestStableSize = group.members.length;
    }
    cohesionSum += group.cohesion;
  }
  const listed = [...allGroups]
    .sort((a, b) => b.members.length - a.members.length || a.id - b.id)
    .slice(0, MAX_GROUPS_IN_SNAPSHOT)
    .map((group) => ({
      id: group.id,
      memberCount: group.members.length,
      centerX: group.centerX,
      centerY: group.centerY,
      radius: group.radius,
      cohesion: group.cohesion,
      createdTick: group.createdTick,
      parentId: group.parentId,
      generation: group.generation,
    }));
  const groups: GroupsSnapshot = {
    count: allGroups.length,
    largestSize,
    smallestStableSize: smallestStableSize === Number.POSITIVE_INFINITY ? 0 : smallestStableSize,
    averageSize: allGroups.length === 0 ? 0 : sizeSum / allGroups.length,
    isolatedAgents,
    averageCohesion: allGroups.length === 0 ? 0 : cohesionSum / allGroups.length,
    list: listed,
  };

  return {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    tick: sim.tick,
    timeHours: sim.timeHours,
    population: sim.population,
    deaths: sim.deathCount,
    births: sim.birthCount,
    reproductionSuccesses: sim.birthCount,
    maxGeneration,
    averages,
    resources,
    distributions: {
      intelligence: distIntelligence,
      strength: distStrength,
      speed: distSpeed,
      fertility: distFertility,
    },
    agents: { ids, x, y, strength, intelligence, speed, intentKind, groupId, cooperationTarget, conflictFlash },
    social,
    groups,
  };
}

/** Read a genome's values, or null when the entity has no genome (dead/founder?). */
function genomeValuesOf(sim: Simulation, entity: EntityId): GenomeValues | null {
  const slot = sim.ecs.genome.index[entity];
  if (slot < 0) return null;
  const g = sim.ecs.genome.columns;
  return {
    intelligence: g.intelligence[slot],
    strength: g.strength[slot],
    speed: g.speed[slot],
    fertility: g.fertility[slot],
    socialTendency: g.socialTendency[slot],
  };
}

/** Extract full details for one agent, or null if the entity does not exist. */
export function buildAgentDetails(sim: Simulation, entityId: EntityId): AgentDetails | null {
  const ecs = sim.ecs;
  if (!ecs.entities.isAlive(entityId)) return null;

  const positionSlot = ecs.position.index[entityId];
  const needsSlot = ecs.needs.index[entityId];
  const ageSlot = ecs.age.index[entityId];
  const healthSlot = ecs.health.index[entityId];
  const genomeSlot = ecs.genome.index[entityId];
  const intentSlot = ecs.intent.index[entityId];
  const aiSlot = ecs.aiState.index[entityId];
  const lineageSlot = ecs.lineage.index[entityId];
  const reproSlot = ecs.reproductive.index[entityId];
  const socialSlot = ecs.social.index[entityId];
  if (
    positionSlot < 0 ||
    needsSlot < 0 ||
    ageSlot < 0 ||
    healthSlot < 0 ||
    genomeSlot < 0 ||
    intentSlot < 0 ||
    lineageSlot < 0 ||
    reproSlot < 0 ||
    socialSlot < 0
  ) {
    return null;
  }

  const memoryFood: AgentMemoryEntryDetails[] = [];
  const memoryWater: AgentMemoryEntryDetails[] = [];
  for (let e = ecs.memory.headOf(entityId); e !== -1; e = ecs.memory.nextOf(e)) {
    const entry: AgentMemoryEntryDetails = {
      x: ecs.memory.entryX(e),
      y: ecs.memory.entryY(e),
      value: ecs.memory.entryValue(e),
      lastObservedTick: ecs.memory.entryLastObservedTick(e),
    };
    if (ecs.memory.entryResourceType(e) === ResourceType.Food) memoryFood.push(entry);
    else memoryWater.push(entry);
  }

  const aiUtilities: AiUtilityEntry[] =
    aiSlot >= 0
      ? AI_UTILITY_COLUMNS.map((column, index) => ({
          action: ACTION_NAMES[index],
          utility: ecs.aiState.columns[column][aiSlot],
        }))
      : [];

  // Gene origins: for each gene, classify how the child's allele was formed by
  // comparing to the (still-alive) parents' alleles. Parent values are null when
  // a parent has died (genome was detached) or is a founding agent with no parent.
  const parentA = ecs.lineage.columns.parentA[lineageSlot];
  const parentB = ecs.lineage.columns.parentB[lineageSlot];
  const selfGenome = genomeValuesOf(sim, entityId)!;
  const parentAGenome = parentA >= 0 ? genomeValuesOf(sim, parentA) : null;
  const parentBGenome = parentB >= 0 ? genomeValuesOf(sim, parentB) : null;
  const isFounding = parentA < 0 && parentB < 0;
  const genomeOrigins: GeneOrigin[] = GENOME_KEYS.map((gene) => {
    const value = selfGenome[gene];
    const aValue = parentAGenome ? parentAGenome[gene] : null;
    const bValue = parentBGenome ? parentBGenome[gene] : null;
    let source: GeneOrigin['source'] = 'founding';
    if (!isFounding) {
      if (aValue !== null && value === aValue) source = 'a';
      else if (bValue !== null && value === bValue) source = 'b';
      else source = 'mutation';
    }
    return { gene, value, parentA: aValue, parentB: bValue, source };
  });

  const generation = ecs.lineage.columns.generation[lineageSlot];
  const sex = ecs.reproductive.columns.sex[reproSlot];

  // Social inspection: strongest relationships first (familiarity + |score|),
  // bounded to MAX_INSPECTOR_RELATIONSHIPS — only for the selected agent.
  const relationships = ecs.relationships;
  const relationshipList: AgentRelationshipDetails[] = [];
  for (let e = relationships.headOf(entityId); e !== -1; e = relationships.nextOf(e)) {
    const score = relationships.scoreOf(e);
    relationshipList.push({
      target: relationships.targetOf(e),
      score,
      trust: relationships.trustOf(e),
      familiarity: relationships.familiarityOf(e),
      kin: relationships.kinOf(e),
      positiveCount: relationships.positiveCountOf(e),
      negativeCount: relationships.negativeCountOf(e),
      lastInteractionTick: relationships.lastInteractionTickOf(e),
      alive: ecs.entities.isAlive(relationships.targetOf(e)),
    });
  }
  relationshipList.sort(
    (a, b) =>
      b.familiarity + Math.abs(b.score) - (a.familiarity + Math.abs(a.score)) || a.target - b.target,
  );
  const topRelationships = relationshipList.slice(0, MAX_INSPECTOR_RELATIONSHIPS);

  const groupId = ecs.social.columns.groupId[socialSlot];
  const group = groupId >= 0 ? sim.groups.get(groupId) : null;

  return {
    entityId,
    x: ecs.position.columns.x[positionSlot],
    y: ecs.position.columns.y[positionSlot],
    ageHours: ecs.age.columns.ageHours[ageSlot],
    lifeStage: lifeStageName(lifeStageForAge(ecs.age.columns.ageHours[ageSlot], sim.config)),
    health: ecs.health.columns.current[healthSlot],
    hunger: ecs.needs.columns.hunger[needsSlot],
    thirst: ecs.needs.columns.thirst[needsSlot],
    energy: ecs.needs.columns.energy[needsSlot],
    intelligence: ecs.genome.columns.intelligence[genomeSlot],
    strength: ecs.genome.columns.strength[genomeSlot],
    speed: ecs.genome.columns.speed[genomeSlot],
    fertility: ecs.genome.columns.fertility[genomeSlot],
    socialTendency: ecs.genome.columns.socialTendency[genomeSlot],
    intent: intentName(ecs.intent.columns.kind[intentSlot]),
    targetX: ecs.intent.columns.targetX[intentSlot],
    targetY: ecs.intent.columns.targetY[intentSlot],
    generation,
    parentA,
    parentB,
    sex,
    reproductionEligible: ecs.reproductive.columns.eligible[reproSlot] === 1,
    reproductionCooldownHours: ecs.reproductive.columns.cooldownHours[reproSlot],
    genomeOrigins,
    memoryFood,
    memoryWater,
    aiUtilities,
    loneliness: ecs.social.columns.loneliness[socialSlot],
    groupId,
    groupCohesion: group ? group.cohesion : 0,
    groupAgeTicks: group ? sim.tick - group.createdTick : 0,
    groupMemberCount: group ? group.members.length : 0,
    cooperationPartner: ecs.social.columns.cooperationTarget[socialSlot],
    cooperationProgress: ecs.social.columns.cooperationTicks[socialSlot],
    cooperationDuration: sim.config.social.cooperation.durationTicks,
    forageBonusActive: ecs.social.columns.forageBonusTicks[socialSlot] > 0,
    relationships: topRelationships,
  };
}

/** Extract full details for one group, or null if it does not exist. */
export function buildGroupDetails(sim: Simulation, groupId: number): GroupDetails | null {
  const group = sim.groups.get(groupId);
  if (!group) return null;
  const ecs = sim.ecs;

  // Average traits over (alive) members.
  const traitSums: Record<keyof GenomeValues, number> = {
    intelligence: 0,
    strength: 0,
    speed: 0,
    fertility: 0,
    socialTendency: 0,
  };
  let genomeMembers = 0;
  for (const member of group.members) {
    const slot = ecs.genome.index[member];
    if (slot < 0) continue;
    genomeMembers++;
    for (const key of GENOME_KEYS) {
      traitSums[key] += ecs.genome.columns[key][slot];
    }
  }
  const averageTraits = { ...traitSums };
  if (genomeMembers > 0) {
    for (const key of GENOME_KEYS) {
      averageTraits[key] = traitSums[key] / genomeMembers;
    }
  }

  // Strongest intra-group relationships (both directions count once per pair).
  const memberSet = new Set(group.members);
  const pairs: GroupRelationshipDetails[] = [];
  for (const member of group.members) {
    for (let e = ecs.relationships.headOf(member); e !== -1; e = ecs.relationships.nextOf(e)) {
      const target = ecs.relationships.targetOf(e);
      if (!memberSet.has(target) || target <= member) continue; // each pair once
      pairs.push({
        a: member,
        b: target,
        score: ecs.relationships.scoreOf(e),
        trust: ecs.relationships.trustOf(e),
        familiarity: ecs.relationships.familiarityOf(e),
        kin: ecs.relationships.kinOf(e),
      });
    }
  }
  pairs.sort((a, b) => b.score - a.score || a.a - b.a || a.b - b.b);
  const topRelationships = pairs.slice(0, MAX_INSPECTOR_GROUP_RELATIONSHIPS);

  // Recent group-relevant events (bounded log scan, group events only).
  const recentEvents: SimulationEvent[] = [];
  for (const event of sim.events.recent(200)) {
    if (event.groupId === groupId) {
      recentEvents.push(event);
      if (recentEvents.length >= MAX_INSPECTOR_GROUP_EVENTS) break;
    }
  }

  return {
    id: group.id,
    memberCount: group.members.length,
    members: [...group.members].sort((a, b) => a - b),
    centerX: group.centerX,
    centerY: group.centerY,
    radius: group.radius,
    cohesion: group.cohesion,
    createdTick: group.createdTick,
    parentId: group.parentId,
    generation: group.generation,
    stableRuns: group.stableRuns,
    foodAccess: group.foodAccess,
    waterAccess: group.waterAccess,
    averageTraits,
    topRelationships,
    recentEvents,
  };
}
