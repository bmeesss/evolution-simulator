/**
 * Social targeting (Phase 4) — finding the best nearby agent for each social
 * action, in ONE bounded walk over the spatial index.
 *
 * The Utility AI needs, per agent and per tick: the most attractive agent to
 * socialize with, the most worthy agent to help, the best partner to
 * cooperate with, the most threatening agent to avoid and the most
 * confrontable rival. Two bounded passes cover all five:
 *
 *   1. A MEMORY pass over the agent's own relationship chain (<= capacity,
 *      typically 16): Confront and Avoid candidates are by definition
 *      remembered agents (the hostility gate requires a relationship), so
 *      they are evaluated directly from memory — never dependent on the
 *      spatial scan's candidate cap, i.e. reachable at any crowd density.
 *
 *   2. A SPATIAL pass that walks the 3×3 index cells around the agent ONCE
 *      (capped at `config.social.perception.maxScan` candidates — the same
 *      anti-quadratic guard the partner search uses) and scores every
 *      candidate for Socialize / Help / Cooperate with cheap arithmetic.
 *      These three actions can target strangers, so they need discovery.
 *
 * Results are written into a reused module-level scratch object (consumed
 * immediately by the caller — never retained). This mirrors the established
 * `partnerScratch` pattern: no per-tick allocation.
 *
 * Determinism: candidate order follows the AgentIndex chains (allocation
 * order, reversed within a cell) and strict `>` comparisons keep the earliest
 * best candidate on ties. No randomness — tie-break noise is applied by the
 * utility AI's action-level jitter.
 */

import type { EntityId, SimulationEcs } from '../ecs';
import type { SimulationConfig } from '../simulation';
import type { AgentIndex } from './perception';
import { clamp01 } from './utility';
import {
  distanceFactorSquared,
  relationshipAffinity,
  helpNeedFactor,
  threatFactor,
  vulnerabilityFactor,
  confrontationAdvantage,
} from './considerations';
import { KinshipType, kinshipBetween } from '../social/kinship';

/** Query result scratch — read immediately after findSocialTargets(). */
export interface SocialTargets {
  socializeId: EntityId;
  socializeX: number;
  socializeY: number;
  socializeScore: number;
  helpId: EntityId;
  helpX: number;
  helpY: number;
  helpScore: number;
  cooperateId: EntityId;
  cooperateX: number;
  cooperateY: number;
  cooperateScore: number;
  confrontId: EntityId;
  confrontX: number;
  confrontY: number;
  confrontScore: number;
  threatId: EntityId;
  threatX: number;
  threatY: number;
  threatScore: number;
  /** Vulnerability-weighted avoid utility (threat × vulnerability). */
  avoidScore: number;
}

export const socialTargets: SocialTargets = {
  socializeId: -1,
  socializeX: 0,
  socializeY: 0,
  socializeScore: 0,
  helpId: -1,
  helpX: 0,
  helpY: 0,
  helpScore: 0,
  cooperateId: -1,
  cooperateX: 0,
  cooperateY: 0,
  cooperateScore: 0,
  confrontId: -1,
  confrontX: 0,
  confrontY: 0,
  confrontScore: 0,
  threatId: -1,
  threatX: 0,
  threatY: 0,
  threatScore: 0,
  avoidScore: 0,
};

/**
 * Per-agent scratch mapping entity id -> that agent's relationship entry as
 * seen from the CURRENT agent. The stamp array avoids clearing between
 * agents; the buffer only lives for the duration of one findSocialTargets
 * call (same reentrancy guarantees as partnerScratch — the utility AI is
 * synchronous). Growth is amortized doubling, like every other buffer.
 */
const scratchState: { entryOf: Int32Array; stampOf: Uint32Array } = {
  entryOf: new Int32Array(1024),
  stampOf: new Uint32Array(1024),
};
let relStamp = 0;

/** Ensure the scratch arrays are addressable for `entity`. */
function ensureScratch(entity: EntityId): void {
  if (entity < scratchState.entryOf.length) return;
  let capacity = scratchState.entryOf.length;
  while (capacity <= entity) capacity *= 2;
  const entryOf = new Int32Array(capacity);
  entryOf.set(scratchState.entryOf);
  const stampOf = new Uint32Array(capacity);
  stampOf.set(scratchState.stampOf);
  scratchState.entryOf = entryOf;
  scratchState.stampOf = stampOf;
}

/**
 * Find the best candidates for all five social actions around one agent.
 * Writes into `socialTargets` (reused scratch — consume immediately).
 */
