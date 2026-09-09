/**
 * Simulation snapshots: the ONLY shape in which simulation state reaches the
 * main thread each frame.
 *
 * Design goals (see ARCHITECTURE.md "Message flow"):
 *   - compact: typed arrays, only fields the renderer/UI need per frame
 *   - versioned: `formatVersion` lets later phases evolve/compact the format
 *     (e.g. delta snapshots) without breaking older consumers
 *   - buildable in O(population) with one small allocation per snapshot —
 *     snapshots are produced at a bounded rate, not per tick
 *
 * Detailed per-agent inspection uses `buildAgentDetails` on demand (one agent),
 * which keeps the per-frame snapshot small even with thousands of agents.
 */

import type { Simulation } from '../simulation-core';
import type { EntityId } from '../simulation-core';
import { intentName } from '../simulation-core';

/** Bump when the snapshot layout changes incompatibly. */
export const SNAPSHOT_FORMAT_VERSION = 1;

/** Per-frame agent data for rendering (SoA, structured-clone friendly). */
export interface AgentVisualSnapshot {
  readonly ids: Uint32Array;
  readonly x: Float32Array;
  readonly y: Float32Array;
  /** Genome strength — drives rendered agent size (see rendering/agent-visuals). */
  readonly strength: Float32Array;
  /** Genome intelligence — drives rendered agent hue (see rendering/agent-visuals). */
  readonly intelligence: Float32Array;
}

export interface SimulationAverages {
  readonly intelligence: number;
  readonly strength: number;
  readonly speed: number;
}

export interface SimulationSnapshot {
  readonly formatVersion: number;
  readonly tick: number;
  readonly timeHours: number;
  readonly population: number;
  readonly averages: SimulationAverages;
  readonly agents: AgentVisualSnapshot;
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
  readonly intent: 'rest' | 'wander';
}

/** Build a per-frame snapshot of the simulation. */
export function buildSimulationSnapshot(sim: Simulation): SimulationSnapshot {
  const position = sim.ecs.position;
  const genome = sim.ecs.genome;
  const count = position.count;

  const ids = new Uint32Array(count);
  const x = new Float32Array(count);
  const y = new Float32Array(count);
  const strength = new Float32Array(count);
  const intelligence = new Float32Array(count);

  let intelligenceSum = 0;
  let strengthSum = 0;
  let speedSum = 0;

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
  }

  const averages: SimulationAverages =
    count > 0
      ? {
          intelligence: intelligenceSum / count,
          strength: strengthSum / count,
          speed: speedSum / count,
        }
      : { intelligence: 0, strength: 0, speed: 0 };

  return {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    tick: sim.tick,
    timeHours: sim.timeHours,
    population: sim.population,
    averages,
    agents: { ids, x, y, strength, intelligence },
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
  };
}
