/**
 * Utility AI — replaces the phase-1 wander/rest placeholder with real
 * decision-making.
 *
 * Every tick, for every agent, this module:
 *   1. rebuilds the resource + agent spatial indexes once,
 *   2. scores the twelve candidate actions with bounded [0, 1] utilities,
 *   3. applies deterministic tie-break noise + action hysteresis, and
 *   4. writes the winning intent (+ movement target) into the `intent` store.
 *
 * Decision vs. consequence: this module ONLY decides (and stores the decision).
 * The movement/resource/needs/social systems execute it. Utility scores are
 * written to the `aiState` store so the selected-agent debug view (and the
 * determinism tests) can inspect them — they are base scores, before
 * noise/hysteresis.
 *
 * Action model (see ARCHITECTURE.md §Utility AI):
 *   Rest      = fatigueUrgency(energy)
 *   Wander    = explorationDrive × uncertainty(memory coverage)
 *   SeekFood  = hungerUrgency × bestFoodScore (richness × reachability)
 *   SeekWater = thirstUrgency × bestWaterScore
 *   Eat       = hungerUrgency × foodPresence(own tile)      (stationary)
 *   Drink     = thirstUrgency × waterPresence(own tile)     (stationary)
 *   SeekPartner = reproductionUrgency × partnerScore
 *
 * Phase 4 social actions (targets from the bounded social-targeting passes —
 * a memory walk for Avoid/Confront, a spatial walk for the other three):
 *   Socialize = lonelinessUrgency × socialDrive × safety × socialTargetScore
 *   Help      = socialDrive × safety × helperCapacity × helpTargetScore
 *   Cooperate = socialDrive × safety × forageNeed × cooperateTargetScore
 *   Avoid     = threat × vulnerability        (flee from the most feared agent)
 *   Confront  = gain × competition × grudge × edge × aggression (adults only;
 *               see social-targeting.ts for the exact formula and rationale)
 *
 * Determinism: all randomness comes from the dedicated `ai` RNG stream (never
 * the platform RNG, never the spawn/world streams). The stream is consumed in
 * a fixed order per agent (twelve jitter draws, then any wander-target draws),
 * so re-running the same state always consumes the same numbers.
 */

