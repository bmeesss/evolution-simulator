/**
 * Culture layer (Phase 5): cultural knowledge ("memes"), proto-communication
 * (signal tokens with learned meanings), transmission, drift and cultural
 * statistics.
 *
 * Design principles (see ARCHITECTURE.md §Culture and communication):
 *   - culture is NOT genetics: nothing here is inherited through reproduction;
 *     items move only through actual interaction events;
 *   - cultural memory is bounded per agent (capacity + decay + eviction);
 *   - signal meanings are learned associations, never authored data — the
 *     vocabulary in `signals.ts` is scaffolding, not a dictionary;
 *   - group culture is derived from member knowledge on demand (never stored),
 *     and cultural similarity is a reporting metric, never a behaviour input.
 */

export {
  KnowledgeType,
  KnowledgeOrigin,
  KNOWLEDGE_TYPE_COUNT,
  NormId,
  NORM_COUNT,
  TECHNIQUE_VARIANT_COUNT,
  describeKnowledge,
  knowledgeKey,
  knowledgeLabel,
  knowledgeOriginName,
  knowledgeTypeName,
  normName,
  sameKnowledge,
  techniqueHabitatFactor,
  techniqueTerrainFactor,
  techniqueVariantForTerrain,
  techniqueVariantName,
} from './knowledge';
export {
  SignalMeaning,
  SIGNAL_MEANING_COUNT,
  SIGNAL_MEANING_UNKNOWN,
  SIGNAL_TOKEN_COUNT,
  NO_SIGNAL_TOKEN,
  describeAssociation,
  signalMeaningName,
  signalTokenName,
} from './signals';
export { CulturalMemoryStore } from './cultural-memory-store';
export type { CulturalKnowledgeData, SerializedCulturalMemoryStore } from './cultural-memory-store';
export { SignalStore, isValidMeaning, isValidToken } from './signal-store';
export type { SignalAssociationData, SerializedSignalStore } from './signal-store';
export {
  competingMeaningDecay,
  decayValue,
  effectiveCulturalDecayPerHour,
  effectiveCulturalLearningRate,
  effectiveSignalDecayPerHour,
  effectiveSignalLearningRate,
  punishValue,
  reinforceValue,
  transmissionChance,
  transmissionIsFaithful,
} from './learning';
export type { TransmissionFactors } from './learning';
export {
  createCultureStats,
  lossesPer100Ticks,
  restoreCultureStats,
  serializeCultureStats,
  transmissionsPer100Ticks,
} from './culture-stats';
export type { CultureStats, SerializedCultureStats } from './culture-stats';
export { collectCulturalEffects, createCulturalEffects, normStrength, techniqueOf } from './effects';
export type { CulturalEffects } from './effects';
export {
  averagePairwiseSimilarity,
  culturalSimilarity,
  summarizeCulture,
} from './group-culture';
export type { CulturalSummary, KnowledgeShare, SignalConvention } from './group-culture';
