/**
 * Culture system (Phase 5) — knowledge maintenance, discovery, teaching and
 * imitation. This is where cultural knowledge actually MOVES between agents.
 *
 * The phase's central rule: culture is acquired through interaction, never
 * through inheritance. A newborn's cultural memory is empty (see
 * reproduction-system.ts) and this system is the only thing that can put
 * anything into it:
 *
 *   1. MAINTENANCE pass (per agent, one bounded walk over its cultural chain):
 *        - successful use reinforces an item (eating where you know food is),
 *        - contradictory experience weakens it (the known patch is empty),
 *        - unused knowledge decays and is eventually forgotten,
 *        - acting on a norm reinforces it; resisting a confrontation does too,
 *        - a successful forage can produce a DISCOVERY (a new item, formed
 *          from the agent's own experience — intelligence-scaled, never
 *          guaranteed).
 *   2. TEACHING pass: agents whose Utility AI chose `Teach` and are close
 *      enough to their chosen learner attempt a deliberate transmission. The
 *      attempt costs energy and starts a cooldown whether or not it succeeds
 *      (time spent teaching is time not spent foraging), and it succeeds with
 *      the documented probability from culture/learning.ts.
 *   3. IMITATION pass: an agent that is actively socializing/helping/foraging
 *      with someone pays attention to them and may pick up an item by
 *      observation (a much lower probability than deliberate teaching).
 *
 * Determinism: iteration follows the entity registry (maintenance) and the
 * dense intent store (teaching/imitation). All randomness comes from the
 * dedicated `culture` RNG stream, so adding culture never shifts the
 * sim/spawn/ai/repro streams.
 *
 * Performance: every pass is bounded — one walk per agent over a bounded chain
 * (<= culture.memory.capacity), plus work proportional to the number of agents
 * that actually chose Teach/Socialize/Help/Cooperate this tick. There are no
 * agent × agent loops and no global propagation anywhere: an item moves only
 * because two agents interacted.
 */

import type { TickContext } from '../tick-context';
import type { EntityId } from '../../ecs';
import { AgentIntent } from '../../ai';
import { clamp01 } from '../../ai/utility';
import {
  KnowledgeOrigin,
  KnowledgeType,
  NormId,
  TECHNIQUE_VARIANT_COUNT,
  describeKnowledge,
  effectiveCulturalDecayPerHour,
  effectiveCulturalLearningRate,
  knowledgeLabel,
  techniqueVariantForTerrain,
  transmissionChance,
  transmissionIsFaithful,
  decayValue,
} from '../../culture';

/** Maximum strength an item can reach (values are always kept in [0, 1]). */
const MAX_STRENGTH = 1;

export function updateCulture(ctx: TickContext): void {
  maintainCulturalMemory(ctx);
  runTeachingPass(ctx);
  runImitationPass(ctx);
}

// --- 1. Maintenance (decay / reinforcement / contradiction / discovery) -----

