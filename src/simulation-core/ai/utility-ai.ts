/**
 * Utility AI — replaces the phase-1 wander/rest placeholder with real
 * decision-making.
 *
 * Every tick, for every agent, this module:
 *   1. rebuilds the resource spatial index once (O(worldSize)),
 *   2. scores the six candidate actions with bounded [0, 1] utilities,
 *   3. applies deterministic tie-break noise + action hysteresis, and
 *   4. writes the winning intent (+ movement target) into the `intent` store.
 *
 * Decision vs. consequence: this module ONLY decides (and stores the decision).
 * The movement/resource/needs systems execute it. Utility scores are written to
 * the `aiState` store so the selected-agent debug view (and the determinism
 * tests) can inspect them — they are base scores, before noise/hysteresis.
 *
 * Action model (see ARCHITECTURE.md §Utility AI):
 *   Rest      = fatigueUrgency(energy)
 *   Wander    = explorationDrive × uncertainty(memory coverage)
 *   SeekFood  = hungerUrgency × bestFoodScore (richness × reachability)
 *   SeekWater = thirstUrgency × bestWaterScore
 *   Eat       = hungerUrgency × foodPresence(own tile)      (stationary)
 *   Drink     = thirstUrgency × waterPresence(own tile)     (stationary)
 *
 * Determinism: all randomness comes from the dedicated `ai` RNG stream (never
 * the platform RNG, never the spawn/world streams). The stream is consumed in
 * a fixed order per agent (six jitter draws, then any wander-target draws), so
 * re-running the same state always consumes the same numbers.
 */

import type { EntityId } from '../ecs';
import type { World } from '../world';
import type { SimulationConfig, TickContext } from '../simulation';
import { AgentIntent } from './intents';
import { ActionKind } from './actions';
import { ResourceType, type ResourceType as ResourceTypeType } from './memory';
import type { MemoryStore } from './memory';
import type { ResourceIndex } from './perception';
import { clamp01 } from './utility';
import {
  fatigueUrgency,
  hungerUrgency,
  thirstUrgency,
  resourceQuality,
  distanceFactorSquared,
  explorationUncertainty,
} from './considerations';

/** Reflect a value that fell outside [min, max] back inside (spreads wander targets). */
function mirrorClamp(value: number, min: number, max: number): number {
  if (value < min) value = min + (min - value);
  if (value > max) value = max - (value - max);
  return Math.min(max, Math.max(min, value));
}

/** Whether a tile still has enough food to be a worthwhile SeekFood target. */
function tileHasFood(world: World, tileX: number, tileY: number, minFood: number): boolean {
  if (tileX < 0 || tileY < 0 || tileX >= world.width || tileY >= world.height) return false;
  return world.food[world.tileIndex(tileX, tileY)] >= minFood;
}

/** Whether a tile still has enough water to be a worthwhile SeekWater target. */
function tileHasWater(world: World, tileX: number, tileY: number, minWater: number): boolean {
  if (tileX < 0 || tileY < 0 || tileX >= world.width || tileY >= world.height) return false;
  return world.water[world.tileIndex(tileX, tileY)] >= minWater;
}

/** Average remembered value across all of an agent's memory entries (0 if none). */
function averageMemoryValue(memory: MemoryStore, entity: EntityId): number {
  let sum = 0;
  let count = 0;
  for (let e = memory.headOf(entity); e !== -1; e = memory.nextOf(e)) {
    sum += memory.entryValue(e);
    count++;
  }
  return count === 0 ? 0 : sum / count;
}

/**
 * Find the best remembered resource candidate for the agent, considering both
 * tiles within perception (their current amount) and remembered locations
 * (their learned value). Writes the winner into `index.best` (reused scratch).
 * Returns false when nothing usable was found.
 */
