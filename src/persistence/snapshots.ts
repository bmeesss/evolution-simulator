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
 * Detailed per-agent inspection (including AI utility scores and memory) uses
 * `buildAgentDetails` on demand for ONE agent, which keeps the per-frame
 * snapshot small even with thousands of agents. Full AI internals are never
 * sent for every agent every frame.
 */

import type { Simulation } from '../simulation-core';
import type { EntityId } from '../simulation-core';
import { intentName, ResourceType, ACTION_NAMES } from '../simulation-core';

/** Bump when the snapshot layout changes incompatibly. */
export const SNAPSHOT_FORMAT_VERSION = 2;

/** Per-frame agent data for rendering (SoA, structured-clone friendly). */
export interface AgentVisualSnapshot {
  readonly ids: Uint32Array;
  readonly x: Float32Array;
  readonly y: Float32Array;
  /** Genome strength — drives rendered agent size (see rendering/agent-visuals). */
  readonly strength: Float32Array;
  /** Genome intelligence — drives rendered agent hue (see rendering/agent-visuals). */
  readonly intelligence: Float32Array;
  /** Current intent kind (AgentIntent values) — drives the state indicator. */
  readonly intentKind: Uint8Array;
}

export interface SimulationAverages {
  readonly intelligence: number;
  readonly strength: number;
  readonly speed: number;
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

export interface SimulationSnapshot {
  readonly formatVersion: number;
  readonly tick: number;
  readonly timeHours: number;
  readonly population: number;
  /** Cumulative deaths since the run started. */
  readonly deaths: number;
  readonly averages: SimulationAverages;
  readonly resources: ResourceAvailability;
  readonly agents: AgentVisualSnapshot;
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

/** Full inspection data for one agent (selected-agent panel). */
export interface AgentDetails {
  readonly entityId: EntityId;
  readonly x: number;
  readonly y: number;
  readonly ageHours: number;
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
  readonly memoryFood: readonly AgentMemoryEntryDetails[];
  readonly memoryWater: readonly AgentMemoryEntryDetails[];
  /** Base utility scores from the last AI pass (dev-only debugging). */
  readonly aiUtilities: readonly AiUtilityEntry[];
}

/** Build a per-frame snapshot of the simulation. */
export function buildSimulationSnapshot(sim: Simulation): SimulationSnapshot {
  const position = sim.ecs.position;
  const needs = sim.ecs.needs;
  const health = sim.ecs.health;
  const genome = sim.ecs.genome;
  const intent = sim.ecs.intent;
  const count = position.count;

  const ids = new Uint32Array(count);
  const x = new Float32Array(count);
  const y = new Float32Array(count);
  const strength = new Float32Array(count);
  const intelligence = new Float32Array(count);
  const intentKind = new Uint8Array(count);

  let intelligenceSum = 0;
  let strengthSum = 0;
  let speedSum = 0;
  let hungerSum = 0;
  let thirstSum = 0;
  let energySum = 0;
  let healthSum = 0;

  for (let i = 0; i < count; i++) {
    const entity = position.entityOf[i];
    ids[i] = entity;
    x[i] = position.columns.x[i];
    y[i] = position.columns.y[i];
    const genomeSlot = genome.index[entity];
    if (genomeSlot >= 0) {
      intelligence[i] = genome.columns.intelligence[genomeSlot];
      strength[i] = genome.columns.strength[genomeSlot];
      intelligenceSum += intelligence[i];
      strengthSum += strength[i];
      speedSum += genome.columns.speed[genomeSlot];
    }
    const needsSlot = needs.index[entity];
    if (needsSlot >= 0) {
      hungerSum += needs.columns.hunger[needsSlot];
      thirstSum += needs.columns.thirst[needsSlot];
      energySum += needs.columns.energy[needsSlot];
    }
    const healthSlot = health.index[entity];
    if (healthSlot >= 0) healthSum += health.columns.current[healthSlot];
    const intentSlot = intent.index[entity];
    intentKind[i] = intentSlot >= 0 ? intent.columns.kind[intentSlot] : 0;
  }

  const averages: SimulationAverages =
    count > 0
      ? {
          intelligence: intelligenceSum / count,
          strength: strengthSum / count,
          speed: speedSum / count,
          hunger: hungerSum / count,
          thirst: thirstSum / count,
          energy: energySum / count,
          health: healthSum / count,
        }
      : { intelligence: 0, strength: 0, speed: 0, hunger: 0, thirst: 0, energy: 0, health: 0 };

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

  return {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    tick: sim.tick,
    timeHours: sim.timeHours,
    population: sim.population,
    deaths: sim.deathCount,
    averages,
    resources,
    agents: { ids, x, y, strength, intelligence, intentKind },
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
  if (
    positionSlot < 0 ||
    needsSlot < 0 ||
    ageSlot < 0 ||
    healthSlot < 0 ||
    genomeSlot < 0 ||
    intentSlot < 0
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

  const aiUtilities: AiUtilityEntry[] = aiSlot >= 0
    ? [
        { action: ACTION_NAMES[0], utility: ecs.aiState.columns.rest[aiSlot] },
        { action: ACTION_NAMES[1], utility: ecs.aiState.columns.wander[aiSlot] },
        { action: ACTION_NAMES[2], utility: ecs.aiState.columns.seekFood[aiSlot] },
        { action: ACTION_NAMES[3], utility: ecs.aiState.columns.seekWater[aiSlot] },
        { action: ACTION_NAMES[4], utility: ecs.aiState.columns.eat[aiSlot] },
        { action: ACTION_NAMES[5], utility: ecs.aiState.columns.drink[aiSlot] },
      ]
    : [];

  return {
    entityId,
    x: ecs.position.columns.x[positionSlot],
    y: ecs.position.columns.y[positionSlot],
    ageHours: ecs.age.columns.ageHours[ageSlot],
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
    memoryFood,
    memoryWater,
    aiUtilities,
  };
}