function maintainCulturalMemory(ctx: TickContext): void {
  const { ecs, config, tick, dtHours, world } = ctx;
  const culture = ecs.culture;
  const culturalMemory = ecs.culturalMemory;
  const genome = ecs.genome;
  const position = ecs.position;
  const intent = ecs.intent;
  const aiState = ecs.aiState;
  const entities = ecs.entities;

  const memoryConfig = config.culture.memory;
  const discovery = config.culture.discovery;
  const resources = config.resources;

  for (let k = 0; k < entities.aliveCount; k++) {
    const entity = entities.aliveIds[k];
    const cultureSlot = culture.index[entity];
    if (cultureSlot < 0) continue;

    if (culture.columns.teachCooldownTicks[cultureSlot] > 0) {
      culture.columns.teachCooldownTicks[cultureSlot]--;
    }

    const genomeSlot = genome.index[entity];
    const intelligence = genomeSlot >= 0 ? genome.columns.intelligence[genomeSlot] : 0;
    const decayPerTick = effectiveCulturalDecayPerHour(intelligence, config) * dtHours;
    const learningRate = effectiveCulturalLearningRate(intelligence, config);

    // What happened to this agent this tick? (read-only context — the systems
    // that produced it ran earlier in the tick, so this is observation, not
    // coordination.)
    const positionSlot = position.index[entity];
    const tileX = positionSlot >= 0 ? Math.floor(position.columns.x[positionSlot]) : -1;
    const tileY = positionSlot >= 0 ? Math.floor(position.columns.y[positionSlot]) : -1;
    const tileIndex = tileX >= 0 && tileY >= 0 ? world.tileIndex(tileX, tileY) : -1;
    const intentSlot = intent.index[entity];
    const kind = intentSlot >= 0 ? intent.columns.kind[intentSlot] : -1;
    // The resource system stamps lastForageTick on a successful Eat/Drink, so
    // "did my forage work?" is a fact, not a guess.
    const foraged = culture.columns.lastForageTick[cultureSlot] === tick;
    const forageType = !foraged
      ? -1
      : kind === AgentIntent.Eat
        ? KnowledgeType.FoodLocation
        : kind === AgentIntent.Drink
          ? KnowledgeType.WaterLocation
          : -1;
    // A confrontation the agent could have started but did not is what makes a
    // restraint norm credible (see the AvoidConflict case below).
    const aiSlot = aiState.index[entity];
    const confrontUrge =
      aiSlot >= 0 && aiState.columns.confront[aiSlot] >= discovery.avoidConflictUrgeThreshold;
    const didHelp = kind === AgentIntent.Help;
    const didCooperate = kind === AgentIntent.Cooperate;

    // --- Decay, use-reinforcement, contradiction and forgetting ------------
    let entry = culturalMemory.headOf(entity);
    while (entry !== -1) {
      const next = culturalMemory.nextOf(entry);
      const strengthBefore = culturalMemory.entryStrength(entry);
      const type = culturalMemory.entryType(entry);

      if (type === KnowledgeType.FoodLocation || type === KnowledgeType.WaterLocation) {
        const atTile = culturalMemory.entryTileX(entry) === tileX && culturalMemory.entryTileY(entry) === tileY;
        if (atTile && tileIndex >= 0) {
          if (forageType === type) {
            // Successful use of the knowledge: the believed location paid off.
            culturalMemory.reinforce(entry, learningRate, tick);
          } else if (
            (type === KnowledgeType.FoodLocation && world.food[tileIndex] < resources.minFoodToEat) ||
            (type === KnowledgeType.WaterLocation && world.water[tileIndex] < resources.minWaterToDrink)
          ) {
            // Contradiction: the agent went to a place it believed in and found
            // nothing. Repeated contradictions erode the item into oblivion.
            culturalMemory.weaken(entry, memoryConfig.contradictionRate);
          }
        }
      } else if (type === KnowledgeType.ForagingTechnique) {
        if (foraged) culturalMemory.reinforce(entry, learningRate, tick);
      } else if (type === KnowledgeType.SocialNorm) {
        const norm = culturalMemory.entryVariant(entry);
        const acted =
          (norm === NormId.HelpOthers && didHelp) ||
          (norm === NormId.ShareFood && didCooperate) ||
          (norm === NormId.AvoidConflict && confrontUrge && kind !== AgentIntent.Confront);
        if (acted) culturalMemory.reinforce(entry, learningRate, tick);
      }

      const decayed = decayValue(Math.min(MAX_STRENGTH, culturalMemory.entryStrength(entry)), decayPerTick);
      if (decayed <= memoryConfig.forgetThreshold) {
        // Forgotten: a confident item fading away is a cultural loss worth
        // reporting. Knowledge decays over in-game days, so this can only fire
        // once per item — it can never flood the log.
        const wasKnown = strengthBefore >= memoryConfig.knownThreshold;
        const label = knowledgeLabel(type, culturalMemory.entryTileX(entry), culturalMemory.entryTileY(entry), culturalMemory.entryVariant(entry));
        culturalMemory.removeEntry(entity, entry);
        if (wasKnown) {
          ctx.cultureStats.lost++;
          ctx.events.record('knowledge_lost', { entityId: entity, detail: `forgot ${label}` });
        }
      } else {
        culturalMemory.setStrength(entry, decayed);
      }
      entry = next;
    }

    // --- Discovery: where a tradition comes from before anyone teaches it ---
    discoverCulturalKnowledge(ctx, entity, intelligence, tileX, tileY, tileIndex, forageType, {
      foraged,
      didHelp,
      didCooperate,
      confrontUrge,
      confronting: kind === AgentIntent.Confront,
    });
  }
}

interface ActivityContext {
  readonly foraged: boolean;
  readonly didHelp: boolean;
  readonly didCooperate: boolean;
  readonly confrontUrge: boolean;
  readonly confronting: boolean;
}

/**
 * Discovery pass for one agent. Discovery is intelligence-scaled but never
 * guaranteed, and it never converts personal memory wholesale: only a small
 * fraction of successful forages produces a *shareable* item, and only ever
 * one item per kind. This is the only way cultural knowledge can come into
 * existence without a transmission event.
 */