function findBestResource(
  resourceType: ResourceTypeType,
  agentX: number,
  agentY: number,
  entity: EntityId,
  index: ResourceIndex,
  world: World,
  memory: MemoryStore,
  config: SimulationConfig,
): boolean {
  const { ai, resources } = config;
  const perceptionSq = ai.perceptionRadiusTiles * ai.perceptionRadiusTiles;
  const horizonSq = ai.travelHorizonTiles * ai.travelHorizonTiles;

  let bestTile = -1;
  let bestX = 0;
  let bestY = 0;
  let bestScore = -1;

  // --- Visible candidates (3×3 grid cells around the agent) ----------------
  const col = index.cellCol(agentX);
  const row = index.cellRow(agentY);
  const minCol = col > 0 ? col - 1 : 0;
  const maxCol = col < index.cols - 1 ? col + 1 : index.cols - 1;
  const minRow = row > 0 ? row - 1 : 0;
  const maxRow = row < index.rows - 1 ? row + 1 : index.rows - 1;

  const isFood = resourceType === ResourceType.Food;
  const head = isFood ? index.foodHead : index.waterHead;
  const next = isFood ? index.foodNext : index.waterNext;
  const amounts = isFood ? world.food : world.water;
  const minAmount = isFood ? resources.minFoodToEat : resources.minWaterToDrink;

  for (let r = minRow; r <= maxRow; r++) {
    for (let c = minCol; c <= maxCol; c++) {
      for (let idx = head[index.cellIndex(c, r)]; idx !== -1; idx = next[idx]) {
        const amount = amounts[idx];
        if (amount < minAmount) continue;
        const tx = index.tileX(idx);
        const ty = index.tileY(idx);
        const dx = tx - agentX;
        const dy = ty - agentY;
        const distSq = dx * dx + dy * dy;
        if (distSq > perceptionSq) continue; // out of sight
        const score = resourceQuality(amount) * distanceFactorSquared(distSq, horizonSq);
        if (score > bestScore) {
          bestScore = score;
          bestTile = idx;
          bestX = tx;
          bestY = ty;
        }
      }
    }
  }

  // --- Remembered candidates (may be beyond perception) --------------------
  for (let e = memory.headOf(entity); e !== -1; e = memory.nextOf(e)) {
    if (memory.entryResourceType(e) !== resourceType) continue;
    const value = memory.entryValue(e);
    if (value <= 0) continue;
    const dx = memory.entryX(e) - agentX;
    const dy = memory.entryY(e) - agentY;
    const distSq = dx * dx + dy * dy;
    const score = value * distanceFactorSquared(distSq, horizonSq);
    if (score > bestScore) {
      bestScore = score;
      bestTile = -2; // marker: the winner came from memory, not a tile index
      bestX = memory.entryX(e);
      bestY = memory.entryY(e);
    }
  }

  index.best.tileIndex = bestTile;
  index.best.x = bestX;
  index.best.y = bestY;
  index.best.score = bestScore;
  return bestTile !== -1;
}

