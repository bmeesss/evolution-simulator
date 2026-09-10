/**
 * Signal system (Phase 5) — proto-communication: emitting tokens and learning
 * what they mean by observing them in context.
 *
 * THIS IS SCAFFOLDING, NOT LANGUAGE. Signals are a fixed alphabet of arbitrary
 * tokens (Signal_01 … Signal_16); no token has an authored meaning anywhere in
 * the codebase. Meaning is only ever an ASSOCIATION an individual agent built
 * from repeated observation, and this system is the only thing that can build
 * one:
 *
 *   1. MAINTENANCE: association decay and forgetting, cooldown/alert ticks.
 *   2. EMISSION: agents whose Utility AI chose a signalling action and are
 *      off cooldown with energy to spare pay for the emission and pick a token:
 *      the token they already associate with the meaning they intend, or — if
 *      they have none — a token invented from the `culture` RNG stream.
 *      Invention is what lets independent groups settle on different tokens for
 *      the same meaning.
 *   3. LISTENING: for every emission this tick, the listeners within
 *      `culture.signals.hearingRadiusTiles` are found through the *existing*
 *      social spatial index (3×3 cells around the emitter) — never by scanning
 *      the population. Each listener updates its association between the token
 *      it heard and the meaning it can ground in the emitter's observable
 *      situation (danger / food / water / help / travelling). Competing
 *      meanings of the same token decay, so a token drifts toward one meaning
 *      instead of accumulating an unbounded cloud. A listener that already
 *      knows a heard token as DANGER becomes alert — knowledge changes
 *      behaviour, and it only does so for a meaning the listener actually has.
 *
 * Cost and attention: an emission costs energy and starts a cooldown (no
 * broadcasting loops), and each listener processes at most
 * `maxObservationsPerTick` signals per tick (bounded attention). Nothing is
 * ever broadcast globally: an emission reaches exactly the agents standing
 * close enough to hear it.
 *
 * Determinism: emission order is the dense intent-store order; the listener
 * walk follows the spatial index chains; all randomness comes from the
 * dedicated `culture` RNG stream.
 */

import type { TickContext } from '../tick-context';
import type { EntityId } from '../../ecs';
import { AgentIntent } from '../../ai';
import { reinforceValue, decayValue } from '../../ai/memory';
import { KinshipType, kinshipBetween } from '../../social/kinship';
import {
  SIGNAL_TOKEN_COUNT,
  SignalMeaning,
  competingMeaningDecay,
  effectiveSignalDecayPerHour,
  effectiveSignalLearningRate,
  signalMeaningName,
  signalTokenName,
} from '../../culture';

export function updateSignals(ctx: TickContext): void {
  maintainSignals(ctx);
  const emissions = emitSignals(ctx);
  listenToSignals(ctx, emissions);
}

// --- 1. Maintenance: decay, forgetting, cooldowns ---------------------------

function maintainSignals(ctx: TickContext): void {
  const { ecs, config, dtHours } = ctx;
  const culture = ecs.culture;
  const signals = ecs.signals;
  const genome = ecs.genome;
  const entities = ecs.entities;
  const signalConfig = config.culture.signals;

  for (let k = 0; k < entities.aliveCount; k++) {
    const entity = entities.aliveIds[k];
    const cultureSlot = culture.index[entity];
    if (cultureSlot < 0) continue;
    if (culture.columns.signalCooldownTicks[cultureSlot] > 0) culture.columns.signalCooldownTicks[cultureSlot]--;
    if (culture.columns.alertTicks[cultureSlot] > 0) culture.columns.alertTicks[cultureSlot]--;

    if (!signals.has(entity)) continue;
    const genomeSlot = genome.index[entity];
    const intelligence = genomeSlot >= 0 ? genome.columns.intelligence[genomeSlot] : 0;
    const decayPerTick = effectiveSignalDecayPerHour(intelligence, config) * dtHours;

    let entry = signals.headOf(entity);
    while (entry !== -1) {
      const next = signals.nextOf(entry);
      const decayed = decayValue(signals.entryStrength(entry), decayPerTick);
      if (decayed <= signalConfig.forgetThreshold) {
        signals.removeEntry(entity, entry);
      } else {
        signals.setStrength(entry, decayed);
      }
      entry = next;
    }
  }
}

// --- 2. Emission -------------------------------------------------------------

interface EmissionBatch {
  count: number;
}

/**
 * Module-level emission scratch: the emitters of the current tick, in dense
 * intent order. Reused every tick (grown on demand) so the emission pass
 * allocates nothing.
 */
const emitterScratch = {
  entities: new Int32Array(256),
  tokens: new Uint8Array(256),
};

/** Per-listener attention budget for the current tick (stamped, never cleared). */
const attentionScratch = {
  counts: new Uint8Array(1024),
  stamps: new Uint32Array(1024),
};
let attentionStamp = 0;

