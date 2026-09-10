/**
 * Social interaction system (Phase 4) — executes the consequences of social
 * intents, exactly like the resource system executes Eat/Drink.
 *
 * Two passes per tick:
 *
 * 1. PRESENCE PASS — walking each agent's own (bounded) relationship chain and
 *    bumping familiarity for partners within the presence radius. Cost is
 *    O(population × relationshipCapacity) — no spatial-index scan needed,
 *    because only already-remembered agents matter here.
 *
 * 2. INTERACTION PASS — for agents whose intent is Socialize / Help /
 *    Cooperate / Confront and whose target is within interaction reach:
 *    bonds form, help is delivered at a cost, cooperation sessions progress
 *    and complete, and conflicts resolve with damage + de-escalation.
 *
 * Relationship updates are applied to BOTH directions (an agent's view of the
 * other, and vice versa) with different magnitudes — the helped agent's trust
 * grows faster than the helper's, which is the reciprocity core.
 *
 * Determinism: fixed iteration orders (dense intent slots; relationship chain
 * order); every update is bounded arithmetic; no randomness at all — social
 * outcomes are pure functions of state (the AI's tie-break jitter already ran
 * on the `ai` stream when the intent was chosen).
 */

import type { TickContext } from '../tick-context';
import type { EntityId, SimulationEcs } from '../../ecs';
import { AgentIntent } from '../../ai';
import { KinshipType, kinshipBetween } from '../../social/kinship';
import type { RelationshipStore } from '../../social/relationship-store';

/**
 * Quantization band for relationship scores (events fire when the band
 * changes, i.e. when a relationship crosses a ±0.25 boundary — never per
 * interaction tick).
 */
function relationshipBand(score: number): number {
  const clamped = score < -1 ? -1 : score > 1 ? 1 : score;
  return Math.trunc(clamped * 4);
}

/**
 * Move a directed relationship's score by a delta, clamped to [−1, 1], and
 * emit `relationship_changed` when the score crossed a band boundary.
 */
function adjustScore(
  relationships: RelationshipStore,
  entry: number,
  delta: number,
  self: EntityId,
  target: EntityId,
  ctx: TickContext,
): void {
  const before = relationships.scoreOf(entry);
  const beforeBand = relationshipBand(before);
  relationships.setScore(entry, before + delta);
  const after = relationships.scoreOf(entry);
  if (relationshipBand(after) !== beforeBand) {
    ctx.events.record('relationship_changed', {
      entityId: self,
      detail: `with #${target}: ${after >= 0 ? '+' : ''}${after.toFixed(2)} (trust ${relationships.trustOf(entry).toFixed(2)})`,
    });
  }
}

/** Create (or fetch) both directions of a pair relationship. */
function ensurePair(
  ecs: SimulationEcs,
  self: EntityId,
  target: EntityId,
  tick: number,
): { outgoing: number; incoming: number; created: boolean } {
  const kin = kinshipBetween(self, target, ecs) !== KinshipType.None;
  const outgoing = ecs.relationships.getOrCreate(self, target, tick, kin);
  const incoming = ecs.relationships.getOrCreate(target, self, tick, kin);
  // Recognized kin gets flagged even on a pre-existing entry (e.g. siblings
  // meeting for the first time).
  if (kin) {
    ecs.relationships.setKin(outgoing.entry, true);
    ecs.relationships.setKin(incoming.entry, true);
  }
  return { outgoing: outgoing.entry, incoming: incoming.entry, created: outgoing.created || incoming.created };
}