function discoverCulturalKnowledge(
  ctx: TickContext,
  entity: EntityId,
  intelligence: number,
  tileX: number,
  tileY: number,
  tileIndex: number,
  forageType: number,
  activity: ActivityContext,
): void {
  const { ecs, config, tick, cultureRng } = ctx;
  const culturalMemory = ecs.culturalMemory;
  const discovery = config.culture.discovery;
  // A dull agent still notices things sometimes; a sharp one notices often.
  const intelligenceFactor = discovery.intelligenceFloor + clamp01(intelligence);

  if (activity.foraged && forageType >= 0 && tileX >= 0 && tileY >= 0) {
    if (culturalMemory.find(entity, forageType, tileX, tileY, 0) === -1) {
      if (cultureRng.chance(discovery.locationChancePerForage * intelligenceFactor)) {
        culturalMemory.learn(
          entity,
          {
            type: forageType,
            tileX,
            tileY,
            variantId: 0,
            strength: config.culture.memory.initialStrength,
            origin: KnowledgeOrigin.Discovered,
            sourceEntity: -1,
          },
          tick,
        );
        ctx.cultureStats.discoveries++;
        ctx.events.record('knowledge_discovered', {
          entityId: entity,
          detail: `${describeKnowledge(forageType, tileX, tileY, 0)} (own experience)`,
        });
      }
    }

    // Techniques are rarer than locations, and habitat-specific: the variant an
    // agent invents usually suits the terrain it lives on, which is what makes
    // neighbouring groups culturally specialized without anyone assigning it.
    if (culturalMemory.bestOfType(entity, KnowledgeType.ForagingTechnique).variant < 0) {
      if (cultureRng.chance(discovery.techniqueChancePerForage * intelligenceFactor)) {
        const native = tileIndex >= 0 ? techniqueVariantForTerrain(ctx.world.terrain[tileIndex]) : 0;
        const variant = cultureRng.chance(discovery.habitatMatchChance)
          ? native
          : cultureRng.nextInt(TECHNIQUE_VARIANT_COUNT);
        culturalMemory.learn(
          entity,
          {
            type: KnowledgeType.ForagingTechnique,
            tileX: -1,
            tileY: -1,
            variantId: variant,
            strength: config.culture.memory.initialStrength,
            origin: KnowledgeOrigin.Discovered,
            sourceEntity: -1,
          },
          tick,
        );
        ctx.cultureStats.discoveries++;
        ctx.cultureStats.variants++;
        ctx.events.record('knowledge_discovered', {
          entityId: entity,
          detail: `${describeKnowledge(KnowledgeType.ForagingTechnique, -1, -1, variant)} (own experience)`,
        });
        ctx.events.record('cultural_variant_created', {
          entityId: entity,
          detail: `new technique variant ${variant}`,
        });
      }
    }
  }

  // Norms come from doing (or deliberately not doing) the thing they are about.
  if (activity.didHelp) tryDiscoverNorm(ctx, entity, NormId.HelpOthers);
  if (activity.didCooperate) tryDiscoverNorm(ctx, entity, NormId.ShareFood);
  if (activity.confrontUrge && !activity.confronting) tryDiscoverNorm(ctx, entity, NormId.AvoidConflict);
}

function tryDiscoverNorm(ctx: TickContext, entity: EntityId, norm: number): void {
  const { ecs, config, tick, cultureRng } = ctx;
  if (ecs.culturalMemory.find(entity, KnowledgeType.SocialNorm, -1, -1, norm) !== -1) return;
  if (!cultureRng.chance(config.culture.discovery.normChancePerTick)) return;
  ecs.culturalMemory.learn(
    entity,
    {
      type: KnowledgeType.SocialNorm,
      tileX: -1,
      tileY: -1,
      variantId: norm,
      strength: config.culture.memory.initialStrength,
      origin: KnowledgeOrigin.Discovered,
      sourceEntity: -1,
    },
    tick,
  );
  ctx.cultureStats.discoveries++;
  ctx.cultureStats.normsLearned++;
  ctx.events.record('knowledge_discovered', {
    entityId: entity,
    detail: `${knowledgeLabel(KnowledgeType.SocialNorm, -1, -1, norm)} (own experience)`,
  });
  ctx.events.record('norm_learned', {
    entityId: entity,
    detail: `adopted the norm: ${knowledgeLabel(KnowledgeType.SocialNorm, -1, -1, norm)}`,
  });
}

