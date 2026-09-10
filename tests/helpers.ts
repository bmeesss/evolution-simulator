/**
 * Shared helpers for phase-2+ system-level tests.
 *
 * Systems are plain `(ctx: TickContext) => void` functions, so they can be
 * exercised in isolation with a hand-built context — no full Simulation run
 * required. `makeContext` builds a minimal context and `spawnAgent` attaches a
 * single fully-formed agent to it.
 */

import { SimulationEcs } from '../src/simulation-core/ecs';
import type { EntityId } from '../src/simulation-core/ecs';
import { createWorld } from '../src/simulation-core/world';
import type { World } from '../src/simulation-core/world';
import { Rng } from '../src/simulation-core/rng';
import { EventLog } from '../src/simulation-core/events';
import { ResourceIndex, AgentIndex } from '../src/simulation-core/ai/perception';
import { AgentIntent } from '../src/simulation-core/ai/intents';
import { GroupRegistry, createSocialStats } from '../src/simulation-core/social';
import { cloneConfig, DEFAULT_SIMULATION_CONFIG } from '../src/simulation-core/simulation/config';
import type { SimulationConfig } from '../src/simulation-core/simulation/config';
import type { TickContext } from '../src/simulation-core/simulation/tick-context';

export interface MiniContext {
  ctx: TickContext;
  config: SimulationConfig;
  world: World;
  ecs: SimulationEcs;
  events: EventLog;
  groups: GroupRegistry;
}

export function makeContext(seed = 1, worldSize = 24): MiniContext {
  const config = cloneConfig(DEFAULT_SIMULATION_CONFIG);
  config.world.width = worldSize;
  config.world.height = worldSize;
  const world = createWorld(seed, config.world);
  const ecs = new SimulationEcs(config.memory.capacity, config.social.memory.capacity);
  const events = new EventLog(() => ({ tick: 0, timeHours: 0 }));
  const groups = new GroupRegistry();
  const ctx: TickContext = {
    ecs,
    world,
    config,
    events,
    rng: Rng.fromSeed(seed),
    aiRng: Rng.fromSeed(seed + 1),
    reproRng: Rng.fromSeed(seed + 2),
    resourceIndex: new ResourceIndex(world.width, world.height, config.ai.perceptionRadiusTiles),
    agentIndex: new AgentIndex(world.width, world.height, config.reproduction.partnerSeekRadiusTiles),
    socialIndex: new AgentIndex(world.width, world.height, config.social.perception.radiusTiles),
    groups,
    socialStats: createSocialStats(),
    dtHours: config.time.hoursPerTick,
    tick: 0,
  };
  return { ctx, config, world, ecs, events, groups };
}

export interface AgentFixture {
  hunger?: number;
  thirst?: number;
  energy?: number;
  health?: number;
  intelligence?: number;
  strength?: number;
  speed?: number;
  fertility?: number;
  socialTendency?: number;
  intent?: number;
  targetX?: number;
  targetY?: number;
  targetEntity?: number;
  ageHours?: number;
  // Lineage defaults to a founding agent (generation 0, no parents).
  generation?: number;
  parentA?: number;
  parentB?: number;
  // Reproductive defaults to sex 0 (off) / cooldown 0 / eligibility off.
  sex?: number;
  cooldownHours?: number;
  eligible?: boolean;
  // Social defaults: ungrouped, content, no cooperation session.
  loneliness?: number;
  groupId?: number;
  cooperationTarget?: number;
  cooperationTicks?: number;
  forageBonusTicks?: number;
  lastConflictTick?: number;
}

export function spawnAgent(
  mini: MiniContext,
  x: number,
  y: number,
  fixture: AgentFixture = {},
): EntityId {
  const { ecs } = mini;
  const entity = ecs.entities.create();
  ecs.position.attach(entity, { x, y });
  ecs.needs.attach(entity, {
    hunger: fixture.hunger ?? 0,
    thirst: fixture.thirst ?? 0,
    energy: fixture.energy ?? 100,
  });
  ecs.age.attach(entity, { ageHours: fixture.ageHours ?? 0 });
  ecs.health.attach(entity, { current: fixture.health ?? 100 });
  ecs.genome.attach(entity, {
    intelligence: fixture.intelligence ?? 0.5,
    strength: fixture.strength ?? 0.5,
    speed: fixture.speed ?? 0.5,
    fertility: fixture.fertility ?? 0.5,
    socialTendency: fixture.socialTendency ?? 0.5,
  });
  ecs.lineage.attach(entity, {
    generation: fixture.generation ?? 0,
    parentA: fixture.parentA ?? -1,
    parentB: fixture.parentB ?? -1,
  });
  ecs.reproductive.attach(entity, {
    sex: fixture.sex ?? 0,
    cooldownHours: fixture.cooldownHours ?? 0,
    eligible: fixture.eligible === true ? 1 : 0,
  });
  ecs.intent.attach(entity, {
    kind: fixture.intent ?? AgentIntent.Eat,
    targetX: fixture.targetX ?? x,
    targetY: fixture.targetY ?? y,
    targetEntity: fixture.targetEntity ?? -1,
  });
  ecs.aiState.attach(entity);
  ecs.social.attach(entity, {
    loneliness: fixture.loneliness ?? 0,
    groupId: fixture.groupId ?? -1,
    groupJoinTick: 0,
    cooperationTarget: fixture.cooperationTarget ?? -1,
    cooperationTicks: fixture.cooperationTicks ?? 0,
    forageBonusTicks: fixture.forageBonusTicks ?? 0,
    lastConflictTick: fixture.lastConflictTick ?? 0,
  });
  return entity;
}
