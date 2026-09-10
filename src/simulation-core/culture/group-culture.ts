/**
 * Group and population culture summaries — DERIVED data, never stored state.
 *
 * Nothing in this file feeds back into the simulation. It answers two
 * questions the player asks:
 *
 *   1. "What does this group know?" — dominant items, traditions (items most
 *      members hold), shared signal conventions, and a bounded diversity score.
 *      Everything is computed from the members' actual cultural memories, so a
 *      group can only have a tradition because its members were actually
 *      taught it.
 *   2. "How culturally similar are two groups?" — a bounded [0, 1] metric used
 *      for statistics and the inspector. It is NOT a friendship score and is
 *      never read by any system.
 *
 * Cost is bounded: O(entities × cultural capacity) per summary, with per-group
 * summaries computed for the groups the UI actually shows, and pairwise
 * similarity capped by configuration.
 */

import type { EntityId } from '../ecs';
import type { SimulationConfig } from '../simulation/config';
import type { CulturalMemoryStore } from './cultural-memory-store';
import type { SignalStore } from './signal-store';
import { KnowledgeType } from './knowledge';
import { SIGNAL_TOKEN_COUNT } from './signals';

/** One knowledge item's standing inside a set of agents. */
export interface KnowledgeShare {
  readonly key: number;
  readonly type: number;
  readonly tileX: number;
  readonly tileY: number;
  readonly variantId: number;
  /** Agents in the set holding this item. */
  readonly carriers: number;
  /** `carriers / agentCount` in [0, 1]. */
  readonly share: number;
  /** Mean strength among the carriers, in [0, 1]. */
  readonly averageStrength: number;
}

/** The meaning a set of agents most often reads into one token. */
export interface SignalConvention {
  readonly token: number;
  readonly meaning: number;
  /** Agents whose association with (token, meaning) is above the known threshold. */
  readonly carriers: number;
  readonly share: number;
  /** Mean association strength among those carriers, in [0, 1]. */
  readonly strength: number;
}

/** Derived cultural profile of a set of agents (a group, or the population). */
export interface CulturalSummary {
  readonly agentCount: number;
  /** Agents holding at least one cultural item. */
  readonly carriers: number;
  /** Total items held (counting carriers multiple times). */
  readonly entries: number;
  /** Distinct items held by at least one agent. */
  readonly knowledgeItems: number;
  readonly averageStrength: number;
  /** Normalized Shannon entropy of the item-carrier distribution, [0, 1]. */
  readonly diversity: number;
  /** Most widespread items (bounded list, carriers desc). */
  readonly items: readonly KnowledgeShare[];
  /** Items held by at least `traditionShare` of the agents (bounded list). */
  readonly traditions: readonly KnowledgeShare[];
  /** Every token with a learned convention in this set (<= SIGNAL_TOKEN_COUNT). */
  readonly signals: readonly SignalConvention[];
  /** Agents with at least one known signal meaning. */
  readonly signalCarriers: number;
  /** Agents holding at least one social norm. */
  readonly normCarriers: number;
}

interface ItemAggregate {
  type: number;
  tileX: number;
  tileY: number;
  variantId: number;
  carriers: number;
  strengthSum: number;
}

interface MeaningAggregate {
  carriers: number;
  strengthSum: number;
}

/** Key for the per-token meaning map (tokens < 16, meanings < 8). */
function tokenMeaningKey(token: number, meaning: number): number {
  return token * 8 + meaning;
}

/**
 * Summarize the culture of `entities` (members of a group, or every alive
 * agent). `agentCount` may exceed `entities.length` when a caller wants shares
 * relative to a larger set — it falls back to the list length.
 */
