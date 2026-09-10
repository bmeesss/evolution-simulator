/**
 * Cultural knowledge ("memes") — the vocabulary of Phase 5.
 *
 * A cultural item is a small, transferable piece of information. Its identity
 * is the triple `(type, location, variant)` — "the food patch at 12,30" and
 * "the technique variant 2" are different items — so two agents can be compared
 * for *shared knowledge* without any registry, global id counter or
 * centralised culture table. Items therefore appear independently in different
 * places and converge only through transmission, which is the entire point of
 * the phase.
 *
 * The four knowledge types are deliberately mundane and non-technological:
 *
 *   - FoodLocation      a believed food patch (tile + confidence)
 *   - WaterLocation     a believed water patch (tile + confidence)
 *   - ForagingTechnique a variant id, preferred habitat and efficiency bonus
 *   - SocialNorm        one of three simple interaction rules
 *
 * There is no technology tree, no agriculture, no economy, no warfare and no
 * civilisation here — only knowledge an agent can carry, use, wear out and pass
 * on. Types, origin kinds, norm ids and technique variants are all FIXED small
 * enums: nothing in the culture layer generates ids, strings or content at
 * runtime, and every value is derived deterministically from simulation state.
 *
 * Values are stable and save-format relevant: never renumber an existing entry
 * without bumping SAVE_FORMAT_VERSION.
 */

/** Kinds of cultural knowledge an agent can hold. */
export const KnowledgeType = {
  /** A believed food location ("there is food at tile x,y"). */
  FoodLocation: 0,
  /** A believed water location. */
  WaterLocation: 1,
  /** A foraging technique variant (habitat-specialised efficiency). */
  ForagingTechnique: 2,
  /** A simple social norm (see NormId). */
  SocialNorm: 3,
} as const;

export type KnowledgeType = (typeof KnowledgeType)[keyof typeof KnowledgeType];

/** Number of knowledge types (array sizing). */
export const KNOWLEDGE_TYPE_COUNT = 4;

/**
 * How an agent came to hold a cultural item. This is what keeps personal
 * experience and social acquisition apart: `Discovered` means "I worked this
 * out / was there myself", `Taught` means "someone deliberately showed me" and
 * `Imitated` means "I watched someone do it".
 */
export const KnowledgeOrigin = {
  Discovered: 0,
  Taught: 1,
  Imitated: 2,
} as const;

export type KnowledgeOrigin = (typeof KnowledgeOrigin)[keyof typeof KnowledgeOrigin];

const ORIGIN_NAMES: readonly string[] = ['discovered', 'taught', 'imitated'];

export function knowledgeOriginName(origin: number): string {
  return ORIGIN_NAMES[origin] ?? 'unknown';
}

/**
 * The three simple social norms. They are ordinary cultural items
 * (KnowledgeType.SocialNorm) whose `variantId` is the norm id, so they spread,
 * decay and drift exactly like any other knowledge. Their only effect is to
 * nudge the already-existing Utility AI considerations — there is no morality
 * system, no religion and no authority anywhere in the simulation.
 */
export const NormId = {
  /** Help a needy neighbour when it is not too costly. */
  HelpOthers: 0,
  /** Share/cooperate with others instead of foraging alone. */
  ShareFood: 1,
  /** Restrain yourself when a confrontation urge arises. */
  AvoidConflict: 2,
} as const;

export type NormId = (typeof NormId)[keyof typeof NormId];

/** Number of norms (array sizing, bounds checks). */
export const NORM_COUNT = 3;

const NORM_NAMES: readonly string[] = ['HELP_OTHERS', 'SHARE_FOOD', 'AVOID_CONFLICT'];

export function normName(id: number): string {
  return NORM_NAMES[id] ?? 'UNKNOWN_NORM';
}

/**
 * Technique variants: a small fixed set of foraging styles, each suited to one
 * terrain type. Variants are NOT assigned by the simulation — an agent either
 * works one out by itself (biased toward the terrain it lives on) or picks one
 * up from someone else, with occasional drift during transmission. Two groups
 * living in different habitats therefore end up with different techniques
 * without any code saying so.
 */
const TECHNIQUE_PREFERRED_TERRAIN: readonly number[] = [
  3, // variant 0 — forest
  2, // variant 1 — grass
  1, // variant 2 — sand
  4, // variant 3 — mountain
];