function ensureAttentionCapacity(entity: EntityId): void {
  if (entity < attentionScratch.counts.length) return;
  let capacity = attentionScratch.counts.length;
  while (capacity <= entity) capacity *= 2;
  const counts = new Uint8Array(capacity);
  counts.set(attentionScratch.counts);
  attentionScratch.counts = counts;
  const stamps = new Uint32Array(capacity);
  stamps.set(attentionScratch.stamps);
  attentionScratch.stamps = stamps;
}

function emitSignals(ctx: TickContext): EmissionBatch {
  const { ecs, config, tick } = ctx;
  const intent = ecs.intent;
  const culture = ecs.culture;
  const needs = ecs.needs;
  const signalConfig = config.culture.signals;

  let count = 0;
  for (let i = 0; i < intent.count; i++) {
    const meaning = signalMeaningForIntent(intent.columns.kind[i]);
    if (meaning < 0) continue;
    const entity = intent.entityOf[i];
    const cultureSlot = culture.index[entity];
    const needsSlot = needs.index[entity];
    if (cultureSlot < 0 || needsSlot < 0) continue;
    if (culture.columns.signalCooldownTicks[cultureSlot] > 0) continue;
    const energy = needs.columns.energy[needsSlot];
    if (energy < signalConfig.minEnergyToEmit) continue;

    // Communication is never free: energy out, cooldown started.
    needs.columns.energy[needsSlot] = Math.max(0, energy - signalConfig.emissionEnergyCost);
    culture.columns.signalCooldownTicks[cultureSlot] = signalConfig.emissionCooldownTicks;

    const token = chooseEmissionToken(ctx, entity, meaning);
    culture.columns.lastSignalToken[cultureSlot] = token;
    culture.columns.lastSignalTick[cultureSlot] = tick;
    ctx.cultureStats.signalsEmitted++;

    if (count >= emitterScratch.entities.length) {
      growEmitterScratch();
    }
    emitterScratch.entities[count] = entity;
    emitterScratch.tokens[count] = token;
    count++;
  }
  return { count };
}

function growEmitterScratch(): void {
  const capacity = emitterScratch.entities.length * 2;
  const entities = new Int32Array(capacity);
  entities.set(emitterScratch.entities);
  emitterScratch.entities = entities;
  const tokens = new Uint8Array(capacity);
  tokens.set(emitterScratch.tokens);
  emitterScratch.tokens = tokens;
}

function signalMeaningForIntent(kind: number): number {
  switch (kind) {
    case AgentIntent.SignalDanger:
      return SignalMeaning.Danger;
    case AgentIntent.SignalFood:
      return SignalMeaning.Food;
    case AgentIntent.SignalWater:
      return SignalMeaning.Water;
    case AgentIntent.SignalFollow:
      return SignalMeaning.Follow;
    default:
      return -1;
  }
}

/**
 * The token an agent uses for a meaning: the one it already knows, or a newly
 * invented one. Invention draws from the `culture` RNG stream and prefers a
 * token that is either unused or already means the same thing — so an agent
 * never garbles a signal it understands — with a bounded number of attempts
 * before falling back to its weakest association (deterministic).
 */
function chooseEmissionToken(ctx: TickContext, entity: EntityId, meaning: number): number {
  const signals = ctx.ecs.signals;
  const knownThreshold = ctx.config.culture.signals.knownThreshold;
  const known = signals.bestTokenFor(entity, meaning);
  if (known.token >= 0 && known.strength >= knownThreshold) return known.token;

  const attempts = 4;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const token = ctx.cultureRng.nextInt(SIGNAL_TOKEN_COUNT);
    const dominant = signals.dominantMeaning(entity, token);
    if (dominant.meaning < 0 || dominant.meaning === meaning) return token;
  }

  // Every sampled token already means something else: reuse the one the agent
  // associates least with a competing meaning (deterministic scan, and a
  // deliberate "best available word" compromise).
  let fallback = 0;
  let fallbackStrength = Number.POSITIVE_INFINITY;
  for (let token = 0; token < SIGNAL_TOKEN_COUNT; token++) {
    const dominant = signals.dominantMeaning(entity, token);
    const strength = dominant.meaning === meaning ? -1 : dominant.strength;
    if (strength < fallbackStrength) {
      fallbackStrength = strength;
      fallback = token;
    }
  }
  return fallback;
}

// --- 3. Listening ------------------------------------------------------------