export function summarizeCulture(
  culturalMemory: CulturalMemoryStore,
  signals: SignalStore,
  entities: readonly EntityId[],
  agentCount: number,
  config: SimulationConfig,
): CulturalSummary {
  const cultureConfig = config.culture;
  const knownThreshold = cultureConfig.signals.knownThreshold;

  const items = new Map<number, ItemAggregate>();
  const meanings = new Map<number, MeaningAggregate>();
  let carriers = 0;
  let entries = 0;
  let strengthSum = 0;
  let signalCarriers = 0;
  let normCarriers = 0;

  for (const entity of entities) {
    let holdsAny = false;
    let holdsNorm = false;
    for (let e = culturalMemory.headOf(entity); e !== -1; e = culturalMemory.nextOf(e)) {
      holdsAny = true;
      entries++;
      strengthSum += culturalMemory.entryStrength(e);
      if (culturalMemory.entryType(e) === KnowledgeType.SocialNorm) holdsNorm = true;
      const key = culturalMemory.entryKey(e);
      let aggregate = items.get(key);
      if (aggregate === undefined) {
        aggregate = {
          type: culturalMemory.entryType(e),
          tileX: culturalMemory.entryTileX(e),
          tileY: culturalMemory.entryTileY(e),
          variantId: culturalMemory.entryVariant(e),
          carriers: 0,
          strengthSum: 0,
        };
        items.set(key, aggregate);
      }
      aggregate.carriers++;
      aggregate.strengthSum += culturalMemory.entryStrength(e);
    }
    if (holdsAny) carriers++;
    if (holdsNorm) normCarriers++;

    let holdsMeaning = false;
    for (let e = signals.headOf(entity); e !== -1; e = signals.nextOf(e)) {
      if (signals.entryStrength(e) < knownThreshold) continue;
      holdsMeaning = true;
      const key = tokenMeaningKey(signals.entryToken(e), signals.entryMeaning(e));
      let aggregate = meanings.get(key);
      if (aggregate === undefined) {
        aggregate = { carriers: 0, strengthSum: 0 };
        meanings.set(key, aggregate);
      }
      aggregate.carriers++;
      aggregate.strengthSum += signals.entryStrength(e);
    }
    if (holdsMeaning) signalCarriers++;
  }

  const count = agentCount > 0 ? agentCount : entities.length;

  // --- Knowledge items sorted by how many agents hold them -------------------
  const listed: KnowledgeShare[] = [];
  for (const [key, aggregate] of items) {
    listed.push({
      key,
      type: aggregate.type,
      tileX: aggregate.tileX,
      tileY: aggregate.tileY,
      variantId: aggregate.variantId,
      carriers: aggregate.carriers,
      share: count === 0 ? 0 : aggregate.carriers / count,
      averageStrength: aggregate.carriers === 0 ? 0 : aggregate.strengthSum / aggregate.carriers,
    });
  }
  // Deterministic order: carriers desc, then the numeric key (independent of
  // Map insertion order, which depends on the (deterministic) iteration order
  // but which a caller should not have to know about).
  listed.sort((a, b) => b.carriers - a.carriers || a.key - b.key);
  const itemsListed = listed.slice(0, cultureConfig.summary.maxItems);
  const traditions = listed
    .filter((item) => item.share >= cultureConfig.summary.traditionShare)
    .slice(0, cultureConfig.summary.maxTraditions);

  // --- Signal conventions: one dominant meaning per token -------------------
  const signalList: SignalConvention[] = [];
  for (let token = 0; token < SIGNAL_TOKEN_COUNT; token++) {
    let bestMeaning = -1;
    let bestCarriers = 0;
    let bestStrengthSum = 0;
    for (let meaning = 0; meaning < 8; meaning++) {
      const aggregate = meanings.get(tokenMeaningKey(token, meaning));
      if (aggregate === undefined) continue;
      // More carriers wins; ties keep the lower meaning index (deterministic).
      if (aggregate.carriers > bestCarriers) {
        bestCarriers = aggregate.carriers;
        bestMeaning = meaning;
        bestStrengthSum = aggregate.strengthSum;
      }
    }
    if (bestMeaning < 0) continue;
    signalList.push({
      token,
      meaning: bestMeaning,
      carriers: bestCarriers,
      share: count === 0 ? 0 : bestCarriers / count,
      strength: bestCarriers === 0 ? 0 : bestStrengthSum / bestCarriers,
    });
  }
  // Strongest convention first (share desc, then strength desc, then token).
  signalList.sort((a, b) => b.share - a.share || b.strength - a.strength || a.token - b.token);

  return {
    agentCount: count,
    carriers,
    entries,
    knowledgeItems: items.size,
    averageStrength: entries === 0 ? 0 : strengthSum / entries,
    diversity: normalizedEntropy(listed.map((item) => item.carriers)),
    items: itemsListed,
    traditions,
    signals: signalList,
    signalCarriers,
    normCarriers,
  };
}

/** Normalized Shannon entropy of a carrier-count distribution (0..1). */
function normalizedEntropy(counts: readonly number[]): number {
  let total = 0;
  for (const c of counts) total += c;
  if (total <= 0 || counts.length <= 1) return 0;
  let entropy = 0;
  for (const c of counts) {
    if (c <= 0) continue;
    const p = c / total;
    entropy -= p * Math.log(p);
  }
  const max = Math.log(counts.length);
  return max <= 0 ? 0 : entropy / max;
}