// --- 2. Teaching (deliberate, costly, probabilistic) ------------------------

function runTeachingPass(ctx: TickContext): void {
  const { ecs, config } = ctx;
  const intent = ecs.intent;
  const transmission = config.culture.transmission;
  const reachSq = config.social.interaction.radiusTiles * config.social.interaction.radiusTiles;
  const culture = ecs.culture;
  const position = ecs.position;

  for (let i = 0; i < intent.count; i++) {
    if (intent.columns.kind[i] !== AgentIntent.Teach) continue;
    const teacher = intent.entityOf[i];
    const learner = intent.columns.targetEntity[i];
    if (learner < 0 || learner === teacher) continue;
    if (!ecs.entities.isAlive(learner)) continue;

    const teacherCultureSlot = culture.index[teacher];
    if (teacherCultureSlot < 0) continue;
    if (culture.columns.teachCooldownTicks[teacherCultureSlot] > 0) continue;

    // A teacher must be able to spare the effort.
    const teacherNeedsSlot = ecs.needs.index[teacher];
    const teacherHealthSlot = ecs.health.index[teacher];
    if (teacherNeedsSlot < 0) continue;
    if (ecs.needs.columns.energy[teacherNeedsSlot] < transmission.minTeacherEnergy) continue;
    if (teacherHealthSlot >= 0 && ecs.health.columns.current[teacherHealthSlot] < transmission.minTeacherHealth) {
      continue;
    }

    const teacherPositionSlot = position.index[teacher];
    const learnerPositionSlot = position.index[learner];
    if (teacherPositionSlot < 0 || learnerPositionSlot < 0) continue;
    const dx = position.columns.x[learnerPositionSlot] - position.columns.x[teacherPositionSlot];
    const dy = position.columns.y[learnerPositionSlot] - position.columns.y[teacherPositionSlot];
    if (dx * dx + dy * dy > reachSq) continue; // still travelling toward the learner

    const entry = selectTeachItem(ctx, teacher, learner);
    // Nothing new to offer: the attempt does not happen at all (no cost). The
    // Utility AI already refuses to target a learner that knows the teacher's
    // best item; this is the general case.
    if (entry === -1) continue;

    // Teaching costs regardless of the outcome — that is the whole point.
    ecs.needs.columns.energy[teacherNeedsSlot] = Math.max(
      0,
      ecs.needs.columns.energy[teacherNeedsSlot] - transmission.teachEnergyCost,
    );
    culture.columns.teachCooldownTicks[teacherCultureSlot] = transmission.cooldownTicks;

    const itemStrength = ecs.culturalMemory.entryStrength(entry);
    if (!rollTransmission(ctx, learner, teacher, itemStrength, transmission.teachChance)) continue;
    applyTransmission(ctx, teacher, learner, entry, KnowledgeOrigin.Taught);
  }
}

/**
 * Roll against the documented transmission formula (see culture/learning.ts).
 * `source` is whoever holds the knowledge, `learner` is whoever might receive
 * it; affinity and familiarity are read from the LEARNER's side of the
 * relationship — how well the learner knows the source is what governs how
 * much of it takes — while the source's social tendency stands in for how
 * motivated/methodical the demonstration is.
 */
function rollTransmission(
  ctx: TickContext,
  learner: EntityId,
  source: EntityId,
  itemStrength: number,
  base: number,
): boolean {
  const { ecs, config, cultureRng } = ctx;
  const relationship = ecs.relationships.find(learner, source);
  const factors = {
    relationshipScore: relationship === -1 ? 0 : ecs.relationships.scoreOf(relationship),
    familiarity: relationship === -1 ? 0 : ecs.relationships.familiarityOf(relationship),
    learnerIntelligence: genomeValue(ecs, learner, 'intelligence'),
    teacherSocialTendency: genomeValue(ecs, source, 'socialTendency'),
    itemStrength,
  };
  return cultureRng.chance(transmissionChance(base, factors, config));
}

function genomeValue(ecs: TickContext['ecs'], entity: EntityId, trait: 'intelligence' | 'socialTendency'): number {
  const slot = ecs.genome.index[entity];
  return slot >= 0 ? ecs.genome.columns[trait][slot] : 0;
}

/**
 * The item a teacher would pass on: the strongest item it holds above the
 * "known" threshold that the learner does not already hold. Scanning the
 * learner per teacher-item is O(capacity²), which is bounded (≈100 integer
 * comparisons) and only happens for agents that actually chose Teach.
 */