function listenToSignals(ctx: TickContext, batch: EmissionBatch): void {
  if (batch.count === 0) return;
  const { ecs, config } = ctx;
  const signalConfig = config.culture.signals;
  const socialIndex = ctx.socialIndex;
  const position = ecs.position;

  const hearingSq = signalConfig.hearingRadiusTiles * signalConfig.hearingRadiusTiles;
  attentionStamp++;

  for (let e = 0; e < batch.count; e++) {
    const emitter = emitterScratch.entities[e];
    const token = emitterScratch.tokens[e];
    const emitterPositionSlot = position.index[emitter];
    if (emitterPositionSlot < 0) continue;
    const emitterX = position.columns.x[emitterPositionSlot];
    const emitterY = position.columns.y[emitterPositionSlot];

    // What an observer can SEE about the emitter's situation grounds the
    // signal. An emitter whose situation is unreadable teaches nothing (the
    // observation is simply not informative).
    const context = signalContextMeaning(ctx, emitter, emitterX, emitterY);
    if (context < 0) continue;

    const col = socialIndex.cellCol(emitterX);
    const row = socialIndex.cellRow(emitterY);
    const minCol = col > 0 ? col - 1 : 0;
    const maxCol = col < socialIndex.cols - 1 ? col + 1 : socialIndex.cols - 1;
    const minRow = row > 0 ? row - 1 : 0;
    const maxRow = row < socialIndex.rows - 1 ? row + 1 : socialIndex.rows - 1;

    let heardBy = 0;
    let scanned = 0;
    outer: for (let r = minRow; r <= maxRow; r++) {
      for (let c = minCol; c <= maxCol; c++) {
        for (
          let listener = socialIndex.headOf(socialIndex.cellIndex(c, r));
          listener !== -1;
          listener = socialIndex.nextOf(listener)
        ) {
          if (listener === emitter) continue;
          if (scanned >= signalConfig.maxListenersPerEmission) break outer;
          scanned++;
          const listenerPositionSlot = position.index[listener];
          if (listenerPositionSlot < 0) continue;
          const dx = position.columns.x[listenerPositionSlot] - emitterX;
          const dy = position.columns.y[listenerPositionSlot] - emitterY;
          if (dx * dx + dy * dy > hearingSq) continue;
          heardBy++;

          // Attention budget: an agent can only take in so much per tick.
          ensureAttentionCapacity(listener);
          if (attentionScratch.stamps[listener] !== attentionStamp) {
            attentionScratch.stamps[listener] = attentionStamp;
            attentionScratch.counts[listener] = 0;
          }
          if (attentionScratch.counts[listener] >= signalConfig.maxObservationsPerTick) continue;
          attentionScratch.counts[listener]++;

          learnAssociation(ctx, listener, emitter, token, context);
        }
      }
    }

    if (heardBy > 0) {
      // Only signals that reached someone are reported: those are the ones that
      // were actually communication rather than an empty gesture, which keeps
      // the event feed meaningful and its volume bounded by the cooldown.
      ctx.cultureStats.signalsHeard++;
      ctx.events.record('signal_emitted', {
        entityId: emitter,
        detail: `${signalTokenName(token)} (= ${signalMeaningName(context)}) heard by ${heardBy}`,
      });
    }
  }
}

/**
 * Update one listener's association after hearing `token` in `context`.
 * The decode step (what the listener already believes the token means) happens
 * BEFORE the update, so responding to a danger signal requires having learned
 * it first — learning is what makes communication meaningful.
 */
function learnAssociation(
  ctx: TickContext,
  listener: EntityId,
  emitter: EntityId,
  token: number,
  context: number,
): void {
  const { ecs, config, tick } = ctx;
  const signals = ecs.signals;
  const signalConfig = config.culture.signals;
  const culture = ecs.culture;

  // Occasional deterministic misperception: a listener can attribute the signal
  // to a neighbouring token (bounded variation, never arbitrary generation).
  let heardToken = token;
  if (ctx.cultureRng.chance(signalConfig.misperceptionChance)) {
    const offset = ctx.cultureRng.nextInt(2) === 0 ? 1 : -1;
    heardToken = (token + offset + SIGNAL_TOKEN_COUNT) % SIGNAL_TOKEN_COUNT;
  }

  const decoded = signals.dominantMeaning(listener, heardToken);
  if (decoded.meaning === SignalMeaning.Danger && decoded.strength >= signalConfig.knownThreshold) {
    const cultureSlot = culture.index[listener];
    if (cultureSlot >= 0) {
      const current = culture.columns.alertTicks[cultureSlot];
      culture.columns.alertTicks[cultureSlot] = Math.max(current, signalConfig.alertTicks);
    }
  }

  const genomeSlot = ecs.genome.index[listener];
  const intelligence = genomeSlot >= 0 ? ecs.genome.columns.intelligence[genomeSlot] : 0;
  const rate = effectiveSignalLearningRate(intelligence, config);
  const strengthBefore = signals.strengthOf(listener, heardToken, context);
  const nextStrength = reinforceValue(strengthBefore, rate);
  const { previousStrength } = signals.observe(listener, heardToken, context, nextStrength, tick);

  // Competing meanings of the same token fade: a token converges on the meaning
  // its listeners most consistently observe, which is exactly how a convention
  // becomes stable without anyone deciding it.
  for (let e = signals.headOf(listener); e !== -1; e = signals.nextOf(e)) {
    if (signals.entryToken(e) !== heardToken || signals.entryMeaning(e) === context) continue;
    signals.setStrength(e, competingMeaningDecay(signals.entryStrength(e), signalConfig.competitionDecay));
  }

  if (previousStrength < signalConfig.knownThreshold && nextStrength >= signalConfig.knownThreshold) {
    ctx.cultureStats.signalLearnings++;
    ctx.events.record('signal_learned', {
      entityId: listener,
      detail: `${signalTokenName(heardToken)} means ${signalMeaningName(context)} (from #${emitter})`,
    });
  }
}

