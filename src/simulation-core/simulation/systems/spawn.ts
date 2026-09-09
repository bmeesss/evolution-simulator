/**
 * Initial agent spawning.
 *
 * Agents spawn deterministically from the dedicated 'spawn' RNG stream: tile
 * selection, initial needs and genome values all draw from it in a fixed
 * order. Because spawning has its own stream, later changes to world
 * generation or tick dynamics can never shift spawn outcomes for a given seed.
 */

import type { EntityId } from '../../ecs';
import type { SimulationEcs } from '../../ecs';
import { randomGenomeValues } from '../../genetics';
import type { Rng } from '../../rng';
import type { EventLog } from '../../events';
import { AgentIntent } from '../../ai';
import type { World } from '../../world';
import { TerrainType } from '../../world';
import type { SimulationConfig } from '../config';

export function spawnInitialAgents(
  ecs: SimulationEcs,
  world: World,
  config: SimulationConfig,
  rng: Rng,
  events: EventLog,
): void {
  const spawnConfig = config.agents.spawn;
  for (let i = 0; i < config.agents.initialPopulation; i++) {
    // Prefer a land tile; fall back to the last attempt so spawning is always
    // possible even on mostly-water worlds.
    let tileX = 0;
    let tileY = 0;
    for (let attempt = 0; attempt < spawnConfig.maxLandTileAttempts; attempt++) {
      tileX = rng.rangeInt(0, world.width);
      tileY = rng.rangeInt(0, world.height);
      if (world.terrain[world.tileIndex(tileX, tileY)] !== TerrainType.Water) break;
    }

    const entity: EntityId = ecs.entities.create();

    ecs.position.attach(entity, { x: tileX, y: tileY });
    ecs.needs.attach(entity, {
      hunger: rng.rangeFloat(0, spawnConfig.initialHungerMax),
      thirst: rng.rangeFloat(0, spawnConfig.initialThirstMax),
      energy: rng.rangeFloat(spawnConfig.initialEnergyMin, spawnConfig.initialEnergyMax),
    });
    ecs.age.attach(entity, { ageHours: 0 });
    ecs.health.attach(entity, { current: spawnConfig.initialHealth });
    const genome = randomGenomeValues(rng);
    ecs.genome.attach(entity, genome);
    // Wander with the target on the agent itself: the movement system picks a
    // real target on the first tick (keeps target-picking in one place).
    ecs.intent.attach(entity, { kind: AgentIntent.Wander, targetX: tileX, targetY: tileY });

    events.record('agent_spawned', { entityId: entity });
  }
}