/** Look up a token's convention in a summary (-1 when the token is unused). */
function conventionMeaning(summary: CulturalSummary, token: number): number {
  for (const convention of summary.signals) {
    if (convention.token === token) return convention.meaning;
  }
  return -1;
}

function conventionShare(summary: CulturalSummary, token: number): number {
  for (const convention of summary.signals) {
    if (convention.token === token) return convention.share;
  }
  return 0;
}

/**
 * Cultural similarity of two sets of agents, in [0, 1].
 *
 *   knowledge term — cosine similarity of the item-share vectors over the
 *     groups' most widespread items. Two groups that hold the same items in
 *     similar proportions score ~1; disjoint item sets score 0.
 *   signal term — over the union of tokens the two groups use, the share
 *     weight of tokens whose dominant meaning AGREES (min of the two shares),
 *     divided by the total weight of tokens either group uses. Groups that use
 *     the same token for the same meaning score 1; groups that use different
 *     tokens (or the same token for different meanings) score 0.
 *
 * The terms are combined with configurable weights, BUT only terms that can
 * actually discriminate the two sets are counted: two groups that use no
 * signals at all are compared on knowledge alone (so a group with disjoint
 * knowledge scores 0 rather than inheriting a neutral signal score), and a set
 * with no culture whatsoever shares nothing with anyone (0).
 *
 * This is a reporting metric: no system reads it, and it is never a hidden
 * friendship or fitness score.
 */
export function culturalSimilarity(
  a: CulturalSummary,
  b: CulturalSummary,
  config: SimulationConfig,
): number {
  // A set that knows nothing (no items, no signals) shares nothing with anyone.
  if (isCulturallyEmpty(a) || isCulturallyEmpty(b)) return 0;
  const { knowledgeWeight, signalWeight } = config.culture.summary;
  let weighted = knowledgeWeight * itemCosineSimilarity(a, b);
  let weightSum = knowledgeWeight;
  // The signal term only exists when at least one side uses a signal at all:
  // otherwise there is nothing to agree or disagree about, and letting it vote
  // would hand both groups a free "neutral" score.
  if (a.signals.length > 0 || b.signals.length > 0) {
    weighted += signalWeight * signalAgreement(a, b);
    weightSum += signalWeight;
  }
  if (weightSum <= 0) return 0;
  return weighted / weightSum;
}

/** True when a summary holds neither knowledge items nor signal conventions. */
function isCulturallyEmpty(summary: CulturalSummary): boolean {
  return summary.knowledgeItems === 0 && summary.signals.length === 0;
}

function itemCosineSimilarity(a: CulturalSummary, b: CulturalSummary): number {
  if (a.items.length === 0 && b.items.length === 0) return 1;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const item of a.items) normA += item.share * item.share;
  for (const item of b.items) normB += item.share * item.share;
  for (const item of a.items) {
    for (const other of b.items) {
      if (other.key !== item.key) continue;
      dot += item.share * other.share;
      break;
    }
  }
  if (normA <= 0 || normB <= 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function signalAgreement(a: CulturalSummary, b: CulturalSummary): number {
  if (a.signals.length === 0 && b.signals.length === 0) return 1;
  let agreement = 0;
  let total = 0;
  for (let token = 0; token < SIGNAL_TOKEN_COUNT; token++) {
    const shareA = conventionShare(a, token);
    const shareB = conventionShare(b, token);
    const maxShare = shareA > shareB ? shareA : shareB;
    if (maxShare <= 0) continue;
    total += maxShare;
    const meaningA = conventionMeaning(a, token);
    const meaningB = conventionMeaning(b, token);
    if (meaningA >= 0 && meaningA === meaningB) {
      agreement += shareA < shareB ? shareA : shareB;
    }
  }
  return total <= 0 ? 0 : agreement / total;
}

/**
 * Mean pairwise cultural similarity across a set of summaries (the global
 * "group cultural similarity" statistic). Bounded: at most
 * `config.culture.summary.maxSimilarityGroups` summaries are compared, so the
 * cost never grows with the square of the group count.
 */
export function averagePairwiseSimilarity(
  summaries: readonly CulturalSummary[],
  config: SimulationConfig,
): number {
  const limit = Math.min(summaries.length, config.culture.summary.maxSimilarityGroups);
  if (limit < 2) return 1;
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < limit; i++) {
    for (let j = i + 1; j < limit; j++) {
      sum += culturalSimilarity(summaries[i], summaries[j], config);
      pairs++;
    }
  }
  return pairs === 0 ? 1 : sum / pairs;
}