export function updateSocialInteractions(ctx: TickContext): void {
  const { ecs, config, events, tick } = ctx;
  const socialConfig = config.social;
  const relationships = ecs.relationships;
  const position = ecs.position;
  const socialStore = ecs.social;
  const presenceSq = socialConfig.perception.presenceRadiusTiles * socialConfig.perception.presenceRadiusTiles;
  const familiarityPerTickNear = socialConfig.perception.familiarityPerTickNear;

  // --- 1. Presence pass: close co-presence slowly builds familiarity -------
  const entities = ecs.entities;
  for (let k = 0; k < entities.aliveCount; k++) {
    const entity = entities.aliveIds[k];
    const posSlot = position.index[entity];
    if (posSlot < 0) continue;
    const x = position.columns.x[posSlot];
    const y = position.columns.y[posSlot];
    for (let e = relationships.headOf(entity); e !== -1; e = relationships.nextOf(e)) {
      const target = relationships.targetOf(e);
      const tSlot = target >= 0 ? position.index[target] : -1;
      if (tSlot < 0) continue;
      const dx = position.columns.x[tSlot] - x;
      const dy = position.columns.y[tSlot] - y;
      if (dx * dx + dy * dy > presenceSq) continue;
      relationships.setFamiliarity(e, relationships.familiarityOf(e) + familiarityPerTickNear);
    }
  }

  // --- 2. Interaction pass ---------------------------------------------------
  const intent = ecs.intent;
  const interactionSq = socialConfig.interaction.radiusTiles * socialConfig.interaction.radiusTiles;
  // Cooperation sessions tolerate a little lag (follower trailing the
  // partner) before their progress resets: twice the interaction radius.
  const sessionKeepSq = interactionSq * 4;
  const cooperation = socialConfig.cooperation;
  const help = socialConfig.help;
  const conflict = socialConfig.conflict;
  const socialize = socialConfig.socialize;
  const loneliness = socialConfig.loneliness;

  for (let i = 0; i < intent.count; i++) {
    const kind = intent.columns.kind[i];
    const isCooperate = kind === AgentIntent.Cooperate;
    if (
      !isCooperate &&
      kind !== AgentIntent.Socialize &&
      kind !== AgentIntent.Help &&
      kind !== AgentIntent.Confront
    ) {
      continue;
    }
    const self = intent.entityOf[i];
    const target = intent.columns.targetEntity[i];
    const selfSocialSlot = socialStore.index[self];
    if (selfSocialSlot < 0) continue;

    // Cooperation session bookkeeping happens even when the target is
    // temporarily invalid, so abandoned sessions never linger.
    if (isCooperate && (target < 0 || !entities.isAlive(target))) {
      if (socialStore.columns.cooperationTarget[selfSocialSlot] !== -1) {
        socialStore.columns.cooperationTarget[selfSocialSlot] = -1;
        socialStore.columns.cooperationTicks[selfSocialSlot] = 0;
      }
      continue;
    }
    if (target < 0 || !entities.isAlive(target)) continue;

    const selfSlot = position.index[self];
    const targetSlot = position.index[target];
    if (selfSlot < 0 || targetSlot < 0) continue;
    const dx = position.columns.x[targetSlot] - position.columns.x[selfSlot];
    const dy = position.columns.y[targetSlot] - position.columns.y[selfSlot];
    const distSq = dx * dx + dy * dy;

    if (isCooperate) {
      // Session lifecycle: (re)start with a target, progress while close,
      // reset progress when the partner drifts out of session range.
      if (socialStore.columns.cooperationTarget[selfSocialSlot] !== target) {
        const outgoing = relationships.find(self, target);
        if (outgoing !== -1 && relationships.pairCooldownUntilOf(outgoing) > tick) {
          continue; // completed recently — the AI utility is already 0 for this pair
        }
        socialStore.columns.cooperationTarget[selfSocialSlot] = target;
        socialStore.columns.cooperationTicks[selfSocialSlot] = 0;
        events.record('cooperation_started', { entityId: self, detail: `partner=${target}` });
      }
      if (distSq > sessionKeepSq) {
        socialStore.columns.cooperationTicks[selfSocialSlot] = 0; // paused, not aborted
        continue;
      }

      // Per-tick coordination cost (on top of the generic active-energy drain).
      const needsSlot = ecs.needs.index[self];
      if (needsSlot >= 0) {
        ecs.needs.columns.energy[needsSlot] = Math.max(
          0,
          ecs.needs.columns.energy[needsSlot] - cooperation.energyCostPerTick,
        );
      }
      const ticks = socialStore.columns.cooperationTicks[selfSocialSlot] + 1;
      socialStore.columns.cooperationTicks[selfSocialSlot] = ticks;
      if (ticks < cooperation.durationTicks) continue;

      // Session complete: bond both directions, grant foraging efficiency.
      const pair = ensurePair(ecs, self, target, tick);
      adjustScore(relationships, pair.outgoing, cooperation.scoreGain, self, target, ctx);
      adjustScore(relationships, pair.incoming, cooperation.scoreGain, target, self, ctx);
      relationships.setTrust(pair.outgoing, relationships.trustOf(pair.outgoing) + cooperation.trustGain);
      relationships.setTrust(pair.incoming, relationships.trustOf(pair.incoming) + cooperation.trustGain);
      relationships.setFamiliarity(pair.outgoing, relationships.familiarityOf(pair.outgoing) + cooperation.familiarityGain);
      relationships.setFamiliarity(pair.incoming, relationships.familiarityOf(pair.incoming) + cooperation.familiarityGain);
      relationships.incrementPositive(pair.outgoing);
      relationships.incrementPositive(pair.incoming);
      relationships.setLastInteractionTick(pair.outgoing, tick);
      relationships.setLastInteractionTick(pair.incoming, tick);
      relationships.setPairCooldownUntil(pair.outgoing, tick + cooperation.cooldownTicks);
      relationships.setPairCooldownUntil(pair.incoming, tick + cooperation.cooldownTicks);

      socialStore.columns.forageBonusTicks[selfSocialSlot] = Math.min(
        65535,
        socialStore.columns.forageBonusTicks[selfSocialSlot] + cooperation.forageBonusTicks,
      );
      const targetSocialSlot = socialStore.index[target];
      if (targetSocialSlot >= 0) {
        socialStore.columns.forageBonusTicks[targetSocialSlot] = Math.min(
          65535,
          socialStore.columns.forageBonusTicks[targetSocialSlot] + cooperation.partnerForageBonusTicks,
        );
      }

      socialStore.columns.cooperationTarget[selfSocialSlot] = -1;
      socialStore.columns.cooperationTicks[selfSocialSlot] = 0;
      ctx.socialStats.cooperationEvents++;
      events.record('cooperation_completed', { entityId: self, detail: `partner=${target}` });
      continue;
    }

    if (distSq > interactionSq) continue; // still traveling toward the target

    if (kind === AgentIntent.Socialize) {
      const pair = ensurePair(ecs, self, target, tick);
      adjustScore(relationships, pair.outgoing, socialize.scoreGain, self, target, ctx);
      adjustScore(relationships, pair.incoming, socialize.scoreGain, target, self, ctx);
      relationships.setTrust(pair.outgoing, relationships.trustOf(pair.outgoing) + socialize.trustGain);
      relationships.setTrust(pair.incoming, relationships.trustOf(pair.incoming) + socialize.trustGain);
      relationships.setFamiliarity(pair.outgoing, relationships.familiarityOf(pair.outgoing) + socialize.familiarityGain);
      relationships.setFamiliarity(pair.incoming, relationships.familiarityOf(pair.incoming) + socialize.familiarityGain);
      relationships.incrementPositive(pair.outgoing);
      relationships.incrementPositive(pair.incoming);
      relationships.setLastInteractionTick(pair.outgoing, tick);
      relationships.setLastInteractionTick(pair.incoming, tick);

      // Loneliness relief — stronger for the initiator.
      socialStore.columns.loneliness[selfSocialSlot] = Math.max(
        0,
        socialStore.columns.loneliness[selfSocialSlot] - loneliness.reliefPerSocialize,
      );
      const targetSocialSlot = socialStore.index[target];
      if (targetSocialSlot >= 0) {
        socialStore.columns.loneliness[targetSocialSlot] = Math.max(
          0,
          socialStore.columns.loneliness[targetSocialSlot] - loneliness.reliefPerSocializePassive,
        );
      }

      if (pair.created) {
        ctx.socialStats.socialInteractionEvents++;
        events.record('social_interaction', { entityId: self, detail: `met #${target}` });
      }
      continue;
    }

    if (kind === AgentIntent.Help) {
      // The target must still be in need — otherwise the trip was wasted
      // (a natural opportunity cost of helping).
      const targetHealthSlot = ecs.health.index[target];
      const targetNeedsSlot = ecs.needs.index[target];
      if (targetHealthSlot < 0 || targetNeedsSlot < 0) continue;
      const targetHealth = ecs.health.columns.current[targetHealthSlot];
      const targetEnergy = ecs.needs.columns.energy[targetNeedsSlot];
      if (targetHealth >= help.healthNeedBelow && targetEnergy >= help.energyNeedBelow) continue;

      // Cost to the helper, benefit to the helped.
      const selfNeedsSlot = ecs.needs.index[self];
      if (selfNeedsSlot >= 0) {
        ecs.needs.columns.energy[selfNeedsSlot] = Math.max(
          0,
          ecs.needs.columns.energy[selfNeedsSlot] - help.energyCost,
        );
      }
      ecs.health.columns.current[targetHealthSlot] = Math.min(100, targetHealth + help.healthBenefit);
      ecs.needs.columns.energy[targetNeedsSlot] = Math.min(100, targetEnergy + help.energyBenefit);

      // Reciprocity: the helped agent's trust toward the helper rises
      // strongly; the helper's regard rises mildly.
      const pair = ensurePair(ecs, self, target, tick);
      adjustScore(relationships, pair.incoming, help.scoreGainTarget, target, self, ctx);
      adjustScore(relationships, pair.outgoing, help.scoreGainHelper, self, target, ctx);
      relationships.setTrust(pair.incoming, relationships.trustOf(pair.incoming) + help.trustGain);
      relationships.setFamiliarity(pair.outgoing, relationships.familiarityOf(pair.outgoing) + socialize.familiarityGain);
      relationships.setFamiliarity(pair.incoming, relationships.familiarityOf(pair.incoming) + socialize.familiarityGain);
      relationships.incrementPositive(pair.incoming);
      relationships.setLastInteractionTick(pair.outgoing, tick);
      relationships.setLastInteractionTick(pair.incoming, tick);

      ctx.socialStats.helpEvents++;
      events.record('helped_agent', { entityId: self, detail: `helped #${target}` });
      continue;
    }

    // --- Confront -----------------------------------------------------------
    const outgoing = relationships.find(self, target);
    const incoming = relationships.find(target, self);
    if (outgoing === -1 || incoming === -1) continue; // no history -> no fight
    if (relationships.pairCooldownUntilOf(outgoing) > tick) continue; // pair cooldown

    const genome = ecs.genome;
    const selfGenomeSlot = genome.index[self];
    const targetGenomeSlot = genome.index[target];
    const selfStrength = selfGenomeSlot >= 0 ? genome.columns.strength[selfGenomeSlot] : 0;
    const targetStrength = targetGenomeSlot >= 0 ? genome.columns.strength[targetGenomeSlot] : 0;
    // Strength decides; the initiator wins exact ties (deterministic).
    const selfWins = selfStrength >= targetStrength;
    const winner = selfWins ? self : target;
    const loser = selfWins ? target : self;

    const winnerHealthSlot = ecs.health.index[winner];
    const loserHealthSlot = ecs.health.index[loser];
    if (winnerHealthSlot >= 0) {
      ecs.health.columns.current[winnerHealthSlot] = Math.max(
        0,
        ecs.health.columns.current[winnerHealthSlot] - conflict.damageToWinner,
      );
    }
    if (loserHealthSlot >= 0) {
      ecs.health.columns.current[loserHealthSlot] = Math.max(
        0,
        ecs.health.columns.current[loserHealthSlot] - conflict.damage,
      );
    }

    // Both directions sour; fear (trust loss) drives future avoidance.
    adjustScore(relationships, outgoing, -conflict.scoreDamage, self, target, ctx);
    adjustScore(relationships, incoming, -conflict.scoreDamage, target, self, ctx);
    relationships.setTrust(outgoing, relationships.trustOf(outgoing) - conflict.trustDamage);
    relationships.setTrust(incoming, relationships.trustOf(incoming) - conflict.trustDamage);
    relationships.incrementNegative(outgoing);
    relationships.incrementNegative(incoming);
    relationships.setLastInteractionTick(outgoing, tick);
    relationships.setLastInteractionTick(incoming, tick);
    relationships.setPairCooldownUntil(outgoing, tick + conflict.cooldownTicks);
    relationships.setPairCooldownUntil(incoming, tick + conflict.cooldownTicks);

    // The loser is pushed away from the winner (deterministic direction,
    // clamped to the world). Rare exact overlap pushes along a fixed diagonal.
    const loserPosSlot = position.index[loser];
    const winnerPosSlot = position.index[winner];
    if (loserPosSlot >= 0 && winnerPosSlot >= 0) {
      const lx = position.columns.x[loserPosSlot];
      const ly = position.columns.y[loserPosSlot];
      let pushX = lx - position.columns.x[winnerPosSlot];
      let pushY = ly - position.columns.y[winnerPosSlot];
      let lenSq = pushX * pushX + pushY * pushY;
      if (lenSq <= 1e-9) {
        pushX = winner % 2 === 0 ? 0.7071 : -0.7071;
        pushY = winner % 2 === 0 ? 0.7071 : -0.7071;
        lenSq = 1;
      }
      const len = Math.sqrt(lenSq);
      position.columns.x[loserPosSlot] = Math.min(
        ctx.world.width - 1,
        Math.max(0, lx + (pushX / len) * conflict.knockbackTiles),
      );
      position.columns.y[loserPosSlot] = Math.min(
        ctx.world.height - 1,
        Math.max(0, ly + (pushY / len) * conflict.knockbackTiles),
      );
    }

    const winnerSocialSlot = socialStore.index[winner];
    const loserSocialSlot = socialStore.index[loser];
    if (winnerSocialSlot >= 0) socialStore.columns.lastConflictTick[winnerSocialSlot] = tick;
    if (loserSocialSlot >= 0) socialStore.columns.lastConflictTick[loserSocialSlot] = tick;

    ctx.socialStats.conflictEvents++;
    events.record('conflict', { entityId: winner, detail: `winner=#${winner} loser=#${loser}` });
  }
}
