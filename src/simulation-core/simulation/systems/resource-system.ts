/**
 * Resource system: executes Eat and Drink intents (the consequences the AI
 * decided on).
 *
 * For an agent whose intent is Eat/Drink, the tile under its feet is consumed:
 *   - food/water is reduced by a configurable amount (never below zero),
 *   - hunger/thirst are relieved by a configurable amount,
 *   - the interaction reinforces (or, when the location turns out depleted,
 *     punishes) the agent's memory of that location — the core of the
 *     associative-learning loop,
 *   - compact events are emitted (agent_ate, agent_drank, resource_depleted,
 *     agent_learned).
 *
 * Agents are processed in dense-slot order; because they may share a tile, an
 * agent later in the order can find the tile already drained by an earlier one
 * — that deterministic "unsuccessful" case is what drives memory punishment,
 * matching the learning model in ARCHITECTURE.md.
 */

import { NEED_MIN } from '../config';
import type { TickContext } from '../tick-context';
import { AgentIntent, ResourceType } from '../../ai';
import { effectiveLearningRate, punishValue, reinforceValue } from '../../ai';
import type { EntityId } from '../../ecs';
import type { MemoryStore } from '../../ai';
import type { SimulationConfig } from '../config';

export function interactWithResources(ctx: TickContext): void {
  const { ecs, world, config } = ctx;
  const intent = ecs.intent;
  const needs = ecs.needs;
  const position = ecs.position;
  const genome = ecs.genome;
  const memory = ecs.memory;
  const resources = config.resources;
  const tick = ctx.tick;

  for (let i = 0; i < intent.count; i++) {
    const kind = intent.columns.kind[i];
    if (kind !== AgentIntent.Eat && kind !== AgentIntent.Drink) continue;
    const entity = intent.entityOf[i];
    const positionSlot = position.index[entity];
    const needsSlot = needs.index[entity];
    const genomeSlot = genome.index[entity];
    if (positionSlot < 0 || needsSlot < 0) continue;

    const tileX = Math.floor(position.columns.x[positionSlot]);
    const tileY = Math.floor(position.columns.y[positionSlot]);
    if (tileX < 0 || tileY < 0 || tileX >= world.width || tileY >= world.height) continue;
    const idx = world.tileIndex(tileX, tileY);

    const intelligence = genomeSlot >= 0 ? genome.columns.intelligence[genomeSlot] : 0;
    const learningRate = effectiveLearningRate(intelligence, config);

    if (kind === AgentIntent.Eat) {
      const food = world.food[idx];
      if (food >= resources.minFoodToEat) {
        const take = Math.min(food, resources.eatAmount);
        world.food[idx] = food - take;
        needs.columns.hunger[needsSlot] = Math.max(
          NEED_MIN,
          needs.columns.hunger[needsSlot] - resources.hungerReliefPerEat,
        );
        const created = reinforceMemory(memory, entity, ResourceType.Food, tileX, tileY, learningRate, config, tick);
        ctx.events.record('agent_ate', {
          entityId: entity,
          detail: `${take.toFixed(3)} @ ${tileX},${tileY}`,
        });
        if (created) ctx.events.record('agent_learned', { entityId: entity, detail: `food @ ${tileX},${tileY}` });
        if (world.food[idx] < resources.minFoodToEat) {
          ctx.events.record('resource_depleted', { detail: `food @ ${tileX},${tileY}` });
        }
      } else {
        // The remembered/last-known spot is depleted: learn that it is poor.
        punishMemory(memory, entity, ResourceType.Food, tileX, tileY, learningRate, tick);
      }
    } else {
      const water = world.water[idx];
      if (water >= resources.minWaterToDrink) {
        const take = Math.min(water, resources.drinkAmount);
        world.water[idx] = water - take;
        needs.columns.thirst[needsSlot] = Math.max(
          NEED_MIN,
          needs.columns.thirst[needsSlot] - resources.thirstReliefPerDrink,
        );
        const created = reinforceMemory(memory, entity, ResourceType.Water, tileX, tileY, learningRate, config, tick);
        ctx.events.record('agent_drank', {
          entityId: entity,
          detail: `${take.toFixed(3)} @ ${tileX},${tileY}`,
        });
        if (created) ctx.events.record('agent_learned', { entityId: entity, detail: `water @ ${tileX},${tileY}` });
        if (world.water[idx] < resources.minWaterToDrink) {
          ctx.events.record('resource_depleted', { detail: `water @ ${tileX},${tileY}` });
        }
      } else {
        punishMemory(memory, entity, ResourceType.Water, tileX, tileY, learningRate, tick);
      }
    }
  }
}

/** Successful interaction: reinforce (or create) the memory of a location. */
function reinforceMemory(
  memory: MemoryStore,
  entity: EntityId,
  resourceType: ResourceType,
  tileX: number,
  tileY: number,
  learningRate: number,
  config: SimulationConfig,
  tick: number,
): boolean {
  const existing = memory.find(entity, resourceType, tileX, tileY);
  const nextValue =
    existing === -1
      ? config.memory.initialValue
      : reinforceValue(memory.entryValue(existing), learningRate);
  const { created } = memory.observe(entity, resourceType, tileX, tileY, nextValue, tick);
  return created;
}

/** Depleted location: reduce the remembered value (never create a memory). */
function punishMemory(
  memory: MemoryStore,
  entity: EntityId,
  resourceType: ResourceType,
  tileX: number,
  tileY: number,
  learningRate: number,
  tick: number,
): void {
  const existing = memory.find(entity, resourceType, tileX, tileY);
  if (existing === -1) return;
  const nextValue = punishValue(memory.entryValue(existing), learningRate);
  memory.updateExisting(entity, resourceType, tileX, tileY, nextValue, tick);
}
