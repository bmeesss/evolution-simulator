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
import { KinshipType, kinshipBetween } from '../../social/kinship';

export function interactWithResources(ctx: TickContext): void {
  const { ecs, world, config } = ctx;
  const intent = ecs.intent;
  const needs = ecs.needs;
  const position = ecs.position;
  const genome = ecs.genome;
  const memory = ecs.memory;
  const socialStore = ecs.social;
  const resources = config.resources;
  const conflict = config.social.conflict;
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

    // Cooperative-foraging efficiency: while the bonus from a completed
    // cooperation session is active, the same world food yields more hunger
    // relief (foraging together is more efficient — it never creates food).
    const socialSlot = socialStore.index[entity];
    const forageBonus =
      socialSlot >= 0 && socialStore.columns.forageBonusTicks[socialSlot] > 0
        ? 1 + config.social.cooperation.forageBonusFactor
        : 1;

    if (kind === AgentIntent.Eat) {
      const food = world.food[idx];
      if (food >= resources.minFoodToEat) {
        const take = Math.min(food, resources.eatAmount);
        world.food[idx] = food - take;
        needs.columns.hunger[needsSlot] = Math.max(
          NEED_MIN,
          needs.columns.hunger[needsSlot] - resources.hungerReliefPerEat * forageBonus,
        );
        const created = reinforceMemory(memory, entity, ResourceType.Food, tileX, tileY, learningRate, config, tick);
        ctx.events.record('agent_ate', {
          entityId: entity,
          detail: `${take.toFixed(3)} @ ${tileX},${tileY}`,
        });
        stampForage(ctx, entity, tick);
        if (created) ctx.events.record('agent_learned', { entityId: entity, detail: `food @ ${tileX},${tileY}` });
        if (world.food[idx] < resources.minFoodToEat) {
          ctx.events.record('resource_depleted', { detail: `food @ ${tileX},${tileY}` });
        }
        // Strained patch: less than one full meal is left while another
        // forager is working the same tile — a direct contest over scarce
        // food ("resource blocking"). The eaters start to resent each other.
        if (world.food[idx] < resources.eatAmount) {
          resentCompetitor(
            ctx,
            entity,
            position.columns.x[positionSlot],
            position.columns.y[positionSlot],
            tileX,
            tileY,
            tick,
            conflict.resentmentPerContest,
          );
        }
      } else {
        // The remembered/last-known spot is depleted: learn that it is poor.
        punishMemory(memory, entity, ResourceType.Food, tileX, tileY, learningRate, tick);
        // Depleted patch + another agent nearby → competition. The failed
        // forager blames the nearest agent on the empty patch; repeated
        // failures turn the relationship sour, which is the only seed of
        // Avoid/Confront behavior (conflict stays emergent, never random).
        resentCompetitor(
          ctx,
          entity,
          position.columns.x[positionSlot],
          position.columns.y[positionSlot],
          tileX,
          tileY,
          tick,
          conflict.resentmentPerDepletion,
        );
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
        stampForage(ctx, entity, tick);
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

/**
 * Stamp a genuinely successful Eat/Drink on the culture component (Phase 5).
 * The culture system reads this to credit a discovery and to reinforce the
 * cultural knowledge that just paid off. Pure observation hook: nothing about
 * behaviour changes here, and the stamp is one integer write per meal.
 */
function stampForage(ctx: TickContext, entity: EntityId, tick: number): void {
  const slot = ctx.ecs.culture.index[entity];
  if (slot >= 0) ctx.ecs.culture.columns.lastForageTick[slot] = tick;
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

/**
 * Competition resentment: a forager whose food source is strained or empty
 * blames a nearby agent. Candidate preference is hostile attribution — the
 * real-world bias of presuming the guilty party is whoever you already
 * distrust:
 *   1. an agent already blamed before (deepest grudge first, then nearest),
 *   2. otherwise a co-forager of the same tile (Eat/SeekFood targeting it),
 *   3. otherwise the nearest agent.
 * This is what makes grudges self-reinforcing: repeated contested contact
 * deepens the SAME relationship instead of spraying blame at rotating
 * bystanders, which is what eventually makes Avoid/Confront relevant. The
 * penalty magnitude distinguishes a fully depleted patch (strong) from a
 * strained one (mild); both are rate-limited per pair, dampened for kin and
 * by existing goodwill, so sustained competition — not a single accident —
 * produces real hostility.
 *
 * Candidate lookup walks the 3×3 cells of the pre-movement social index;
 * anyone within the (tiny) resentment radius after moving was in the same or
 * an adjacent cell before moving, so the walk cannot miss them.
 */
function resentCompetitor(
  ctx: TickContext,
  entity: EntityId,
  x: number,
  y: number,
  tileX: number,
  tileY: number,
  tick: number,
  magnitude: number,
): void {
  const { ecs, config, socialIndex } = ctx;
  const conflict = config.social.conflict;
  const relationships = ecs.relationships;
  const position = ecs.position;
  const intent = ecs.intent;

  const radiusSq = conflict.resentmentRadiusTiles * conflict.resentmentRadiusTiles;
  const col = socialIndex.cellCol(x);
  const row = socialIndex.cellRow(y);
  const minCol = col > 0 ? col - 1 : 0;
  const maxCol = col < socialIndex.cols - 1 ? col + 1 : socialIndex.cols - 1;
  const minRow = row > 0 ? row - 1 : 0;
  const maxRow = row < socialIndex.rows - 1 ? row + 1 : socialIndex.rows - 1;

  // Scratch lookup of the agent's own relationships so each candidate's
  // grudge is an O(1) check (module-level arrays, reused; same pattern as
  // the social targeting scratch).
  relStamp++;
  for (let e = relationships.headOf(entity); e !== -1; e = relationships.nextOf(e)) {
    const target = relationships.targetOf(e);
    ensureRelScratch(target);
    relScratch.entryOf[target] = e;
    relScratch.stampOf[target] = relStamp;
  }

  let blame = -1;
  let blameDistSq = radiusSq;
  let blameGrudge = 0; // score toward the current best candidate (<= 0)
  let blameCoForager = false;
  for (let r = minRow; r <= maxRow; r++) {
    for (let c = minCol; c <= maxCol; c++) {
      for (
        let candidate = socialIndex.headOf(socialIndex.cellIndex(c, r));
        candidate !== -1;
        candidate = socialIndex.nextOf(candidate)
      ) {
        if (candidate === entity) continue;
        const slot = position.index[candidate];
        if (slot < 0) continue; // defensive: no position, no blame
        const dx = position.columns.x[slot] - x;
        const dy = position.columns.y[slot] - y;
        const distSq = dx * dx + dy * dy;
        if (distSq > radiusSq) continue;

        const entry =
          candidate < relScratch.entryOf.length && relScratch.stampOf[candidate] === relStamp
            ? relScratch.entryOf[candidate]
            : -1;
        const grudge = entry !== -1 ? Math.min(0, relationships.scoreOf(entry)) : 0;
        const intentSlot = intent.index[candidate];
        const kind = intentSlot >= 0 ? intent.columns.kind[intentSlot] : -1;
        const coForager =
          (kind === AgentIntent.Eat || kind === AgentIntent.SeekFood) &&
          intent.columns.targetX[intentSlot] >= tileX &&
          intent.columns.targetX[intentSlot] < tileX + 1 &&
          intent.columns.targetY[intentSlot] >= tileY &&
          intent.columns.targetY[intentSlot] < tileY + 1;

        // Class preference, then distance: a deeper grudge always wins; at
        // equal grudge a co-forager of this tile beats a bystander; at equal
        // class the nearer candidate wins; exact ties keep the earliest
        // candidate (strict comparisons — deterministic).
        const betterClass =
          grudge < blameGrudge || (grudge === blameGrudge && coForager && !blameCoForager);
        const worseClass =
          grudge > blameGrudge || (grudge === blameGrudge && blameCoForager && !coForager);
        if (blame !== -1) {
          if (worseClass) continue;
          if (!betterClass && distSq >= blameDistSq) continue;
        }
        blame = candidate;
        blameDistSq = distSq;
        blameGrudge = grudge;
        blameCoForager = coForager;
      }
    }
  }
  if (blame === -1) return;

  const kin = kinshipBetween(entity, blame, ecs) !== KinshipType.None;
  const kinFactor = kin ? 1 - config.social.kinship.confrontDampening : 1;
  const existing = relationships.find(entity, blame);
  if (existing !== -1) {
    // Rate-limit per pair (a dedicated cooldown: friendly contact does not
    // immunize against competition) and dampen by existing goodwill so
    // friendships survive sharing without becoming untouchable.
    if (tick < relationships.resentUntilOf(existing)) return;
    const before = relationships.scoreOf(existing);
    const penalty = magnitude * kinFactor * (1 - 0.5 * Math.max(0, before));
    relationships.setScore(existing, before - penalty);
    relationships.setResentUntil(existing, tick + conflict.resentmentIntervalTicks);
    relationships.incrementNegative(existing);
    // A grudge turning genuinely hostile is a feed-worthy moment (fires once
    // per crossing of the hostility gate, not per contest).
    if (before > -conflict.minHostility && relationships.scoreOf(existing) <= -conflict.minHostility) {
      ctx.events.record('resentment', {
        entityId: entity,
        detail: `blames #${blame} for a contested food source (${relationships.scoreOf(existing).toFixed(2)})`,
      });
    }
  } else {
    const { entry } = relationships.getOrCreate(entity, blame, tick, kin);
    relationships.setScore(entry, -magnitude * kinFactor);
    relationships.setResentUntil(entry, tick + conflict.resentmentIntervalTicks);
    relationships.incrementNegative(entry);
    if (-magnitude * kinFactor <= -conflict.minHostility) {
      ctx.events.record('resentment', {
        entityId: entity,
        detail: `blames #${blame} for a depleted food source (${(-magnitude * kinFactor).toFixed(2)})`,
      });
    }
  }
}

/** Module-level scratch for resentCompetitor's O(1) grudge lookups. */
const relScratch: { entryOf: Int32Array; stampOf: Uint32Array } = {
  entryOf: new Int32Array(1024),
  stampOf: new Uint32Array(1024),
};
let relStamp = 0;

/** Ensure the scratch arrays are addressable for `entity`. */
function ensureRelScratch(entity: EntityId): void {
  if (entity < relScratch.entryOf.length) return;
  let capacity = relScratch.entryOf.length;
  while (capacity <= entity) capacity *= 2;
  const entryOf = new Int32Array(capacity);
  entryOf.set(relScratch.entryOf);
  const stampOf = new Uint32Array(capacity);
  stampOf.set(relScratch.stampOf);
  relScratch.entryOf = entryOf;
  relScratch.stampOf = stampOf;
}