export function selectIntents(ctx: TickContext): void {
  const { ecs, world, config, aiRng, resourceIndex } = ctx;
  const intent = ecs.intent;
  const needs = ecs.needs;
  const position = ecs.position;
  const aiState = ecs.aiState;
  const memory = ecs.memory;

  const { ai, resources, movement } = config;
  const minFood = resources.minFoodToEat;
  const minWater = resources.minWaterToDrink;
  const eatAmount = resources.eatAmount;
  const drinkAmount = resources.drinkAmount;
  const wanderRadius = movement.wanderTargetRadiusTiles;
  const reachSq = movement.targetReachedDistanceTiles * movement.targetReachedDistanceTiles;
  const hysteresis = ai.hysteresisBonus;
  const noise = ai.tieBreakNoise;
  const maxX = world.width - 1;
  const maxY = world.height - 1;

  resourceIndex.rebuild(world, minFood, minWater);

  for (let i = 0; i < intent.count; i++) {
    const entity = intent.entityOf[i];
    const prevKind = intent.columns.kind[i];
    const prevTargetX = intent.columns.targetX[i];
    const prevTargetY = intent.columns.targetY[i];
    const needsSlot = needs.index[entity];
    const positionSlot = position.index[entity];
    if (needsSlot < 0 || positionSlot < 0) continue;

    const x = position.columns.x[positionSlot];
    const y = position.columns.y[positionSlot];
    const hunger = needs.columns.hunger[needsSlot];
    const thirst = needs.columns.thirst[needsSlot];
    const energy = needs.columns.energy[needsSlot];

    // --- Candidate resources (best food / best water, perception + memory) ---
    const hasFood = findBestResource(ResourceType.Food, x, y, entity, resourceIndex, world, memory, config);
    const foodScore = hasFood ? resourceIndex.best.score : 0;
    const foodX = hasFood ? resourceIndex.best.x : 0;
    const foodY = hasFood ? resourceIndex.best.y : 0;
    const hasWater = findBestResource(ResourceType.Water, x, y, entity, resourceIndex, world, memory, config);
    const waterScore = hasWater ? resourceIndex.best.score : 0;
    const waterX = hasWater ? resourceIndex.best.x : 0;
    const waterY = hasWater ? resourceIndex.best.y : 0;

    // --- Resources under the agent's own feet (for the stationary Eat/Drink) --
    const tileIdx = world.tileIndex(Math.floor(x), Math.floor(y));
    const foodHere = world.food[tileIdx];
    const waterHere = world.water[tileIdx];

    // --- Base utilities (bounded to [0, 1]) ----------------------------------
    const uRest = fatigueUrgency(energy, config);
    const uWander = ai.explorationDrive * explorationUncertainty(averageMemoryValue(memory, entity));
    const uSeekFood = hungerUrgency(hunger, config) * foodScore;
    const uSeekWater = thirstUrgency(thirst, config) * waterScore;
    const uEat = foodHere >= minFood ? hungerUrgency(hunger, config) * clamp01(foodHere / eatAmount) : 0;
    const uDrink = waterHere >= minWater ? thirstUrgency(thirst, config) * clamp01(waterHere / drinkAmount) : 0;

    // Persist base scores for the debug view and determinism tests.
    const aiSlot = aiState.index[entity];
    if (aiSlot >= 0) {
      aiState.columns.rest[aiSlot] = uRest;
      aiState.columns.wander[aiSlot] = uWander;
      aiState.columns.seekFood[aiSlot] = uSeekFood;
      aiState.columns.seekWater[aiSlot] = uSeekWater;
      aiState.columns.eat[aiSlot] = uEat;
      aiState.columns.drink[aiSlot] = uDrink;
    }

    // --- Deterministic tie-break noise + action hysteresis ------------------
    // Six jitter draws per agent, in ActionKind order, every tick — unconditional
    // so AI RNG consumption never depends on which branch wins.
    const nRest = (aiRng.nextFloat() * 2 - 1) * noise;
    const nWander = (aiRng.nextFloat() * 2 - 1) * noise;
    const nSeekFood = (aiRng.nextFloat() * 2 - 1) * noise;
    const nSeekWater = (aiRng.nextFloat() * 2 - 1) * noise;
    const nEat = (aiRng.nextFloat() * 2 - 1) * noise;
    const nDrink = (aiRng.nextFloat() * 2 - 1) * noise;

    let winner: ActionKind = ActionKind.Rest;
    let best = uRest + nRest + (prevKind === AgentIntent.Rest ? hysteresis : 0);
    let v = uWander + nWander + (prevKind === AgentIntent.Wander ? hysteresis : 0);
    if (v > best) {
      best = v;
      winner = ActionKind.Wander;
    }
    v = uSeekFood + nSeekFood + (prevKind === AgentIntent.SeekFood ? hysteresis : 0);
    if (v > best) {
      best = v;
      winner = ActionKind.SeekFood;
    }
    v = uSeekWater + nSeekWater + (prevKind === AgentIntent.SeekWater ? hysteresis : 0);
    if (v > best) {
      best = v;
      winner = ActionKind.SeekWater;
    }
    v = uEat + nEat + (prevKind === AgentIntent.Eat ? hysteresis : 0);
    if (v > best) {
      best = v;
      winner = ActionKind.Eat;
    }
    v = uDrink + nDrink + (prevKind === AgentIntent.Drink ? hysteresis : 0);
    if (v > best) {
      best = v;
      winner = ActionKind.Drink;
    }

    // --- Choose/keep the movement target (action hysteresis for targets) ----
    let targetX = x;
    let targetY = y;
    switch (winner) {
      case ActionKind.Rest:
      case ActionKind.Eat:
      case ActionKind.Drink:
        // Stationary: target is where the agent already stands.
        break;
      case ActionKind.Wander: {
        const dx = prevTargetX - x;
        const dy = prevTargetY - y;
        const keepTarget = prevKind === AgentIntent.Wander && dx * dx + dy * dy > reachSq;
        if (keepTarget) {
          targetX = prevTargetX;
          targetY = prevTargetY;
        } else {
          targetX = mirrorClamp(x + (aiRng.nextFloat() * 2 - 1) * wanderRadius, 0, maxX);
          targetY = mirrorClamp(y + (aiRng.nextFloat() * 2 - 1) * wanderRadius, 0, maxY);
        }
        break;
      }
      case ActionKind.SeekFood: {
        const keepTarget =
          prevKind === AgentIntent.SeekFood &&
          tileHasFood(world, Math.floor(prevTargetX), Math.floor(prevTargetY), minFood);
        if (keepTarget) {
          targetX = prevTargetX;
          targetY = prevTargetY;
        } else if (hasFood) {
          targetX = foodX;
          targetY = foodY;
        }
        break;
      }
      case ActionKind.SeekWater: {
        const keepTarget =
          prevKind === AgentIntent.SeekWater &&
          tileHasWater(world, Math.floor(prevTargetX), Math.floor(prevTargetY), minWater);
        if (keepTarget) {
          targetX = prevTargetX;
          targetY = prevTargetY;
        } else if (hasWater) {
          targetX = waterX;
          targetY = waterY;
        }
        break;
      }
    }

    intent.columns.kind[i] = winner;
    intent.columns.targetX[i] = targetX;
    intent.columns.targetY[i] = targetY;
  }
}