/**
 * The meaning an observer can ground for a signal, read from the emitter's
 * observable situation. Order is salience: a threatened agent reads as danger
 * even if it is also standing on food.
 */
function signalContextMeaning(ctx: TickContext, emitter: EntityId, emitterX: number, emitterY: number): number {
  const { ecs, config, tick } = ctx;
  const signalConfig = config.culture.signals;

  const intentStore = ecs.intent;
  const intentSlot = intentStore.index[emitter];
  const kind = intentSlot >= 0 ? intentStore.columns.kind[intentSlot] : -1;
  if (kind === AgentIntent.Avoid) return SignalMeaning.Danger;

  const cultureStore = ecs.culture;
  const cultureSlot = cultureStore.index[emitter];
  if (cultureSlot >= 0 && cultureStore.columns.alertTicks[cultureSlot] > 0) return SignalMeaning.Danger;
  const socialSlot = ecs.social.index[emitter];
  if (socialSlot >= 0) {
    const lastConflict = ecs.social.columns.lastConflictTick[socialSlot];
    if (lastConflict > 0 && tick - lastConflict < signalConfig.dangerContextTicks) return SignalMeaning.Danger;
  }
  // A hostile agent close by is danger the observer can see for itself.
  if (hasNearbyHostileThreat(ctx, emitter, emitterX, emitterY)) return SignalMeaning.Danger;

  const tileX = Math.floor(emitterX);
  const tileY = Math.floor(emitterY);
  if (tileX >= 0 && tileY >= 0 && tileX < ctx.world.width && tileY < ctx.world.height) {
    const tileIndex = ctx.world.tileIndex(tileX, tileY);
    if (ctx.world.food[tileIndex] >= config.resources.minFoodToEat) return SignalMeaning.Food;
    if (ctx.world.water[tileIndex] >= config.resources.minWaterToDrink) return SignalMeaning.Water;
  }

  const healthSlot = ecs.health.index[emitter];
  const needsSlot = ecs.needs.index[emitter];
  const healthLow = healthSlot >= 0 && ecs.health.columns.current[healthSlot] < config.social.help.healthNeedBelow;
  const energyLow = needsSlot >= 0 && ecs.needs.columns.energy[needsSlot] < config.social.help.energyNeedBelow;
  if (healthLow || energyLow) return SignalMeaning.Help;

  if (
    kind === AgentIntent.SignalFollow ||
    kind === AgentIntent.SeekFood ||
    kind === AgentIntent.SeekWater ||
    kind === AgentIntent.Cooperate
  ) {
    return SignalMeaning.Follow;
  }
  return -1;
}

/**
 * Whether the emitter has a genuinely hostile agent close by — read from the
 * emitter's own (bounded) relationship chain. This is the observer-visible
 * component of "there is danger here", and it is evaluated once per emission
 * (emissions are rare by construction).
 */
function hasNearbyHostileThreat(ctx: TickContext, emitter: EntityId, x: number, y: number): boolean {
  const { ecs, config } = ctx;
  const relationships = ecs.relationships;
  const position = ecs.position;
  const hostility = -config.social.conflict.minHostility;
  const hearingSq = config.culture.signals.hearingRadiusTiles * config.culture.signals.hearingRadiusTiles;
  for (let e = relationships.headOf(emitter); e !== -1; e = relationships.nextOf(e)) {
    if (relationships.scoreOf(e) > hostility) continue;
    const target = relationships.targetOf(e);
    if (!ecs.entities.isAlive(target)) continue;
    if (kinshipBetween(emitter, target, ecs) !== KinshipType.None) continue; // kin are not threats
    const slot = position.index[target];
    if (slot < 0) continue;
    const dx = position.columns.x[slot] - x;
    const dy = position.columns.y[slot] - y;
    if (dx * dx + dy * dy <= hearingSq) return true;
  }
  return false;
}