import type { EntityId } from '../ecs';
import type { SimulationEcs } from '../ecs';
import type { World } from '../world';
import type { SimulationConfig, TickContext } from '../simulation';
import { lifeStageForAge, isReproductiveStage } from '../simulation/life-stages';
import { AgentIntent } from './intents';
import { ActionKind } from './actions';
import { ResourceType, type ResourceType as ResourceTypeType } from './memory';
import type { MemoryStore } from './memory';
import type { ResourceIndex } from './perception';
import type { AgentIndex } from './perception';
import { findSocialTargets, socialTargets } from './social-targeting';
import { areKin } from '../social/kinship';
import { clamp01 } from './utility';
import {
  fatigueUrgency,
  hungerUrgency,
  thirstUrgency,
  resourceQuality,
  distanceFactorSquared,
  explorationUncertainty,
  reproductionUrgency,
  partnerDesirability,
  lonelinessUrgency,
  socialDrive,
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

/**
 * Reused partner-query scratch (a single object shared across the per-agent
 * loop, so no allocation happens per agent). Read immediately after
 * `findBestPartner`; do not retain across queries.
 */
const partnerScratch = { entityId: -1, x: 0, y: 0, score: -1 };

/**
 * Kin check for the partner filter — thin wrapper over the shared kinship
 * module (social/kinship.ts) so the social layer and the reproduction layer
 * can never disagree about who is family.
 */
function isKin(a: EntityId, b: EntityId, ecs: SimulationEcs): boolean {
  return areKin(a, b, ecs);
}

/**
 * Upper bound on partner candidates any one agent inspects per tick. In a dense
 * cluster the 3×3-cell walk would otherwise visit every agent in a cell and turn
 * the per-agent partner search into O(population) (and the whole tick into
 * O(n²)). Capping the scan keeps the per-agent work O(1) — an agent inspects at
 * most this many nearby candidates and keeps the best it saw. At sparse
 * populations the cap is not reached and the best candidate is still found.
 */
const MAX_PARTNER_SCAN = 48;

/**
 * Find the best valid nearby partner for `selfEntity` using the AgentIndex.
 * Walks only the 3×3 grid cells around the agent (cell size = partner-seek
 * radius), so it is O(nearbyAgents) — never O(allAgents). Filters strictly:
 *   - not self, opposite sex, alive, adult/elderly branch handled upstream
 *   - candidate is reproductively eligible (cached flag, updated each tick)
 *   - candidate health >= minHealthToReproduce
 *   - not direct kin (parent/child/sibling) — incest avoidance
 * Scores survivors with `partnerDesirability`. Writes the best candidate seen
 * into `partnerScratch` and returns false when nothing valid was found.
 */
function findBestPartner(
  selfEntity: EntityId,
  selfOriginX: number,
  selfOriginY: number,
  agentIndex: AgentIndex,
  ecs: SimulationEcs,
  config: SimulationConfig,
): boolean {
  const { reproduction } = config;
  const radiusSq = reproduction.partnerSeekRadiusTiles * reproduction.partnerSeekRadiusTiles;
  const position = ecs.position;
  const genome = ecs.genome;
  const reproStore = ecs.reproductive;
  const health = ecs.health;

  const selfSlot = reproStore.index[selfEntity];
  if (selfSlot < 0) return false;
  const selfSex = reproStore.columns.sex[selfSlot];

  const selfGenomeSlot = genome.index[selfEntity];
  const selfSocial = selfGenomeSlot >= 0 ? genome.columns.socialTendency[selfGenomeSlot] : 0;

  const col = agentIndex.cellCol(selfOriginX);
  const row = agentIndex.cellRow(selfOriginY);
  const minCol = col > 0 ? col - 1 : 0;
  const maxCol = col < agentIndex.cols - 1 ? col + 1 : agentIndex.cols - 1;
  const minRow = row > 0 ? row - 1 : 0;
  const maxRow = row < agentIndex.rows - 1 ? row + 1 : agentIndex.rows - 1;

  let bestEntity = -1;
  let bestX = 0;
  let bestY = 0;
  let bestScore = -1;
  let scanned = 0;

  scanCells: for (let r = minRow; r <= maxRow; r++) {
    for (let c = minCol; c <= maxCol; c++) {
      for (let candidate = agentIndex.headOf(agentIndex.cellIndex(c, r)); candidate !== -1; candidate = agentIndex.nextOf(candidate)) {
        if (scanned >= MAX_PARTNER_SCAN) break scanCells;
        scanned++;
        if (candidate === selfEntity) continue;
        const posSlot = position.index[candidate];
        if (posSlot < 0) continue;
        const cx = position.columns.x[posSlot];
        const cy = position.columns.y[posSlot];
        const dx = cx - selfOriginX;
        const dy = cy - selfOriginY;
        const distSq = dx * dx + dy * dy;
        if (distSq > radiusSq) continue;

        // Reproductive filters.
        const candidateReproSlot = reproStore.index[candidate];
        if (candidateReproSlot < 0) continue;
        if (reproStore.columns.sex[candidateReproSlot] === selfSex) continue; // same sex
        if (reproStore.columns.eligible[candidateReproSlot] !== 1) continue; // not ready
        const candidateHealthSlot = health.index[candidate];
        if (candidateHealthSlot < 0) continue;
        const candidateHealth = health.columns.current[candidateHealthSlot];
        if (candidateHealth < reproduction.minHealthToReproduce) continue;
        if (isKin(selfEntity, candidate, ecs)) continue;

        const candidateGenomeSlot = genome.index[candidate];
        const candidateFertility = candidateGenomeSlot >= 0 ? genome.columns.fertility[candidateGenomeSlot] : 0;
        const candidateSocial = candidateGenomeSlot >= 0 ? genome.columns.socialTendency[candidateGenomeSlot] : 0;

        const score = partnerDesirability(distSq, radiusSq, candidateHealth, candidateFertility, selfSocial, candidateSocial);
        if (score > bestScore) {
          bestScore = score;
          bestEntity = candidate;
          bestX = cx;
          bestY = cy;
        }
      }
    }
  }

  partnerScratch.entityId = bestEntity;
  partnerScratch.x = bestX;
  partnerScratch.y = bestY;
  partnerScratch.score = bestScore;
  return bestEntity !== -1;
}

export function selectIntents(ctx: TickContext): void {
  const { ecs, world, config, aiRng, resourceIndex, agentIndex, socialIndex, tick } = ctx;
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
  const helpConfig = config.social.help;
  const helperEnergySpan = 100 - helpConfig.minHelperEnergy;
  const helperHealthSpan = 100 - helpConfig.minHelperHealth;

  resourceIndex.rebuild(world, minFood, minWater);
  agentIndex.rebuild(ecs);
  socialIndex.rebuild(ecs);

  for (let i = 0; i < intent.count; i++) {
    const entity = intent.entityOf[i];
    const prevKind = intent.columns.kind[i];
    const prevTargetX = intent.columns.targetX[i];
    const prevTargetY = intent.columns.targetY[i];
    const prevTargetEntity = intent.columns.targetEntity[i];
    const needsSlot = needs.index[entity];
    const positionSlot = position.index[entity];
    if (needsSlot < 0 || positionSlot < 0) continue;

    const x = position.columns.x[positionSlot];
    const y = position.columns.y[positionSlot];
    const hunger = needs.columns.hunger[needsSlot];
    const thirst = needs.columns.thirst[needsSlot];
    const energy = needs.columns.energy[needsSlot];

    // Urgency primitives (reused by survival AND social scoring).
    const uHunger = hungerUrgency(hunger, config);
    const uThirst = thirstUrgency(thirst, config);
    const uFatigue = fatigueUrgency(energy, config);

    // --- Candidate resources (best food / best water, perception + memory) ---
    const hasFood = findBestResource(ResourceType.Food, x, y, entity, resourceIndex, world, memory, config);
    const foodScore = hasFood ? resourceIndex.best.score : 0;
    const foodX = hasFood ? resourceIndex.best.x : 0;
    const foodY = hasFood ? resourceIndex.best.y : 0;
    const hasWater = findBestResource(ResourceType.Water, x, y, entity, resourceIndex, world, memory, config);
    const waterScore = hasWater ? resourceIndex.best.score : 0;
    const waterX = hasWater ? resourceIndex.best.x : 0;
    const waterY = hasWater ? resourceIndex.best.y : 0;

    // Early lifecycle lookups (also used by the reproduction drive below).
    const ageSlot = ecs.age.index[entity];
    const healthSlot = ecs.health.index[entity];
    const genomeSlot = ecs.genome.index[entity];
    const ageHours = ageSlot >= 0 ? ecs.age.columns.ageHours[ageSlot] : 0;
    const currentHealth = healthSlot >= 0 ? ecs.health.columns.current[healthSlot] : 0;
    const fertility = genomeSlot >= 0 ? ecs.genome.columns.fertility[genomeSlot] : 0;
    const socialTendency = genomeSlot >= 0 ? ecs.genome.columns.socialTendency[genomeSlot] : 0;
    const strength = genomeSlot >= 0 ? ecs.genome.columns.strength[genomeSlot] : 0;
    const isAdult = isReproductiveStage(lifeStageForAge(ageHours, config));

    // Only adults/elderly in a safe survival state scan for a partner, so
    // children/adolescents/starving agents never cost the nearby-entity walk.
    const reproCapable =
      isAdult &&
      currentHealth >= config.reproduction.minHealthToReproduce &&
      energy >= config.reproduction.minEnergyToReproduce &&
      hunger < config.reproduction.maxNeedToReproduce &&
      thirst < config.reproduction.maxNeedToReproduce;

    // --- Best valid partner (AgentIndex; O(nearby), never O(population)) -----
    const hasPartner = reproCapable ? findBestPartner(entity, x, y, agentIndex, ecs, config) : false;
    const partnerScore = hasPartner ? partnerScratch.score : 0;
    const partnerId = hasPartner ? partnerScratch.entityId : -1;
    const partnerX = hasPartner ? partnerScratch.x : 0;
    const partnerY = hasPartner ? partnerScratch.y : 0;

    // --- Resources under the agent's own feet (for the stationary Eat/Drink) --
    const tileIdx = world.tileIndex(Math.floor(x), Math.floor(y));
    const foodHere = world.food[tileIdx];
    const waterHere = world.water[tileIdx];

    // --- Social targets: ONE bounded walk covers all five actions (Phase 4) --
    const socialSlot = ecs.social.index[entity];
    const loneliness = socialSlot >= 0 ? ecs.social.columns.loneliness[socialSlot] : 0;
    findSocialTargets(
      entity,
      x,
      y,
      uHunger,
      strength,
      socialTendency,
      isAdult,
      ecs,
      config,
      socialIndex,
      tick,
    );

    // --- Base utilities (bounded to [0, 1]) ----------------------------------
    const uRest = uFatigue;
    const uWander = ai.explorationDrive * explorationUncertainty(averageMemoryValue(memory, entity));
    const uSeekFood = uHunger * foodScore;
    const uSeekWater = uThirst * waterScore;
    const uEat = foodHere >= minFood ? uHunger * clamp01(foodHere / eatAmount) : 0;
    const uDrink = waterHere >= minWater ? uThirst * clamp01(waterHere / drinkAmount) : 0;
    const uSeekPartner = reproductionUrgency(
      ageHours,
      currentHealth,
      energy,
      hunger,
      thirst,
      fertility,
      socialTendency,
      config,
    ) * partnerScore;

    // Social utilities. `safety` is spare survival capacity (1 = comfortable,
    // 0 = some need is critical): starving agents never socialize/help/
    // cooperate, but they still FLEE (Avoid is not safety-gated).
    const safety = Math.max(0, 1 - Math.max(uHunger, uThirst, uFatigue));
    const drive = socialDrive(socialTendency);
    const helperCapacity =
      clamp01((energy - helpConfig.minHelperEnergy) / Math.max(1, helperEnergySpan)) *
      clamp01((currentHealth - helpConfig.minHelperHealth) / Math.max(1, helperHealthSpan));
    // Cooperation is foraging-motivated: mildly hungry agents may start,
    // urgent hunger makes it compelling (0.3 base mirrors baseDrive patterns).
    const forageNeed = 0.3 + 0.7 * uHunger;
    const uSocialize = lonelinessUrgency(loneliness, config) * drive * safety * socialTargets.socializeScore;
    const uHelp = drive * safety * helperCapacity * socialTargets.helpScore;
    const uCooperate = drive * safety * forageNeed * socialTargets.cooperateScore;
    const uAvoid = socialTargets.avoidScore;
    const uConfront = socialTargets.confrontScore;

    // Persist base scores for the debug view and determinism tests.
    const aiSlot = aiState.index[entity];
    if (aiSlot >= 0) {
      aiState.columns.rest[aiSlot] = uRest;
      aiState.columns.wander[aiSlot] = uWander;
      aiState.columns.seekFood[aiSlot] = uSeekFood;
      aiState.columns.seekWater[aiSlot] = uSeekWater;
      aiState.columns.eat[aiSlot] = uEat;
      aiState.columns.drink[aiSlot] = uDrink;
      aiState.columns.seekPartner[aiSlot] = uSeekPartner;
      aiState.columns.socialize[aiSlot] = uSocialize;
      aiState.columns.help[aiSlot] = uHelp;
      aiState.columns.cooperate[aiSlot] = uCooperate;
      aiState.columns.avoid[aiSlot] = uAvoid;
      aiState.columns.confront[aiSlot] = uConfront;
    }

    // --- Deterministic tie-break noise + action hysteresis ------------------
    // Twelve jitter draws per agent, in ActionKind order, every tick —
    // unconditional so AI RNG consumption never depends on which branch wins.
    const nRest = (aiRng.nextFloat() * 2 - 1) * noise;
    const nWander = (aiRng.nextFloat() * 2 - 1) * noise;
    const nSeekFood = (aiRng.nextFloat() * 2 - 1) * noise;
    const nSeekWater = (aiRng.nextFloat() * 2 - 1) * noise;
    const nEat = (aiRng.nextFloat() * 2 - 1) * noise;
    const nDrink = (aiRng.nextFloat() * 2 - 1) * noise;
    const nSeekPartner = (aiRng.nextFloat() * 2 - 1) * noise;
    const nSocialize = (aiRng.nextFloat() * 2 - 1) * noise;
    const nHelp = (aiRng.nextFloat() * 2 - 1) * noise;
    const nCooperate = (aiRng.nextFloat() * 2 - 1) * noise;
    const nAvoid = (aiRng.nextFloat() * 2 - 1) * noise;
    const nConfront = (aiRng.nextFloat() * 2 - 1) * noise;

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
    v = uSeekPartner + nSeekPartner + (prevKind === AgentIntent.SeekPartner ? hysteresis : 0);
    if (v > best) {
      best = v;
      winner = ActionKind.SeekPartner;
    }
    v = uSocialize + nSocialize + (prevKind === AgentIntent.Socialize ? hysteresis : 0);
    if (v > best) {
      best = v;
      winner = ActionKind.Socialize;
    }
    v = uHelp + nHelp + (prevKind === AgentIntent.Help ? hysteresis : 0);
    if (v > best) {
      best = v;
      winner = ActionKind.Help;
    }
    v = uCooperate + nCooperate + (prevKind === AgentIntent.Cooperate ? hysteresis : 0);
    if (v > best) {
      best = v;
      winner = ActionKind.Cooperate;
    }
    v = uAvoid + nAvoid + (prevKind === AgentIntent.Avoid ? hysteresis : 0);
    if (v > best) {
      best = v;
      winner = ActionKind.Avoid;
    }
    v = uConfront + nConfront + (prevKind === AgentIntent.Confront ? hysteresis : 0);
    if (v > best) {
      best = v;
      winner = ActionKind.Confront;
    }

    // --- Choose/keep the movement target (action hysteresis for targets) ----
    let targetX = x;
    let targetY = y;
    let targetEntity = -1;
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
      case ActionKind.SeekPartner: {
        // Keep pursuing the same still-valid partner; otherwise re-target.
        const keepTarget =
          prevKind === AgentIntent.SeekPartner &&
          prevTargetEntity >= 0 &&
          ecs.entities.isAlive(prevTargetEntity);
        if (keepTarget) {
          targetEntity = prevTargetEntity;
          const pSlot = position.index[prevTargetEntity];
          if (pSlot >= 0) {
            targetX = position.columns.x[pSlot];
            targetY = position.columns.y[pSlot];
          } else {
            targetX = x;
            targetY = y;
          }
        } else if (hasPartner) {
          targetEntity = partnerId;
          targetX = partnerX;
          targetY = partnerY;
        }
        break;
      }
      case ActionKind.Socialize:
      case ActionKind.Help:
      case ActionKind.Cooperate: {
        // Pursue a social target. Keeping the previous target requires it to
        // be alive AND the relationship to not have turned hostile — an agent
        // never keeps socializing with someone it now fears.
        let pursueId = -1;
        if (
          prevKind === winner &&
          prevTargetEntity >= 0 &&
          pursuitStillValid(entity, winner, prevTargetEntity, ecs, config)
        ) {
          pursueId = prevTargetEntity;
        } else if (winner === ActionKind.Socialize && socialTargets.socializeId >= 0) {
          pursueId = socialTargets.socializeId;
          targetX = socialTargets.socializeX;
          targetY = socialTargets.socializeY;
        } else if (winner === ActionKind.Help && socialTargets.helpId >= 0) {
          pursueId = socialTargets.helpId;
          targetX = socialTargets.helpX;
          targetY = socialTargets.helpY;
        } else if (winner === ActionKind.Cooperate && socialTargets.cooperateId >= 0) {
          pursueId = socialTargets.cooperateId;
          targetX = socialTargets.cooperateX;
          targetY = socialTargets.cooperateY;
        }
        if (pursueId >= 0) {
          targetEntity = pursueId;
          const pSlot = position.index[pursueId];
          if (pSlot >= 0) {
            targetX = position.columns.x[pSlot];
            targetY = position.columns.y[pSlot];
          }
        }
        break;
      }
      case ActionKind.Confront: {
        // Chase the hostile rival (kept target only needs to stay alive).
        let pursueId = -1;
        if (prevKind === AgentIntent.Confront && prevTargetEntity >= 0 && ecs.entities.isAlive(prevTargetEntity)) {
          pursueId = prevTargetEntity;
        } else if (socialTargets.confrontId >= 0) {
          pursueId = socialTargets.confrontId;
          targetX = socialTargets.confrontX;
          targetY = socialTargets.confrontY;
        }
        if (pursueId >= 0) {
          targetEntity = pursueId;
          const pSlot = position.index[pursueId];
          if (pSlot >= 0) {
            targetX = position.columns.x[pSlot];
            targetY = position.columns.y[pSlot];
          }
        }
        break;
      }
      case ActionKind.Avoid: {
        // Flee: the movement target is a point AWAY from the most feared
        // nearby agent, recomputed every tick (threats move). The flee
        // distance reuses the wander-radius scale — no new tunable needed.
        if (socialTargets.threatId >= 0) {
          targetEntity = socialTargets.threatId;
          const dx = x - socialTargets.threatX;
          const dy = y - socialTargets.threatY;
          const distSq = dx * dx + dy * dy;
          if (distSq > 1e-9) {
            const dist = Math.sqrt(distSq);
            targetX = mirrorClamp(x + (dx / dist) * wanderRadius, 0, maxX);
            targetY = mirrorClamp(y + (dy / dist) * wanderRadius, 0, maxY);
          } else {
            // Fully overlapping: deterministic diagonal push by entity parity.
            const sign = entity % 2 === 0 ? 1 : -1;
            const diagonal = wanderRadius * 0.7071;
            targetX = mirrorClamp(x + sign * diagonal, 0, maxX);
            targetY = mirrorClamp(y + sign * diagonal, 0, maxY);
          }
        }
        break;
      }
    }

    intent.columns.kind[i] = winner;
    intent.columns.targetX[i] = targetX;
    intent.columns.targetY[i] = targetY;
    intent.columns.targetEntity[i] = targetEntity;
  }
}

/**
 * May the agent keep pursuing `target` for a friendly social action? Requires
 * the target to be alive and the relationship to not have turned hostile
 * (below the confront hostility threshold) since the pursuit began.
 */
function pursuitStillValid(
  self: EntityId,
  kind: number,
  target: EntityId,
  ecs: SimulationEcs,
  config: SimulationConfig,
): boolean {
  if (!ecs.entities.isAlive(target)) return false;
  if (kind !== AgentIntent.Socialize && kind !== AgentIntent.Help && kind !== AgentIntent.Cooperate) {
    return true;
  }
  const entry = ecs.relationships.find(self, target);
  if (entry === -1) return true; // no relationship yet — nothing has soured
  return ecs.relationships.scoreOf(entry) > -config.social.conflict.minHostility;
}