export function findSocialTargets(
  selfEntity: EntityId,
  selfX: number,
  selfY: number,
  selfHungerUrgency: number,
  selfStrength: number,
  selfSocialTendency: number,
  selfIsAdult: boolean,
  ecs: SimulationEcs,
  config: SimulationConfig,
  socialIndex: AgentIndex,
  tick: number,
): void {
  const social = config.social;
  const perceptionSq = social.perception.radiusTiles * social.perception.radiusTiles;
  const relationships = ecs.relationships;
  const position = ecs.position;
  const health = ecs.health;
  const needs = ecs.needs;
  const genome = ecs.genome;
  const entities = ecs.entities;

  let bestSocialize = 0;
  let socializeId = -1;
  let socializeX = 0;
  let socializeY = 0;
  let bestHelp = 0;
  let helpId = -1;
  let helpX = 0;
  let helpY = 0;
  let bestCooperate = 0;
  let cooperateId = -1;
  let cooperateX = 0;
  let cooperateY = 0;
  let bestConfront = 0;
  let confrontId = -1;
  let confrontX = 0;
  let confrontY = 0;
  let bestThreat = 0;
  let threatId = -1;
  let threatX = 0;
  let threatY = 0;
  let bestAvoid = 0;

  // Index the agent's own relationships for O(1) candidate lookups, and —
  // in the same bounded (<= capacity) walk — evaluate the MEMORY-driven
  // candidates: Confront and Avoid only ever apply to remembered agents (the
  // hostility gate requires a relationship), so they must not depend on the
  // spatial scan's candidate cap. Walking the chain directly keeps them
  // reachable at any crowd density and costs O(relationships), not O(scan).
  relStamp++;
  for (let e = relationships.headOf(selfEntity); e !== -1; e = relationships.nextOf(e)) {
    const target = relationships.targetOf(e);
    ensureScratch(target);
    scratchState.entryOf[target] = e;
    scratchState.stampOf[target] = relStamp;

    if (target < 0 || !entities.isAlive(target)) continue;
    const targetSlot = position.index[target];
    if (targetSlot < 0) continue; // defensive: no position, no interaction
    const cx = position.columns.x[targetSlot];
    const cy = position.columns.y[targetSlot];
    const dx = cx - selfX;
    const dy = cy - selfY;
    const distSq = dx * dx + dy * dy;
    if (distSq > perceptionSq) continue; // out of social sight
    const score = relationships.scoreOf(e);
    const kin =
      relationships.kinOf(e) || kinshipBetween(selfEntity, target, ecs) !== KinshipType.None;

    // --- Confront (memory-driven): a remembered rival within sight --------
    if (selfIsAdult && score <= -social.conflict.minHostility) {
      const candidateStrength =
        genome.index[target] >= 0 ? genome.columns.strength[genome.index[target]] : 0;
      const proximity = distanceFactorSquared(distSq, perceptionSq);
      const competition = selfHungerUrgency * proximity;
      const hostility = clamp01(-score);
      const advantage = confrontationAdvantage(selfStrength, candidateStrength);
      // Personality: low social tendency raises aggression — but only as a
      // moderate modifier (0.75…1.0), never a pacifism/aggression cheat in
      // either direction.
      const aggression = 0.75 + 0.25 * (1 - clamp01(selfSocialTendency));
      const kinFactor = kin ? 1 - social.kinship.confrontDampening : 1;
      // Confront utility = gain × competition × grudge × edge × personality
      // × kin-dampening, where competition = hunger urgency × proximity
      // (linear: a full stomach defuses, distance dilutes the stake) and
      // grudge = sqrt(hostility) (deep grudges are what make fighting
      // thinkable). Confrontation needs an actual stake AND sufficiently
      // strong hostility — the minHostility gate plus the linear competition
      // factor keep mild resentment and well-fed agents peaceful.
      const confrontCandidate = Math.min(
        1,
        2.4 * competition * Math.sqrt(hostility) * advantage * aggression * kinFactor,
      );
      if (confrontCandidate > bestConfront) {
        bestConfront = confrontCandidate;
        confrontId = target;
        confrontX = cx;
        confrontY = cy;
      }
    }

    // --- Threat / Avoid (memory-driven): the most feared rival in sight ---
    if (score < 0) {
      const trust = relationships.trustOf(e);
      const threat = threatFactor(distSq, perceptionSq, score, trust);
      // Vulnerability folds the threat's strength in: weaker agents avoid more.
      const avoid = threat * vulnerabilityFactor(selfStrength, strengthOf(ecs, target));
      if (avoid > bestAvoid) {
        bestAvoid = avoid;
        bestThreat = threat;
        threatId = target;
        threatX = cx;
        threatY = cy;
      }
    }
  }

  const maxScan = social.perception.maxScan;
  const col = socialIndex.cellCol(selfX);
  const row = socialIndex.cellRow(selfY);
  const minCol = col > 0 ? col - 1 : 0;
  const maxCol = col < socialIndex.cols - 1 ? col + 1 : socialIndex.cols - 1;
  const minRow = row > 0 ? row - 1 : 0;
  const maxRow = row < socialIndex.rows - 1 ? row + 1 : socialIndex.rows - 1;

  let scanned = 0;
  outer: for (let r = minRow; r <= maxRow; r++) {
    for (let c = minCol; c <= maxCol; c++) {
      for (let candidate = socialIndex.headOf(socialIndex.cellIndex(c, r)); candidate !== -1; candidate = socialIndex.nextOf(candidate)) {
        if (candidate === selfEntity) continue;
        if (scanned >= maxScan) break outer;
        scanned++;
        const candidateSlot = position.index[candidate];
        if (candidateSlot < 0) continue; // defensive: no position, no social perception
        const cx = position.columns.x[candidateSlot];
        const cy = position.columns.y[candidateSlot];
        const dx = cx - selfX;
        const dy = cy - selfY;
        const distSq = dx * dx + dy * dy;
        if (distSq > perceptionSq) continue; // out of social sight

        const entry =
          candidate < scratchState.entryOf.length && scratchState.stampOf[candidate] === relStamp
            ? scratchState.entryOf[candidate]
            : -1;
        const hasRelationship = entry !== -1;
        const score = hasRelationship ? relationships.scoreOf(entry) : 0;
        const trust = hasRelationship ? relationships.trustOf(entry) : 0;
        const familiarity = hasRelationship ? relationships.familiarityOf(entry) : 0;
        const kin =
          hasRelationship && relationships.kinOf(entry)
            ? true
            : kinshipBetween(selfEntity, candidate, ecs) !== KinshipType.None;

        const proximity = distanceFactorSquared(distSq, perceptionSq);

        // --- Socialize: bonds beat strangers, familiar beats unknown -------
        let affinity: number;
        if (hasRelationship) {
          affinity = relationshipAffinity(score) * (0.4 + 0.6 * clamp01(familiarity));
          if (kin) affinity *= 1 + social.kinship.socializeBias;
          affinity = clamp01(affinity);
        } else {
          affinity = social.socialize.strangerOpenness;
        }
        const socializeCandidate = proximity * affinity;
        if (socializeCandidate > bestSocialize) {
          bestSocialize = socializeCandidate;
          socializeId = candidate;
          socializeX = cx;
          socializeY = cy;
        }

        // --- Help: only known agents that are genuinely in need ------------
        if (hasRelationship) {
          const candidateHealthSlot = health.index[candidate];
          const candidateNeedsSlot = needs.index[candidate];
          if (candidateHealthSlot >= 0 && candidateNeedsSlot >= 0) {
            const need = helpNeedFactor(
              health.columns.current[candidateHealthSlot],
              needs.columns.energy[candidateNeedsSlot],
              config,
            );
            if (need > 0) {
              let relationshipValue = clamp01(0.2 + 0.8 * relationshipAffinity(score));
              if (kin) relationshipValue *= 1 + social.kinship.helpBias;
              // Expected future benefit: trusted partners reciprocate (their
              // past reliability predicts returned help).
              const trustFactor = 0.5 + 0.5 * clamp01(trust);
              const helpCandidate = proximity * clamp01(relationshipValue) * need * trustFactor;
              if (helpCandidate > bestHelp) {
                bestHelp = helpCandidate;
                helpId = candidate;
                helpX = cx;
                helpY = cy;
              }
            }
          }
        }

        // --- Cooperate: forage together — needs some standing ---------------
        if (hasRelationship) {
          const cooldownOk = relationships.pairCooldownUntilOf(entry) <= tick;
          if (cooldownOk) {
            const quality = relationshipAffinity(score) * (0.5 + 0.5 * clamp01(familiarity));
            const cooperateCandidate = proximity * clamp01(quality);
            if (cooperateCandidate > bestCooperate) {
              bestCooperate = cooperateCandidate;
              cooperateId = candidate;
              cooperateX = cx;
              cooperateY = cy;
            }
          }
        }

      }
    }
  }

  socialTargets.socializeId = socializeId;
  socialTargets.socializeX = socializeX;
  socialTargets.socializeY = socializeY;
  socialTargets.socializeScore = bestSocialize;
  socialTargets.helpId = helpId;
  socialTargets.helpX = helpX;
  socialTargets.helpY = helpY;
  socialTargets.helpScore = bestHelp;
  socialTargets.cooperateId = cooperateId;
  socialTargets.cooperateX = cooperateX;
  socialTargets.cooperateY = cooperateY;
  socialTargets.cooperateScore = bestCooperate;
  socialTargets.confrontId = confrontId;
  socialTargets.confrontX = confrontX;
  socialTargets.confrontY = confrontY;
  socialTargets.confrontScore = bestConfront;
  socialTargets.threatId = threatId;
  socialTargets.threatX = threatX;
  socialTargets.threatY = threatY;
  socialTargets.threatScore = bestThreat;
  socialTargets.avoidScore = bestAvoid;
}

/** Strength genome of an entity (0 when absent) — used for avoid/confront. */
function strengthOf(ecs: SimulationEcs, entity: EntityId): number {
  const slot = ecs.genome.index[entity];
  return slot >= 0 ? ecs.genome.columns.strength[slot] : 0;
}
