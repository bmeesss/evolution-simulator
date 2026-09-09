/**
 * Shared helpers for phase-2 system-level tests.
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
import { ResourceIndex } from '../src/simulation-core/ai/perception';
import { AgentIntent } from '../src/simulation-core/ai/intents';
import { cloneConfig, DEFAULT_SIMULATION_CONFIG } from '../src/simulation-core/simulation/config';
import type { SimulationConfig } from '../src/simulation-core/simulation/config';
import type { TickContext } from '../src/simulation-core/simulation/tick-context';

export interface MiniContext {
  ctx: TickContext;
  config: SimulationConfig;
  world: World;
  ecs: SimulationEcs;
  events: EventLog;
}

export function makeContext(seed = 1, worldSize = 24): MiniContext {
  const config = cloneConfig(DEFAULT_SIMULATION_CONFIG);
  config.world.width = worldSize;
  config.world.height = worldSize;
  const world = createWorld(seed, config.world);
  const ecs = new SimulationEcs(config.memory.capacity);
  const events = new EventLog(() => ({ tick: 0, timeHours: 0 }));
  const ctx: TickContext = {
    ecs,
    world,
    config,
    events,
    rng: Rng.fromSeed(seed),
    aiRng: Rng.fromSeed(seed + 1),
    resourceIndex: new ResourceIndex(world.width, world.height, config.ai.perceptionRadiusTiles),
    dtHours: config.time.hoursPerTick,
    tick: 0,
  };
  return { ctx, config, world, ecs, events };
}

export interface AgentFixture {
  hunger?: number;
  thirst?: number;
  energy?: number;
  health?: number;
  intelligence?: number;
  intent?: number;
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
  ecs.age.attach(entity, { ageHours: 0 });
  ecs.health.attach(entity, { current: fixture.health ?? 100 });
  ecs.genome.attach(entity, {
    intelligence: fixture.intelligence ?? 0.5,
    strength: 0.5,
    speed: 0.5,
    fertility: 0.5,
    socialTendency: 0.5,
  });
  ecs.intent.attach(entity, { kind: fixture.intent ?? AgentIntent.Eat, targetX: x, targetY: y });
  ecs.aiState.attach(entity);
  return entity;
}