function selectTeachItem(ctx: TickContext, teacher: EntityId, learner: EntityId): number {
  const knownThreshold = ctx.config.culture.memory.knownThreshold;
  const culturalMemory = ctx.ecs.culturalMemory;
  let chosen = -1;
  let bestStrength = 0;
  for (let e = culturalMemory.headOf(teacher); e !== -1; e = culturalMemory.nextOf(e)) {
    const strength = culturalMemory.entryStrength(e);
    if (strength < knownThreshold || strength <= bestStrength) continue;
    const learnerStrength = culturalMemory.strengthOf(
      learner,
      culturalMemory.entryType(e),
      culturalMemory.entryTileX(e),
      culturalMemory.entryTileY(e),
      culturalMemory.entryVariant(e),
    );
    if (learnerStrength > 0) continue; // already knows it
    bestStrength = strength;
    chosen = e;
  }
  return chosen;
}

/**
 * Copy an item from teacher to learner, applying transmission fidelity.
 * A failed fidelity check produces a *variant*: the believed location drifts a
 * few tiles, or the technique/norm token shifts to a neighbouring variant.
 * Variants are small and bounded — this is where cultural drift comes from, and
 * it only ever happens during an actual transmission event.
 */
function applyTransmission(
  ctx: TickContext,
  teacher: EntityId,
  learner: EntityId,
  teacherEntry: number,
  origin: number,
): void {
  const { ecs, config, tick, cultureRng } = ctx;
  const culturalMemory = ecs.culturalMemory;
  const transmission = config.culture.transmission;
  const type = culturalMemory.entryType(teacherEntry);
  const strength = culturalMemory.entryStrength(teacherEntry);
  let tileX = culturalMemory.entryTileX(teacherEntry);
  let tileY = culturalMemory.entryTileY(teacherEntry);
  let variantId = culturalMemory.entryVariant(teacherEntry);

  const faithful = transmissionIsFaithful(transmission.fidelity, cultureRng.nextFloat());
  if (!faithful) {
    if (type === KnowledgeType.FoodLocation || type === KnowledgeType.WaterLocation) {
      const jitter = transmission.locationJitterTiles;
      tileX = clampTile(cultureRng.nextInt(2 * jitter + 1) - jitter + tileX, ctx.world.width);
      tileY = clampTile(cultureRng.nextInt(2 * jitter + 1) - jitter + tileY, ctx.world.height);
    } else {
      variantId = shiftVariant(type, variantId, cultureRng.nextInt(3) - 1);
    }
  }

  const learnedStrength = clamp01(strength * transmission.learnedStrengthFactor);
  const { created } = culturalMemory.learn(
    learner,
    { type, tileX, tileY, variantId, strength: learnedStrength, origin, sourceEntity: teacher },
    tick,
  );
  if (!created) return; // the learner already held this exact item

  const label = describeKnowledge(type, tileX, tileY, variantId);
  if (type === KnowledgeType.SocialNorm) {
    ctx.cultureStats.normsLearned++;
    ctx.events.record('norm_learned', {
      entityId: learner,
      detail: `learned the norm: ${label} (from #${teacher})`,
    });
  }
  if (origin === KnowledgeOrigin.Taught) {
    ctx.cultureStats.taught++;
    ctx.events.record('knowledge_taught', {
      entityId: teacher,
      detail: `taught #${learner}: ${label}`,
    });
    // Successful teaching confirms the teacher's own knowledge.
    culturalMemory.reinforce(
      teacherEntry,
      effectiveCulturalLearningRate(genomeValue(ecs, teacher, 'intelligence'), config),
      tick,
    );
  } else {
    ctx.cultureStats.learned++;
    ctx.events.record('knowledge_learned', {
      entityId: learner,
      detail: `picked up ${label} from #${teacher}`,
    });
  }
  if (!faithful) {
    ctx.cultureStats.variants++;
    ctx.events.record('cultural_variant_created', {
      entityId: learner,
      detail: `variant of ${label} (via #${teacher})`,
    });
  }
}

/** Shift a technique/norm variant by a bounded offset, wrapping deterministically. */
function shiftVariant(type: number, variant: number, offset: number): number {
  const count = type === KnowledgeType.ForagingTechnique ? TECHNIQUE_VARIANT_COUNT : 3; // 3 norms
  if (count <= 1) return variant;
  return ((variant + offset) % count + count) % count;
}

