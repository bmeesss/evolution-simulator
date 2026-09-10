export { AgentIntent, INTENT_COUNT, intentName, isMovementIntent } from './intents';
export type { AgentIntent as AgentIntentKind } from './intents';
export { ActionKind, ACTION_COUNT, ACTION_NAMES } from './actions';
export { MemoryStore, ResourceType } from './memory';
export type { MemoryEntryData, SerializedMemoryStore } from './memory';
export {
  effectiveLearningRate,
  effectiveDecayPerHour,
  reinforceValue,
  punishValue,
  decayValue,
} from './memory';
export { ResourceIndex, AgentIndex } from './perception';
export type { ResourceCandidate } from './perception';
export { clamp01, linear, inverseLinear, quadratic, inverseQuadratic, sigmoid, bell } from './utility';
export {
  hungerUrgency,
  thirstUrgency,
  fatigueUrgency,
  resourceQuality,
  distanceFactor,
  distanceFactorSquared,
  explorationUncertainty,
  reproductionUrgency,
  partnerDesirability,
  lonelinessUrgency,
  socialDrive,
  relationshipAffinity,
  helpNeedFactor,
  threatFactor,
  vulnerabilityFactor,
  confrontationAdvantage,
} from './considerations';
export { selectIntents } from './utility-ai';
export { findSocialTargets, socialTargets } from './social-targeting';
export type { SocialTargets } from './social-targeting';