const TECHNIQUE_VARIANT_NAMES: readonly string[] = [
  'forest foraging',
  'grass foraging',
  'sand foraging',
  'mountain foraging',
];

export const TECHNIQUE_VARIANT_COUNT = TECHNIQUE_PREFERRED_TERRAIN.length;

export function techniqueVariantName(variant: number): string {
  return TECHNIQUE_VARIANT_NAMES[variant] ?? 'unknown technique';
}

/** Terrain type a technique variant is suited to. */
export function techniquePreferredTerrain(variant: number): number {
  return TECHNIQUE_PREFERRED_TERRAIN[variant] ?? -1;
}

/**
 * How well a technique variant performs on a given terrain: `matched` when the
 * agent forages on the variant's home terrain, `foreign` (a small number,
 * possibly below 1, i.e. a penalty) otherwise. Both values come from config so
 * the effect is tunable and testable.
 */
export function techniqueTerrainFactor(variant: number, terrain: number, matched: number, foreign: number): number {
  return techniquePreferredTerrain(variant) === terrain ? matched : foreign;
}

/**
 * Terrain-appropriate technique variant, i.e. the variant whose preferred
 * terrain is `terrain`. Used when an agent works out a technique from its own
 * habitat: the invention is habitat-biased, which is what makes neighbouring
 * groups culturally specialised without any code assigning them a culture.
 * Falls back to variant 0 on unknown terrain (deterministic, never -1).
 */
export function techniqueVariantForTerrain(terrain: number): number {
  const index = TECHNIQUE_PREFERRED_TERRAIN.indexOf(terrain);
  return index === -1 ? 0 : index;
}

/** Alias of {@link techniqueTerrainFactor} kept for the public culture API. */
export function techniqueHabitatFactor(variant: number, terrain: number, matched: number, foreign: number): number {
  return techniqueTerrainFactor(variant, terrain, matched, foreign);
}

/** Human-readable knowledge type name (UI inspector / event details). */
export function knowledgeTypeName(type: number): string {
  switch (type) {
    case KnowledgeType.FoodLocation:
      return 'food location';
    case KnowledgeType.WaterLocation:
      return 'water location';
    case KnowledgeType.ForagingTechnique:
      return 'foraging technique';
    case KnowledgeType.SocialNorm:
      return 'norm';
    default:
      return 'unknown knowledge';
  }
}

/**
 * One-line description of an item, deterministic and derived only from its
 * numbers — the inspector and the event log show this instead of any generated
 * prose. Location items carry their tile, techniques/norms their variant name.
 */
export function describeKnowledge(type: number, tileX: number, tileY: number, variantId: number): string {
  switch (type) {
    case KnowledgeType.FoodLocation:
      return `food @ ${tileX},${tileY}`;
    case KnowledgeType.WaterLocation:
      return `water @ ${tileX},${tileY}`;
    case KnowledgeType.ForagingTechnique:
      return techniqueVariantName(variantId);
    case KnowledgeType.SocialNorm:
      return normName(variantId);
    default:
      return 'unknown knowledge';
  }
}

/**
 * Compact numeric key of an item, used by aggregation code (group statistics,
 * UI breakdowns) instead of string concatenation. Type/variant are small enums
 * and tile coordinates are negative-sentinel-safe (`+1` avoids -1 aliasing).
 * The key is only ever used for equality/aggregation inside a run — it is not
 * persisted.
 */
export function knowledgeKey(type: number, tileX: number, tileY: number, variantId: number): number {
  return type * 1e12 + variantId * 1e9 + (tileY + 1) * 1e6 + (tileX + 1);
}

/** Alias of {@link describeKnowledge}: the UI label of an item. */
export function knowledgeLabel(type: number, tileX: number, tileY: number, variantId: number): string {
  return describeKnowledge(type, tileX, tileY, variantId);
}

/** Whether two items are the same piece of knowledge. */
export function sameKnowledge(
  typeA: number,
  tileXA: number,
  tileYA: number,
  variantA: number,
  typeB: number,
  tileXB: number,
  tileYB: number,
  variantB: number,
): boolean {
  return (
    typeA === typeB && tileXA === tileXB && tileYA === tileYB && variantA === variantB
  );
}