function clampTile(value: number, size: number): number {
  return value < 0 ? 0 : value > size - 1 ? size - 1 : value;
}

// --- 3. Imitation (observation during a social interaction) -----------------

function runImitationPass(ctx: TickContext): void {
  const { ecs, config } = ctx;
  const intent = ecs.intent;
  const imitateChance = config.culture.transmission.imitateChance;
  const reachSq = config.social.interaction.radiusTiles * config.social.interaction.radiusTiles;
  const position = ecs.position;
  const culture = ecs.culture;

  for (let i = 0; i < intent.count; i++) {
    const kind = intent.columns.kind[i];
    if (
      kind !== AgentIntent.Socialize &&
      kind !== AgentIntent.Help &&
      kind !== AgentIntent.Cooperate
    ) {
      continue;
    }
    const observer = intent.entityOf[i];
    const model = intent.columns.targetEntity[i];
    if (model < 0 || model === observer || !ecs.entities.isAlive(model)) continue;
    const observerPositionSlot = position.index[observer];
    const modelPositionSlot = position.index[model];
    if (observerPositionSlot < 0 || modelPositionSlot < 0) continue;
    const dx = position.columns.x[modelPositionSlot] - position.columns.x[observerPositionSlot];
    const dy = position.columns.y[modelPositionSlot] - position.columns.y[observerPositionSlot];
    if (dx * dx + dy * dy > reachSq) continue; // not close enough to watch anyone

    const modelCultureSlot = culture.index[model];
    if (modelCultureSlot < 0) continue;

    // (a) Watching someone succeed at foraging teaches you WHERE the resource
    //     is — the classic observation-driven cultural pathway, grounded in
    //     something the observer can see for itself.
    if (culture.columns.lastForageTick[modelCultureSlot] === ctx.tick) {
      const modelIntentSlot = intent.index[model];
      const modelKind = modelIntentSlot >= 0 ? intent.columns.kind[modelIntentSlot] : -1;
      const forageType =
        modelKind === AgentIntent.Eat
          ? KnowledgeType.FoodLocation
          : modelKind === AgentIntent.Drink
            ? KnowledgeType.WaterLocation
            : -1;
      if (forageType >= 0) {
        const tileX = Math.floor(position.columns.x[modelPositionSlot]);
        const tileY = Math.floor(position.columns.y[modelPositionSlot]);
        if (
          ecs.culturalMemory.find(observer, forageType, tileX, tileY, 0) === -1 &&
          rollTransmission(ctx, observer, model, config.culture.memory.initialStrength, imitateChance * 0.5)
        ) {
          ecs.culturalMemory.learn(
            observer,
            {
              type: forageType,
              tileX,
              tileY,
              variantId: 0,
              strength: config.culture.memory.initialStrength,
              origin: KnowledgeOrigin.Imitated,
              sourceEntity: model,
            },
            ctx.tick,
          );
          ctx.cultureStats.learned++;
          ctx.events.record('knowledge_learned', {
            entityId: observer,
            detail: `saw #${model} forage at ${tileX},${tileY}`,
          });
        }
        continue; // one observation pathway per interaction
      }
    }

    // (b) Otherwise the observer may simply copy the model's strongest item it
    //     does not have — much weaker than being taught on purpose.
    const entry = selectImitationItem(ctx, observer, model);
    if (entry === -1) continue;
    if (!rollTransmission(ctx, observer, model, ecs.culturalMemory.entryStrength(entry), imitateChance)) continue;
    applyTransmission(ctx, model, observer, entry, KnowledgeOrigin.Imitated);
  }
}

/** Strongest item the model holds (above the known threshold) that the observer lacks. */
function selectImitationItem(ctx: TickContext, observer: EntityId, model: EntityId): number {
  const knownThreshold = ctx.config.culture.memory.knownThreshold;
  const culturalMemory = ctx.ecs.culturalMemory;
  let chosen = -1;
  let bestStrength = 0;
  for (let e = culturalMemory.headOf(model); e !== -1; e = culturalMemory.nextOf(e)) {
    const strength = culturalMemory.entryStrength(e);
    if (strength < knownThreshold || strength <= bestStrength) continue;
    const observerStrength = culturalMemory.strengthOf(
      observer,
      culturalMemory.entryType(e),
      culturalMemory.entryTileX(e),
      culturalMemory.entryTileY(e),
      culturalMemory.entryVariant(e),
    );
    if (observerStrength > 0) continue;
    bestStrength = strength;
    chosen = e;
  }
  return chosen;
}
