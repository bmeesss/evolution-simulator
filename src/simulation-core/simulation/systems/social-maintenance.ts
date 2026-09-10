/**
 * Social maintenance (Phase 4) — the slow dynamics of the social layer:
 *
 *   - loneliness rises over time (scaled by social tendency: social agents
 *     get lonely faster) and drives future Socialize decisions,
 *   - cooperative-foraging bonus ticks count down,
 *   - familiarity decays without contact, and hostility slowly heals (old
 *     grudges fade instead of being permanently locked),
 *   - weak, stale or dead-end relationships are pruned, keeping the social
 *     graph strictly bounded (agents × capacity — never agents²).
 *
 * Runs after the death system so relationships of agents that died earlier in
 * this tick are already gone from the stores; relationships *pointing at*
 * dead agents are pruned here.
 *
 * Determinism: allocation-order iteration, chain-order pruning, no randomness.
 */

import type { TickContext } from '../tick-context';

export function updateSocialState(ctx: TickContext): void {
  const { ecs, config, dtHours, tick } = ctx;
  const social = config.social;
  const socialStore = ecs.social;
  const genome = ecs.genome;
  const relationships = ecs.relationships;
  const entities = ecs.entities;

  // --- Loneliness + forage-bonus countdown ---------------------------------
  const lonelinessPerHour = social.loneliness.perHour;
  for (let i = 0; i < socialStore.count; i++) {
    const loneliness = socialStore.columns.loneliness[i];
    if (loneliness < 100) {
      const entity = socialStore.entityOf[i];
      const genomeSlot = genome.index[entity];
      const socialTendency = genomeSlot >= 0 ? genome.columns.socialTendency[genomeSlot] : 0.5;
      // Social personalities become lonely faster; everyone does a little.
      const rise = lonelinessPerHour * dtHours * (0.5 + socialTendency);
      socialStore.columns.loneliness[i] = Math.min(100, loneliness + rise);
    }
    if (socialStore.columns.forageBonusTicks[i] > 0) {
      socialStore.columns.forageBonusTicks[i]--;
    }
  }

  // --- Familiarity decay + hostility healing + pruning ----------------------
  const decay = social.memory.familiarityDecayPerHour * dtHours;
  const hostilityDecay = social.memory.hostilityDecayPerHour * dtHours;
  const pruneFamiliarity = social.memory.pruneFamiliarity;
  const pruneScore = social.memory.pruneScore;
  const pruneAgeTicks = social.memory.pruneAgeTicks;

  for (let k = 0; k < entities.aliveCount; k++) {
    const entity = entities.aliveIds[k];
    let entry = relationships.headOf(entity);
    while (entry !== -1) {
      const next = relationships.nextOf(entry);
      const target = relationships.targetOf(entry);

      let drop = false;
      if (target < 0 || !entities.isAlive(target)) {
        drop = true; // the other agent is gone — stop remembering them
      } else {
        const familiarity = relationships.familiarityOf(entry);
        if (familiarity > 0) {
          relationships.setFamiliarity(entry, familiarity - decay);
        }
        let score = relationships.scoreOf(entry);
        if (score < 0) {
          // Time heals grudges: hostility fades without renewed conflict
          // (conflict damage far outpaces this decay, so active feuds hold).
          // Healing never overshoots into goodwill.
          score = score + hostilityDecay;
          relationships.setScore(entry, score > 0 ? 0 : score);
        }
        const magnitude = score < 0 ? -score : score;
        const stale = tick - relationships.lastInteractionTickOf(entry) >= pruneAgeTicks;
        if (
          relationships.familiarityOf(entry) <= pruneFamiliarity &&
          magnitude <= pruneScore &&
          stale
        ) {
          drop = true;
        }
      }
      if (drop) relationships.removeEntry(entity, entry);
      entry = next;
    }
  }
}
